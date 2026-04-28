import { beforeEach, describe, expect, it, vi } from 'vitest'

const { listMock, createMock, getByIdMock, updateMock, deleteMock } = vi.hoisted(() => ({
  listMock: vi.fn(),
  createMock: vi.fn(),
  getByIdMock: vi.fn(),
  updateMock: vi.fn(),
  deleteMock: vi.fn()
}))

vi.mock('@data/services/AssistantService', () => ({
  assistantDataService: {
    list: listMock,
    create: createMock,
    getById: getByIdMock,
    update: updateMock,
    delete: deleteMock
  }
}))

import { assistantHandlers } from '../assistants'

const ASSISTANT_ID = '11111111-1111-4111-8111-111111111111'
const TAG_ID = '22222222-2222-4222-8222-222222222222'
const MCP_SERVER_ID = 'mcp-server-1'

describe('assistantHandlers', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  describe('/assistants/:id', () => {
    it('should preserve tag-only PATCH bodies without injecting assistant defaults', async () => {
      updateMock.mockResolvedValueOnce({ id: ASSISTANT_ID, name: 'Test' })

      await assistantHandlers['/assistants/:id'].PATCH({
        params: { id: ASSISTANT_ID },
        body: { tagIds: [TAG_ID] }
      } as never)

      expect(updateMock).toHaveBeenCalledWith(ASSISTANT_ID, { tagIds: [TAG_ID] })
    })

    it('should preserve name-only PATCH bodies without injecting assistant defaults', async () => {
      updateMock.mockResolvedValueOnce({ id: ASSISTANT_ID, name: 'renamed' })

      await assistantHandlers['/assistants/:id'].PATCH({
        params: { id: ASSISTANT_ID },
        body: { name: 'renamed' }
      } as never)

      expect(updateMock).toHaveBeenCalledWith(ASSISTANT_ID, { name: 'renamed' })
    })

    it('should preserve relation-only PATCH bodies without injecting assistant defaults', async () => {
      updateMock.mockResolvedValueOnce({ id: ASSISTANT_ID, name: 'Test' })

      await assistantHandlers['/assistants/:id'].PATCH({
        params: { id: ASSISTANT_ID },
        body: { mcpServerIds: [MCP_SERVER_ID] }
      } as never)

      expect(updateMock).toHaveBeenCalledWith(ASSISTANT_ID, { mcpServerIds: [MCP_SERVER_ID] })
    })

    it('should reject invalid tag ids before calling update', async () => {
      await expect(
        assistantHandlers['/assistants/:id'].PATCH({
          params: { id: ASSISTANT_ID },
          body: { tagIds: ['not-a-uuid'] }
        } as never)
      ).rejects.toHaveProperty('name', 'ZodError')

      expect(updateMock).not.toHaveBeenCalled()
    })

    it('should not inject prompt/emoji/description defaults when omitted', async () => {
      updateMock.mockResolvedValueOnce({ id: ASSISTANT_ID, name: 'renamed' })

      await assistantHandlers['/assistants/:id'].PATCH({
        params: { id: ASSISTANT_ID },
        body: { name: 'renamed' }
      } as never)

      const [, patch] = updateMock.mock.calls[0]
      expect(patch).not.toHaveProperty('prompt')
      expect(patch).not.toHaveProperty('emoji')
      expect(patch).not.toHaveProperty('description')
      expect(patch).not.toHaveProperty('settings')
    })

    it('should forward settings as a whole when body provides it (full replacement)', async () => {
      updateMock.mockResolvedValueOnce({ id: ASSISTANT_ID, name: 'Test' })

      await assistantHandlers['/assistants/:id'].PATCH({
        params: { id: ASSISTANT_ID },
        body: { settings: { temperature: 0.5 } }
      } as never)

      const [, patch] = updateMock.mock.calls[0]
      // `settings` was present in body, so it is forwarded; entity-level `.default()` fills
      // omitted inner fields. Renderer is expected to send the full settings object.
      expect(patch).toHaveProperty('settings.temperature', 0.5)
      // Sibling top-level fields stay absent — they were not in `body`.
      expect(patch).not.toHaveProperty('prompt')
      expect(patch).not.toHaveProperty('emoji')
      expect(patch).not.toHaveProperty('description')
    })
  })
})
