/**
 * @vitest-environment node
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockSanitizeForCopilot } = vi.hoisted(() => ({
  mockSanitizeForCopilot: vi.fn((value: unknown) => value),
}))

vi.mock('@/lib/workflows/sanitization/json-sanitizer', () => ({
  sanitizeForCopilot: mockSanitizeForCopilot,
}))

vi.mock('@/lib/mothership/chat/document-format-guidance', () => ({
  documentLayoutFollowUpHint: (_fileName: string, hint: string) => hint,
}))

vi.mock('@/lib/core/security/redaction', () => ({
  REDACTED_MARKER: '[REDACTED]',
}))

vi.mock('@/triggers/webhook-url', () => ({
  blockAdvertisesWebhookUrl: () => false,
  resolveBlockTriggerId: () => undefined,
}))

vi.mock('@/triggers/constants', () => ({
  TRIGGER_ROUTING_FIELD: 'triggerRouting',
  TRIGGER_WEBHOOK_URL_FIELD: 'webhookUrl',
}))

import { fingerprintToolCall } from '@/local-copilot/lib/agent/tool-stagnation'
import {
  canEnterToolRound,
  canForceMandatoryFollowUp,
  classifyEditWorkflowPrecondition,
  coalesceToolExecutionPayloadForLlm,
  detectMandatoryFollowUp,
  editWorkflowNeedsFollowUp,
  formatToolResultForLlm,
  isAlreadyCopilotSanitizedWorkflowState,
  type MandatoryFollowUp,
} from '@/local-copilot/lib/tools/format-tool-result'

beforeEach(() => {
  mockSanitizeForCopilot.mockClear()
  mockSanitizeForCopilot.mockImplementation((value: unknown) => value)
})

describe('editWorkflowNeedsFollowUp precondition gates', () => {
  it('does not treat get_blocks_metadata gate as a bare edit repair', () => {
    const output = {
      success: false,
      error: 'Call get_blocks_metadata for [agent] before edit_workflow.',
    }
    expect(editWorkflowNeedsFollowUp(output)).toBe(false)
    expect(classifyEditWorkflowPrecondition(output)).toBe('metadata')
  })

  it('still flags partial apply as needs follow-up', () => {
    expect(editWorkflowNeedsFollowUp({ success: true, partialApply: true })).toBe(true)
  })

  it('routes metadata precondition to get_blocks_metadata then edit', () => {
    const formatted = formatToolResultForLlm('edit_workflow', {
      success: false,
      error: 'Call get_blocks_metadata for [agent] before edit_workflow.',
    })
    const followUp = detectMandatoryFollowUp('edit_workflow', formatted)
    expect(followUp?.resolveWith).toEqual(['get_blocks_metadata', 'edit_workflow'])
  })

  it('routes stale revision to get_workflow_context then edit', () => {
    const formatted = formatToolResultForLlm('edit_workflow', {
      success: false,
      error: 'stale revision: workflow changed since this turn loaded',
    })
    const followUp = detectMandatoryFollowUp('edit_workflow', formatted)
    expect(followUp?.resolveWith).toEqual(['get_workflow_context', 'edit_workflow'])
  })
})

describe('edit_workflow already-sanitized workflowState', () => {
  const copilotShapedState = {
    blocks: {
      '48ddd46d-7f95-46ac-be50-faacb8bae6f5': {
        type: 'schedule',
        name: 'Schedule',
        enabled: true,
        inputs: { scheduleType: 'custom' },
        connections: { source: 'd3647959-e47b-4c3f-b87f-9ecc9bb230e9' },
      },
    },
  }

  it('detects Copilot-shaped workflowState', () => {
    expect(isAlreadyCopilotSanitizedWorkflowState(copilotShapedState)).toBe(true)
    expect(
      isAlreadyCopilotSanitizedWorkflowState({
        blocks: {
          'block-1': {
            type: 'function',
            name: 'Fetch',
            subBlocks: { code: { id: 'code', type: 'code', value: '1' } },
          },
        },
        edges: [],
      })
    ).toBe(false)
  })

  it('passes through Copilot-shaped workflowState without re-sanitizing', () => {
    mockSanitizeForCopilot.mockImplementation(() => {
      throw new TypeError('Object.entries requires that input parameter not be null or undefined')
    })

    const formatted = formatToolResultForLlm('edit_workflow', {
      success: true,
      partialApply: true,
      workflowState: copilotShapedState,
      skippedItems: [
        {
          type: 'block_not_found',
          operationType: 'delete',
          blockId: 'schedule-trigger-1',
          reason: 'Block "schedule-trigger-1" does not exist',
          details: {
            suggestions: [
              {
                blockId: '48ddd46d-7f95-46ac-be50-faacb8bae6f5',
                blockName: 'Schedule',
                blockType: 'schedule',
              },
            ],
          },
        },
      ],
    })

    expect(mockSanitizeForCopilot).not.toHaveBeenCalled()
    const parsed = JSON.parse(formatted) as Record<string, unknown>
    expect(parsed.copilotSanitizedWorkflowState).toEqual(copilotShapedState)
    expect(parsed.needsFollowUpEdit).toBe(true)
    expect(String(parsed.followUpHint)).toContain('48ddd46d-7f95-46ac-be50-faacb8bae6f5')
    expect(String(parsed.followUpHint)).toMatch(/Do not invent ids/i)
  })
})

describe('office empty-shell create_file results', () => {
  it('marks PDF size=0 shells as expected success and requires workspace_file', () => {
    const formatted = formatToolResultForLlm('create_file', {
      success: true,
      message: 'Empty file shell "files/Report.pdf" created.',
      data: { vfsPath: 'files/Report.pdf', name: 'Report.pdf', size: 0 },
    })
    const parsed = JSON.parse(formatted) as Record<string, unknown>
    expect(parsed.expectedEmptyShell).toBe(true)
    expect(parsed.needsFollowUpWorkspaceFile).toBe(true)
    expect(String(parsed.followUpHint)).toMatch(/SUCCESS/i)
    expect(String(parsed.followUpHint)).not.toMatch(/tools returned empty/i)

    const followUp = detectMandatoryFollowUp('create_file', formatted)
    expect(followUp?.resolveWith).toEqual(['workspace_file'])
  })

  it('clarifies empty folder lists are not failures', () => {
    const formatted = formatToolResultForLlm('list_file_folders', {
      success: true,
      data: { folders: [] },
    })
    const parsed = JSON.parse(formatted) as Record<string, unknown>
    expect(String(parsed.followUpHint)).toMatch(/not a tool failure/i)
  })

  it('redirects create_file failures away from sandbox fallback', () => {
    const formatted = formatToolResultForLlm('create_file', {
      success: false,
      message: 'Failed to create file',
    })
    const parsed = JSON.parse(formatted) as Record<string, unknown>
    expect(String(parsed.followUpHint)).toMatch(/Do NOT switch to manage_sandbox/i)
    expect(String(parsed.followUpHint)).toMatch(/create_file again/i)
  })
})

describe('recoverable workspace_file patch failures', () => {
  it('marks search_not_found as mandatory patch-repair follow-up', () => {
    const formatted = formatToolResultForLlm('workspace_file', {
      success: false,
      errorType: 'search_not_found',
      recoverable: true,
      message: 'Patch failed: search string not found in file "dashboard.html".',
      data: {
        id: 'file-1',
        name: 'dashboard.html',
        vfsPath: 'files/dashboard.html',
        operation: 'patch',
        suggestedNextTools: ['read', 'grep', 'workspace_file'],
      },
    })
    const parsed = JSON.parse(formatted) as Record<string, unknown>
    expect(parsed.needsFollowUpPatchRepair).toBe(true)
    expect(parsed.recoverable).toBe(true)
    expect(String(parsed.followUpHint)).toMatch(/read or grep/i)
    expect(String(parsed.followUpHint)).toMatch(/Do not tell the user the file is missing/i)

    const followUp = detectMandatoryFollowUp('workspace_file', formatted)
    expect(followUp?.id).toBe('workspace_file:patch-repair')
    expect(followUp?.resolveWith).toEqual(['read', 'grep', 'workspace_file'])
  })

  it('marks truncated search failures as patch-repair follow-up', () => {
    const formatted = formatToolResultForLlm('workspace_file', {
      success: false,
      errorType: 'search_looks_truncated',
      message: 'Patch failed: search string looks copied from a truncated read',
      data: { operation: 'patch', name: 'page.html' },
    })
    const parsed = JSON.parse(formatted) as Record<string, unknown>
    expect(parsed.needsFollowUpPatchRepair).toBe(true)

    const followUp = detectMandatoryFollowUp('workspace_file', formatted)
    expect(followUp?.resolveWith).toContain('read')
  })
})

describe('coalesceToolExecutionPayloadForLlm', () => {
  it('surfaces top-level error when result is empty', () => {
    const payload = coalesceToolExecutionPayloadForLlm({
      success: false,
      result: {},
      error: 'name is required',
      toolName: 'create_file_folder',
    })
    expect(payload).toEqual({ success: false, error: 'name is required' })
  })

  it('avoids bare {} on successful empty result', () => {
    const payload = coalesceToolExecutionPayloadForLlm({
      success: true,
      result: {},
      toolName: 'create_file_folder',
    }) as Record<string, unknown>
    expect(payload.success).toBe(true)
    expect(String(payload.message)).toContain('create_file_folder')
  })

  it('guards empty create_file_folder success through formatToolResultForLlm', () => {
    const formatted = formatToolResultForLlm(
      'create_file_folder',
      coalesceToolExecutionPayloadForLlm({
        success: true,
        result: {},
        toolName: 'create_file_folder',
      })
    )
    const parsed = JSON.parse(formatted) as Record<string, unknown>
    expect(parsed).not.toEqual({})
    expect(String(parsed.message ?? '')).toMatch(/create_file_folder|completed/i)
  })
})

describe('edit_workflow stagnation fingerprints', () => {
  it('changes when prompt values change on an incomplete edit', () => {
    const result = { success: true, partialApply: true, skippedItems: [{ reason: 'x' }] }
    const a = fingerprintToolCall(
      'edit_workflow',
      JSON.stringify({
        operations: [
          {
            block_id: 'agent-1',
            operation_type: 'edit',
            params: { systemPrompt: 'v1' },
          },
        ],
      }),
      true,
      result
    )
    const b = fingerprintToolCall(
      'edit_workflow',
      JSON.stringify({
        operations: [
          {
            block_id: 'agent-1',
            operation_type: 'edit',
            params: { systemPrompt: 'v2-different' },
          },
        ],
      }),
      true,
      result
    )
    expect(a).not.toBe(b)
  })
})

describe('write-critical follow-up round budget', () => {
  const editContentFollowUp: MandatoryFollowUp = {
    id: 'workspace_file:edit-content',
    hint: 'Call edit_content next',
    resolveWith: ['edit_content'],
  }
  const oauthFollowUp: MandatoryFollowUp = {
    id: 'edit_workflow:oauth',
    hint: 'Connect OAuth',
    resolveWith: ['oauth_get_auth_link'],
  }

  it('allows overflow rounds only when edit_content follow-up is pending', () => {
    expect(
      canEnterToolRound({
        round: 20,
        maxToolRounds: 20,
        maxForcedFollowUpRounds: 6,
        pendingFollowUps: [editContentFollowUp],
      })
    ).toBe(true)
    expect(
      canEnterToolRound({
        round: 20,
        maxToolRounds: 20,
        maxForcedFollowUpRounds: 6,
        pendingFollowUps: [oauthFollowUp],
      })
    ).toBe(false)
    expect(
      canEnterToolRound({
        round: 26,
        maxToolRounds: 20,
        maxForcedFollowUpRounds: 6,
        pendingFollowUps: [editContentFollowUp],
      })
    ).toBe(false)
  })

  it('forces edit_content follow-up on the last normal round', () => {
    expect(
      canForceMandatoryFollowUp({
        round: 19,
        maxToolRounds: 20,
        maxForcedFollowUpRounds: 6,
        forcedFollowUpRounds: 0,
        pendingFollowUps: [editContentFollowUp],
        postBuildAllows: true,
      })
    ).toBe(true)
    expect(
      canForceMandatoryFollowUp({
        round: 19,
        maxToolRounds: 20,
        maxForcedFollowUpRounds: 6,
        forcedFollowUpRounds: 0,
        pendingFollowUps: [oauthFollowUp],
        postBuildAllows: true,
      })
    ).toBe(false)
  })
})
