import { application } from '@application'
import { type AgentRow, agentTable as agentsTable, type InsertAgentRow } from '@data/db/schemas/agent'
import { agentChannelTable as channelsTable } from '@data/db/schemas/agentChannel'
import { agentSessionTable as sessionsTable } from '@data/db/schemas/agentSession'
import { agentSkillTable as agentSkillsTable } from '@data/db/schemas/agentSkill'
import { agentTaskTable as scheduledTasksTable } from '@data/db/schemas/agentTask'
import { entityTagTable, tagTable } from '@data/db/schemas/tagging'
import { userModelTable } from '@data/db/schemas/userModel'
import { defaultHandlersFor, withSqliteErrors } from '@data/db/sqliteErrors'
import type { DbOrTx, DbType } from '@data/db/types'
import { nullsToUndefined, timestampToISO } from '@data/services/utils/rowMappers'
import { loggerService } from '@logger'
import { CHERRY_CLAW_AGENT_ID, isBuiltinAgentId } from '@main/services/agents/services/builtin/BuiltinAgentIds'
import { DataApiErrorFactory } from '@shared/data/api'
import {
  AGENT_MUTABLE_FIELDS,
  type AgentEntity,
  type CreateAgentDto,
  type UpdateAgentDto
} from '@shared/data/api/schemas/agents'
import type { Tag } from '@shared/data/types/tag'
import type { AgentType, ListOptions } from '@types'
import { and, asc, count, desc, eq, inArray, isNull, or, type SQL, sql } from 'drizzle-orm'

import { tagService } from './TagService'

const logger = loggerService.withContext('AgentService')

function pickModelName(modelId: string | null | undefined, names: Map<string, string>): string | null {
  if (!modelId) return null
  return names.get(modelId) ?? null
}

function rowToAgent(row: AgentRow, tags: Tag[] = [], modelName: string | null = null): AgentEntity {
  const clean = nullsToUndefined(row)
  return {
    ...clean,
    type: (row.type === 'cherry-claw' ? 'claude-code' : row.type) as AgentType,
    accessiblePaths: row.accessiblePaths ?? [],
    createdAt: timestampToISO(row.createdAt),
    updatedAt: timestampToISO(row.updatedAt),
    tags,
    modelName
  }
}

/** Compute the default workspace paths for an agent without creating any directories. */
function computeWorkspacePaths(paths: string[] | undefined, id: string): string[] {
  if (paths && paths.length > 0) return paths
  const shortId = id.substring(id.length - 9)
  // getPath returns the workspace root; append the per-agent short-ID subdirectory.
  return [`${application.getPath('feature.agents.workspaces')}/${shortId}`]
}

export class AgentService {
  static readonly DEFAULT_AGENT_ID = CHERRY_CLAW_AGENT_ID

  /**
   * Batch-resolve the primary agent model's display name from `user_model`.
   * Missing ids are represented by absent map entries so callers can return
   * `null`, matching the assistant read contract.
   */
  private async getModelNamesByUniqueIds(
    uniqueIds: (string | null | undefined)[],
    tx: Pick<DbType, 'select'> = application.get('DbService').getDb()
  ): Promise<Map<string, string>> {
    const result = new Map<string, string>()
    const ids = Array.from(new Set(uniqueIds.filter((id): id is string => typeof id === 'string' && id.length > 0)))
    if (ids.length === 0) return result

    const rows = await tx
      .select({ id: userModelTable.id, name: userModelTable.name })
      .from(userModelTable)
      .where(inArray(userModelTable.id, ids))

    for (const row of rows) {
      if (row.name) result.set(row.id, row.name)
    }
    return result
  }

