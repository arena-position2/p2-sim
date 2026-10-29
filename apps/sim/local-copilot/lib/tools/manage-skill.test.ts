/**
 * @vitest-environment node
 *
 * Failure modes under test:
 * - add without workspace write → denied (fail-closed permission)
 * - edit/delete without skill editor → denied
 * - edit of builtin skill id → rejected
 * - missing required args → rejected before ops
 * - list/add happy path → ops + success output (regression: tool must not 404)
 */
import { auditMock } from '@sim/testing/mocks/audit.mock'
import { posthogServerMock } from '@sim/testing/mocks/posthog-server.mock'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  listSkillsForUser,
  upsertSkills,
  deleteSkill,
  getSkillActorContext,
  isBuiltinSkillId,
  assertPermissionsAllowed,
} = vi.hoisted(() => ({
  listSkillsForUser: vi.fn(),
  upsertSkills: vi.fn(),
  deleteSkill: vi.fn(),
  getSkillActorContext: vi.fn(),
  isBuiltinSkillId: vi.fn((id: string) => id.startsWith('builtin:')),
  assertPermissionsAllowed: vi.fn(),
}))

vi.mock('@sim/audit', () => auditMock)
vi.mock('@/lib/posthog/server', () => posthogServerMock)
vi.mock('@/lib/workflows/skills/operations', () => ({
  listSkillsForUser,
  upsertSkills,
  deleteSkill,
}))
vi.mock('@/lib/skills/access', () => ({ getSkillActorContext }))
vi.mock('@/lib/workflows/skills/builtin-skills', () => ({ isBuiltinSkillId }))
vi.mock('@/ee/access-control/utils/permission-check', () => ({ assertPermissionsAllowed }))

import {
  executeLocalCopilotTool,
  type ToolExecutionContext,
} from '@/local-copilot/lib/tools/executor'
import { executeManageSkill } from '@/local-copilot/lib/tools/manage-skill'
import type { LocalCopilotStructuredContext } from '@/local-copilot/lib/types'

const workspaceId = 'workspace-1'
const userId = 'user-1'

function baseContext(
  overrides?: Partial<Parameters<typeof executeManageSkill>[1]>
): Parameters<typeof executeManageSkill>[1] {
  return {
    userId,
    workspaceId,
    userPermission: 'admin',
    ...overrides,
  }
}

function toolCtx(permission = 'admin'): ToolExecutionContext {
  const structuredContext: LocalCopilotStructuredContext = {
    workspace: { id: workspaceId, name: 'Workspace', environment: 'self_hosted' },
    connectedIntegrations: [],
    envVariables: [],
    hostedKeysAvailable: false,
    execution: {
      lastRunStatus: 'unknown',
      logs: [],
      failedBlockId: null,
      error: null,
    },
    availableIntegrations: [],
    availableBlocks: [],
  }
  return {
    userId,
    workspaceId,
    userPermission: permission,
    structuredContext,
  }
}

