import { agentTable } from '@data/db/schemas/agent'
import { entityTagTable, tagTable } from '@data/db/schemas/tagging'
import { agentService } from '@data/services/AgentService'
import { setupTestDatabase } from '@test-helpers/db'
import { and, eq } from 'drizzle-orm'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@main/apiServer/services/mcp', () => ({
  mcpApiService: {
    getServerInfo: vi.fn()
  }
}))

vi.mock('@main/apiServer/utils', () => ({
  validateModelId: vi.fn()
}))

vi.mock('@main/apiServer/services/models', () => ({
  modelsService: {
    getModels: vi.fn()
  }
}))

vi.mock('@main/services/agents/skills/SkillService', () => ({
  skillService: {
    initSkillsForAgent: vi.fn()
  }
}))

// Mock workspace seeding — filesystem ops not needed in unit tests
vi.mock('@main/services/agents/services/cherryclaw/seedWorkspace', () => ({
  seedWorkspaceTemplates: vi.fn()
}))

// Mock agentUtils functions that call external services
vi.mock('@main/services/agents/agentUtils', async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...(actual as object),
    listMcpTools: vi.fn().mockResolvedValue({ tools: [], legacyIdMap: {} }),
    validateAgentModels: vi.fn().mockResolvedValue(undefined),
    resolveAccessiblePaths: vi.fn((paths: string[]) => paths)
  }
})