  /**
   * Batch-load tags for a set of agents via inline JOIN of `entity_tag` + `tag`.
   *
   * Mirrors `AssistantService.getTagsByAssistantIds`: read paths in owning
   * services should resolve associated tags with a single round-trip rather
   * than per-entity TagService calls. Optional `tx` lets create/update reuse
   * an in-flight transaction so the response reflects writes atomically.
   *
   * Ordering contract: `(agentId, tag.name)` — grouped per agent, alphabetical
   * within each group. Matches the assistant equivalent for UI-side stability.
   */
  private async getTagsByAgentIds(
    agentIds: string[],
    tx: Pick<DbType, 'select'> = application.get('DbService').getDb()
  ): Promise<Map<string, Tag[]>> {
    const tagMap = new Map<string, Tag[]>()
    if (agentIds.length === 0) return tagMap

    for (const id of agentIds) {
      tagMap.set(id, [])
    }

    const rows = await tx
      .select({
        agentId: entityTagTable.entityId,
        tagId: tagTable.id,
        tagName: tagTable.name,
        tagColor: tagTable.color,
        tagCreatedAt: tagTable.createdAt,
        tagUpdatedAt: tagTable.updatedAt
      })
      .from(entityTagTable)
      .innerJoin(tagTable, eq(entityTagTable.tagId, tagTable.id))
      .where(and(eq(entityTagTable.entityType, 'agent'), inArray(entityTagTable.entityId, agentIds)))
      .orderBy(asc(entityTagTable.entityId), asc(tagTable.name))

    for (const row of rows) {
      tagMap.get(row.agentId)?.push({
        id: row.tagId,
        name: row.tagName,
        color: row.tagColor ?? null,
        createdAt: timestampToISO(row.tagCreatedAt),
        updatedAt: timestampToISO(row.tagUpdatedAt)
      })
    }

    return tagMap
  }

  async createAgent(req: CreateAgentDto): Promise<AgentEntity> {
    const id = `agent_${Date.now()}_${Math.random().toString(36).substring(2, 11)}`

    // Compute workspace paths (pure — directory creation is the caller's responsibility).
    const resolvedPaths = computeWorkspacePaths(req.accessiblePaths, id)

    const insertData: InsertAgentRow = {
      id,
      type: req.type,
      name: req.name || 'New Agent',
      description: req.description,
      instructions: req.instructions || 'You are a helpful assistant.',
      model: req.model,
      planModel: req.planModel,
      smallModel: req.smallModel,
      mcps: req.mcps ?? null,
      allowedTools: req.allowedTools ?? null,
      configuration: req.configuration ?? null,
      accessiblePaths: resolvedPaths,
      sortOrder: 0
    }

    const database = application.get('DbService').getDb()
    const { row, tags, modelName } = await withSqliteErrors(
      () =>
        database.transaction(async (tx) => {
          await tx.update(agentsTable).set({ sortOrder: sql`${agentsTable.sortOrder} + 1` })
          await tx.insert(agentsTable).values(insertData)

          if (req.tagIds !== undefined) {
            await tagService.syncEntityTagsWithin(tx, 'agent', id, req.tagIds)
          }

          const [inserted] = await tx.select().from(agentsTable).where(eq(agentsTable.id, id)).limit(1)
          if (!inserted) {
            throw DataApiErrorFactory.invalidOperation('create agent', 'insert succeeded but select returned no row')
          }
          // Re-read bound tags inside the tx so the response reflects freshly-written bindings.
          const [tagMap, modelNames] = await Promise.all([
            this.getTagsByAgentIds([id], tx),
            this.getModelNamesByUniqueIds([inserted.model], tx)
          ])
          return { row: inserted, tags: tagMap.get(id) ?? [], modelName: pickModelName(inserted.model, modelNames) }
        }),
      defaultHandlersFor('Agent', id)
    )

    return rowToAgent(row, tags, modelName)
  }

  private async findAgentRow(id: string, options: { includeDeleted?: boolean } = {}): Promise<AgentRow | undefined> {
    const database = application.get('DbService').getDb()
    const whereClause = options.includeDeleted
      ? eq(agentsTable.id, id)
      : and(eq(agentsTable.id, id), isNull(agentsTable.deletedAt))

    const result = await database.select().from(agentsTable).where(whereClause).limit(1)

    return result[0]
  }

  async getAgent(id: string): Promise<AgentEntity | null> {
    const row = await this.findAgentRow(id)
    if (!row) return null
    const [tagMap, modelNames] = await Promise.all([
      this.getTagsByAgentIds([id]),
      this.getModelNamesByUniqueIds([row.model])
    ])
    return rowToAgent(row, tagMap.get(id) ?? [], pickModelName(row.model, modelNames))
  }