describe('executeManageSkill', () => {
  beforeEach(() => {
    listSkillsForUser.mockReset()
    upsertSkills.mockReset()
    deleteSkill.mockReset()
    getSkillActorContext.mockReset()
    isBuiltinSkillId.mockClear()
    assertPermissionsAllowed.mockReset()
    assertPermissionsAllowed.mockResolvedValue(undefined)
  })

  it('rejects a missing operation before touching skills ops', async () => {
    const result = await executeManageSkill({}, baseContext())
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/operation/i)
    expect(listSkillsForUser).not.toHaveBeenCalled()
    expect(upsertSkills).not.toHaveBeenCalled()
  })

  it('denies add when the caller lacks workspace write', async () => {
    const result = await executeManageSkill(
      {
        operation: 'add',
        name: 'Triage',
        description: 'Sort tickets',
        content: '# Triage\n...',
      },
      baseContext({ userPermission: 'read' })
    )

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/requires write access/i)
    expect(upsertSkills).not.toHaveBeenCalled()
  })

  it('lists workspace skills for a read-only caller', async () => {
    listSkillsForUser.mockResolvedValue([
      {
        id: 'skill-1',
        name: 'Triage',
        description: 'Sort tickets',
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
      },
    ])

    const result = await executeManageSkill(
      { operation: 'list' },
      baseContext({ userPermission: 'read' })
    )

    expect(result.success).toBe(true)
    expect(result.output).toMatchObject({
      success: true,
      operation: 'list',
      count: 1,
      skills: [{ id: 'skill-1', name: 'Triage', description: 'Sort tickets' }],
    })
  })

  it('creates a skill when the caller can write', async () => {
    upsertSkills.mockResolvedValue({
      skills: [{ id: 'skill-new', name: 'Triage' }],
      touched: [{ id: 'skill-new', name: 'Triage', operation: 'created' }],
    })

    const result = await executeManageSkill(
      {
        operation: 'add',
        name: 'Triage',
        description: 'Sort tickets',
        content: '# Triage\n...',
      },
      baseContext({ userPermission: 'write' })
    )

    expect(result.success).toBe(true)
    expect(result.output).toMatchObject({
      success: true,
      operation: 'add',
      skillId: 'skill-new',
      name: 'Triage',
    })
    expect(upsertSkills).toHaveBeenCalledWith({
      skills: [{ name: 'Triage', description: 'Sort tickets', content: '# Triage\n...' }],
      workspaceId,
      userId,
    })
  })

  it('denies edit when the actor is not a skill editor', async () => {
    getSkillActorContext.mockResolvedValue({
      skill: { id: 'skill-1', name: 'Triage', workspaceId },
      hasWorkspaceAccess: true,
      canEdit: false,
    })

    const result = await executeManageSkill(
      { operation: 'edit', skillId: 'skill-1', content: '# updated' },
      baseContext()
    )

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/requires skill editor access/i)
    expect(upsertSkills).not.toHaveBeenCalled()
  })

  it('rejects editing a built-in skill id', async () => {
    const result = await executeManageSkill(
      { operation: 'edit', skillId: 'builtin:docs', content: '# no' },
      baseContext()
    )

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/read-only/i)
    expect(getSkillActorContext).not.toHaveBeenCalled()
    expect(upsertSkills).not.toHaveBeenCalled()
  })

  it('deletes when the actor can edit', async () => {
    getSkillActorContext.mockResolvedValue({
      skill: { id: 'skill-1', name: 'Triage', workspaceId },
      hasWorkspaceAccess: true,
      canEdit: true,
    })
    deleteSkill.mockResolvedValue(true)

    const result = await executeManageSkill(
      { operation: 'delete', skillId: 'skill-1' },
      baseContext()
    )

    expect(result.success).toBe(true)
    expect(result.output).toMatchObject({
      success: true,
      operation: 'delete',
      skillId: 'skill-1',
    })
    expect(deleteSkill).toHaveBeenCalledWith({ skillId: 'skill-1', workspaceId })
  })
})

describe('executeLocalCopilotTool(manage_skill)', () => {
  beforeEach(() => {
    listSkillsForUser.mockReset()
    upsertSkills.mockReset()
    assertPermissionsAllowed.mockReset()
    assertPermissionsAllowed.mockResolvedValue(undefined)
  })

  it('runs locally instead of mothership fallthrough', async () => {
    listSkillsForUser.mockResolvedValue([])

    const result = await executeLocalCopilotTool('manage_skill', { operation: 'list' }, toolCtx())

    expect(result.success).toBe(true)
    expect(result.error).toBeUndefined()
    expect(String(result.error ?? '')).not.toMatch(/tool not found/i)
    expect(result.result).toMatchObject({ success: true, operation: 'list', count: 0 })
    expect(listSkillsForUser).toHaveBeenCalled()
  })
})