describe('AgentService', () => {
  const dbh = setupTestDatabase()

  async function insertAgent(overrides: Partial<typeof agentTable.$inferInsert> = {}): Promise<{ id: string }> {
    const id = overrides.id ?? `agent_test_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`
    const base: typeof agentTable.$inferInsert = {
      type: 'claude-code',
      name: 'Test Agent',
      model: 'claude-3-5-sonnet',
      sortOrder: 0,
      ...overrides,
      id
    }
    await dbh.db.insert(agentTable).values(base)
    return { id }
  }

  describe('deleteAgent', () => {
    it('hard-deletes a non-builtin agent and removes the row', async () => {
      const { id } = await insertAgent({ id: 'agent_regular_test_001' })

      const deleted = await agentService.deleteAgent(id)

      expect(deleted).toBe(true)
      const rows = await dbh.db.select().from(agentTable)
      expect(rows.find((r) => r.id === id)).toBeUndefined()
    })

    it('soft-deletes a builtin agent by setting deletedAt', async () => {
      await insertAgent({ id: 'cherry-claw-default' })

      const deleted = await agentService.deleteAgent('cherry-claw-default')

      expect(deleted).toBe(true)
      const [row] = await dbh.db.select().from(agentTable)
      expect(row?.deletedAt).toBeTruthy()
      // Row still exists in the table
      expect(row?.id).toBe('cherry-claw-default')
    })
  })

  describe('listAgents', () => {
    it('respects limit and offset', async () => {
      for (let i = 0; i < 5; i++) {
        await insertAgent({ name: `Agent ${i}`, sortOrder: i })
      }

      const page1 = await agentService.listAgents({ limit: 2, offset: 0 })
      const page2 = await agentService.listAgents({ limit: 2, offset: 2 })

      expect(page1.agents).toHaveLength(2)
      expect(page2.agents).toHaveLength(2)
      expect(page1.total).toBe(5)
      // Pages should not overlap
      const ids1 = page1.agents.map((a) => a.id)
      const ids2 = page2.agents.map((a) => a.id)
      expect(ids1.some((id) => ids2.includes(id))).toBe(false)
    })

    it('sorts by name ascending when sortBy=name and orderBy=asc', async () => {
      await insertAgent({ name: 'Zebra', sortOrder: 0 })
      await insertAgent({ name: 'Alpha', sortOrder: 1 })
      await insertAgent({ name: 'Mango', sortOrder: 2 })

      const { agents } = await agentService.listAgents({ sortBy: 'name', orderBy: 'asc' })

      const names = agents.map((a) => a.name)
      expect(names).toEqual([...names].sort())
    })

    it('embeds bound tags in each row', async () => {
      const { id: a1 } = await insertAgent({ id: 'agent_tag_test_1', name: 'tagged' })
      const { id: a2 } = await insertAgent({ id: 'agent_tag_test_2', name: 'untagged' })
      await dbh.db.insert(tagTable).values([
        { id: '11111111-1111-4111-8111-111111111111', name: 'work', color: '#fff' },
        { id: '22222222-2222-4222-8222-222222222222', name: 'play', color: '#000' }
      ])
      await dbh.db.insert(entityTagTable).values([
        { entityType: 'agent', entityId: a1, tagId: '11111111-1111-4111-8111-111111111111' },
        { entityType: 'agent', entityId: a1, tagId: '22222222-2222-4222-8222-222222222222' }
      ])

      const { agents } = await agentService.listAgents()

      const tagged = agents.find((a) => a.id === a1)
      const untagged = agents.find((a) => a.id === a2)
      // Ordering contract: alphabetical by tag name within each agent.
      expect(tagged?.tags.map((t) => t.name)).toEqual(['play', 'work'])
      expect(untagged?.tags).toEqual([])
    })

    it('filters by search against name OR description (case-insensitive)', async () => {
      await insertAgent({ id: 'agent_search_1', name: 'Research Bot' })
      await insertAgent({ id: 'agent_search_2', name: 'unrelated', description: 'used for research' })
      await insertAgent({ id: 'agent_search_3', name: 'noise' })

      const { agents } = await agentService.listAgents({ search: 'research' })

      expect(agents.map((a) => a.id).sort()).toEqual(['agent_search_1', 'agent_search_2'])
    })

    it('filters by tagIds with UNION semantics', async () => {
      await insertAgent({ id: 'agent_uni_1', name: 'work-only' })
      await insertAgent({ id: 'agent_uni_2', name: 'play-only' })
      await insertAgent({ id: 'agent_uni_3', name: 'both' })
      await insertAgent({ id: 'agent_uni_4', name: 'untagged' })
      await dbh.db.insert(tagTable).values([
        { id: '11111111-1111-4111-8111-111111111111', name: 'work' },
        { id: '22222222-2222-4222-8222-222222222222', name: 'play' }
      ])
      await dbh.db.insert(entityTagTable).values([
        { entityType: 'agent', entityId: 'agent_uni_1', tagId: '11111111-1111-4111-8111-111111111111' },
        { entityType: 'agent', entityId: 'agent_uni_2', tagId: '22222222-2222-4222-8222-222222222222' },
        { entityType: 'agent', entityId: 'agent_uni_3', tagId: '11111111-1111-4111-8111-111111111111' },
        { entityType: 'agent', entityId: 'agent_uni_3', tagId: '22222222-2222-4222-8222-222222222222' }
      ])

      const { agents, total } = await agentService.listAgents({
        tagIds: ['11111111-1111-4111-8111-111111111111', '22222222-2222-4222-8222-222222222222']
      })

      expect(agents.map((a) => a.id).sort()).toEqual(['agent_uni_1', 'agent_uni_2', 'agent_uni_3'])
      // Distinct entity count, not sum of bindings (3 vs 4 if double-counted).
      expect(total).toBe(3)
    })
  })

  describe('tag binding via create/update/delete', () => {
    async function seedTags() {
      await dbh.db.insert(tagTable).values([
        { id: '33333333-3333-4333-8333-333333333333', name: 'alpha' },
        { id: '44444444-4444-4444-8444-444444444444', name: 'beta' }
      ])
    }

    it('createAgent persists tagIds in entity_tag inside the same txn', async () => {
      await seedTags()
      const created = await agentService.createAgent({
        type: 'claude-code',
        name: 'with-tags',
        model: 'claude-3-5-sonnet',
        accessiblePaths: [],
        tagIds: ['33333333-3333-4333-8333-333333333333']
      })

      expect(created.tags.map((t) => t.id)).toEqual(['33333333-3333-4333-8333-333333333333'])

      const bindings = await dbh.db
        .select()
        .from(entityTagTable)
        .where(and(eq(entityTagTable.entityType, 'agent'), eq(entityTagTable.entityId, created.id)))
      expect(bindings).toHaveLength(1)
    })

    it('updateAgent with tagIds replaces existing bindings', async () => {
      await seedTags()
      const created = await agentService.createAgent({
        type: 'claude-code',
        name: 'replace-tags',
        model: 'claude-3-5-sonnet',
        accessiblePaths: [],
        tagIds: ['33333333-3333-4333-8333-333333333333']
      })

      const updated = await agentService.updateAgent(created.id, {
        tagIds: ['44444444-4444-4444-8444-444444444444']
      })

      expect(updated?.tags.map((t) => t.id)).toEqual(['44444444-4444-4444-8444-444444444444'])
    })

    it('updateAgent with empty tagIds clears all bindings', async () => {
      await seedTags()
      const created = await agentService.createAgent({
        type: 'claude-code',
        name: 'clear-tags',
        model: 'claude-3-5-sonnet',
        accessiblePaths: [],
        tagIds: ['33333333-3333-4333-8333-333333333333', '44444444-4444-4444-8444-444444444444']
      })

      const cleared = await agentService.updateAgent(created.id, { tagIds: [] })

      expect(cleared?.tags).toEqual([])
      const bindings = await dbh.db
        .select()
        .from(entityTagTable)
        .where(and(eq(entityTagTable.entityType, 'agent'), eq(entityTagTable.entityId, created.id)))
      expect(bindings).toHaveLength(0)
    })

    it('deleteAgent purges tag bindings for non-builtin agent', async () => {
      await seedTags()
      const created = await agentService.createAgent({
        type: 'claude-code',
        name: 'doomed',
        model: 'claude-3-5-sonnet',
        accessiblePaths: [],
        tagIds: ['33333333-3333-4333-8333-333333333333']
      })

      await agentService.deleteAgent(created.id)

      const bindings = await dbh.db
        .select()
        .from(entityTagTable)
        .where(and(eq(entityTagTable.entityType, 'agent'), eq(entityTagTable.entityId, created.id)))
      expect(bindings).toHaveLength(0)
    })
  })
})