  async listAgents(options: ListOptions = {}): Promise<{ agents: AgentEntity[]; total: number }> {
    const database = application.get('DbService').getDb()

    // AND-compose deletedAt-null + optional search / tagIds. Same pattern as
    // AssistantService.list: search runs LIKE against name OR description with
    // user-typed wildcards escaped; tagIds is a correlated subquery over
    // entity_tag for union (ANY-of) semantics so the count(*) query stays
    // correct without DISTINCT gymnastics.
    const conditions: SQL[] = [isNull(agentsTable.deletedAt)]
    if (options.search) {
      const pattern = `%${options.search.replace(/[\\%_]/g, '\\$&')}%`
      const nameMatch = sql`${agentsTable.name} LIKE ${pattern} ESCAPE '\\'`
      const descMatch = sql`${agentsTable.description} LIKE ${pattern} ESCAPE '\\'`
      const searchClause = or(nameMatch, descMatch)
      if (searchClause) conditions.push(searchClause)
    }
    if (options.tagIds && options.tagIds.length > 0) {
      const tagIds = Array.from(new Set(options.tagIds))
      conditions.push(
        inArray(
          agentsTable.id,
          database
            .select({ entityId: entityTagTable.entityId })
            .from(entityTagTable)
            .where(and(eq(entityTagTable.entityType, 'agent'), inArray(entityTagTable.tagId, tagIds)))
        )
      )
    }
    const whereClause = and(...conditions)

    const totalResult = await database.select({ count: count() }).from(agentsTable).where(whereClause)

    const sortBy = options.sortBy || 'sortOrder'
    const orderBy = options.orderBy || (sortBy === 'sortOrder' ? 'asc' : 'desc')

    const sortByToColumn: Record<
      string,
      | typeof agentsTable.sortOrder
      | typeof agentsTable.createdAt
      | typeof agentsTable.name
      | typeof agentsTable.updatedAt
    > = {
      sortOrder: agentsTable.sortOrder,
      createdAt: agentsTable.createdAt,
      updatedAt: agentsTable.updatedAt,
      name: agentsTable.name
    }
    const sortField = sortByToColumn[sortBy] ?? agentsTable.sortOrder
    const orderFn = orderBy === 'asc' ? asc : desc

    const baseQuery =
      sortBy === 'sortOrder'
        ? database
            .select()
            .from(agentsTable)
            .where(whereClause)
            .orderBy(orderFn(sortField), desc(agentsTable.createdAt))
        : database.select().from(agentsTable).where(whereClause).orderBy(orderFn(sortField))

    const result =
      options.limit !== undefined
        ? options.offset !== undefined
          ? await baseQuery.limit(options.limit).offset(options.offset)
          : await baseQuery.limit(options.limit)
        : await baseQuery

    const [tagMap, modelNames] = await Promise.all([
      this.getTagsByAgentIds(result.map((row) => row.id)),
      this.getModelNamesByUniqueIds(result.map((row) => row.model))
    ])
    const agents = result.map((row) => rowToAgent(row, tagMap.get(row.id) ?? [], pickModelName(row.model, modelNames)))

    return { agents, total: totalResult[0].count }
  }

  async updateAgent(
    id: string,
    updates: UpdateAgentDto,
    options: { replace?: boolean } = {}
  ): Promise<AgentEntity | null> {
    const existing = await this.getAgent(id)
    if (!existing) return null

    if (updates.accessiblePaths !== undefined && updates.accessiblePaths.length === 0) {
      throw DataApiErrorFactory.validation({ accessiblePaths: ['must not be empty'] })
    }

    // tagIds is a junction-table side effect, not an agent column. Strip it
    // before building the column update payload; sync inside the same
    // transaction so a failure in either step rolls the whole save back.
    const { tagIds, ...columnUpdates } = updates
    const hasTagUpdate = tagIds !== undefined

    const updateData: Partial<AgentRow> = {
      updatedAt: Date.now()
    }

    const replaceableEntityFields = Object.keys(AGENT_MUTABLE_FIELDS)
    const shouldReplace = options.replace ?? false

    for (const field of replaceableEntityFields) {
      if (shouldReplace || Object.prototype.hasOwnProperty.call(columnUpdates, field)) {
        if (Object.prototype.hasOwnProperty.call(columnUpdates, field)) {
          const value = columnUpdates[field as keyof typeof columnUpdates]
          ;(updateData as Record<string, unknown>)[field] = value ?? null
        } else if (shouldReplace) {
          ;(updateData as Record<string, unknown>)[field] = null
        }
      }
    }

    // updatedAt alone doesn't count as a column edit — only bump the row
    // when there's an actual user-driven change.
    const hasColumnUpdates = Object.keys(updateData).length > 1

    if (!hasColumnUpdates && !hasTagUpdate) {
      return existing
    }

    const database = application.get('DbService').getDb()

    const rawRows = await database
      .select()
      .from(agentsTable)
      .where(and(eq(agentsTable.id, id), isNull(agentsTable.deletedAt)))
      .limit(1)
    const rawOldAgent = rawRows[0]

    await withSqliteErrors(
      () =>
        database.transaction(async (tx) => {
          if (hasColumnUpdates) {
            await tx.update(agentsTable).set(updateData).where(eq(agentsTable.id, id))
            if (rawOldAgent) {
              await this.syncSettingsToSessions(tx, id, rawOldAgent, columnUpdates)
            }
          }
          if (hasTagUpdate) {
            await tagService.syncEntityTagsWithin(tx, 'agent', id, tagIds)
          }
        }),
      defaultHandlersFor('Agent', id)
    )

    return await this.getAgent(id)
  }

  /**
   * Sync agent settings to all sessions that haven't been individually customized.
   * Must be called inside a transaction so agent update and session sync are atomic.
   */
  private async syncSettingsToSessions(
    tx: DbOrTx,
    agentId: string,
    rawOldAgent: Record<string, unknown>,
    updates: Record<string, unknown>
  ): Promise<void> {
    const syncFields = ['model', 'planModel', 'smallModel', 'allowedTools', 'configuration', 'mcps', 'instructions']

    const changedFields = syncFields.filter((field) => {
      if (!Object.prototype.hasOwnProperty.call(updates, field)) return false
      return JSON.stringify(updates[field] ?? null) !== JSON.stringify(rawOldAgent[field] ?? null)
    })
    if (changedFields.length === 0) return

    const sessions = await tx.select().from(sessionsTable).where(eq(sessionsTable.agentId, agentId))
    if (sessions.length === 0) return

    for (const session of sessions) {
      const sessionUpdateData: Partial<Record<string, unknown>> = {}

      for (const field of changedFields) {
        const oldAgentValue = rawOldAgent[field] ?? null
        const sessionValue = (session as Record<string, unknown>)[field] ?? null

        if (JSON.stringify(oldAgentValue) === JSON.stringify(sessionValue)) {
          sessionUpdateData[field] = updates[field] ?? null
        }
      }

      if (Object.keys(sessionUpdateData).length > 0) {
        sessionUpdateData.updatedAt = Date.now()
        await tx.update(sessionsTable).set(sessionUpdateData).where(eq(sessionsTable.id, session.id))
      }
    }

    logger.info('Synced agent settings to sessions', {
      agentId,
      changedFields,
      sessionCount: sessions.length
    })
  }

  async reorderAgents(orderedIds: string[]): Promise<void> {
    const database = application.get('DbService').getDb()
    await database.transaction(async (tx) => {
      for (let i = 0; i < orderedIds.length; i++) {
        await tx.update(agentsTable).set({ sortOrder: i }).where(eq(agentsTable.id, orderedIds[i]))
      }
    })
    logger.info('Agents reordered', { count: orderedIds.length })
  }

  async deleteAgent(id: string): Promise<boolean> {
    const database = application.get('DbService').getDb()
    const agent = await this.findAgentRow(id)

    if (!agent) {
      return false
    }

    if (isBuiltinAgentId(id)) {
      const deletedAt = Date.now()
      const updatedAt = Date.now()

      await withSqliteErrors(
        async () =>
          database.transaction(async (tx) => {
            await tx.delete(agentSkillsTable).where(eq(agentSkillsTable.agentId, id))
            await tx.delete(scheduledTasksTable).where(eq(scheduledTasksTable.agentId, id))
            await tx.delete(sessionsTable).where(eq(sessionsTable.agentId, id))
            await tx.update(channelsTable).set({ agentId: null }).where(eq(channelsTable.agentId, id))
            await tagService.purgeForEntity(tx, 'agent', id)
            await tx.update(agentsTable).set({ deletedAt, updatedAt }).where(eq(agentsTable.id, id))
          }),
        defaultHandlersFor('Agent', id)
      )

      return true
    }

    const result = await withSqliteErrors(
      async () =>
        database.transaction(async (tx) => {
          await tagService.purgeForEntity(tx, 'agent', id)
          return await tx.delete(agentsTable).where(eq(agentsTable.id, id))
        }),
      defaultHandlersFor('Agent', id)
    )

    return result.rowsAffected > 0
  }

  async agentExists(id: string): Promise<boolean> {
    const result = await this.findAgentRow(id)
    return !!result
  }

  /** Returns the agent row regardless of soft-deletion, for bootstrap use. */
  async findAgentIncludingDeleted(id: string): Promise<{ deletedAt: number | null } | null> {
    const row = await this.findAgentRow(id, { includeDeleted: true })
    if (!row) return null
    return { deletedAt: row.deletedAt ?? null }
  }
}

export const agentService = new AgentService()
