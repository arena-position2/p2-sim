/**
 * @vitest-environment node
 *
 * Finish-turn guarantees for complex agent builds that previously stalled
 * mid-process (create without populate, unresolved follow-ups, empty bubble).
 */
import { describe, expect, it } from 'vitest'
import {
  buildWorkflowBuildChatAppendix,
  synthesizeAssistantSummaryFromTools,
} from '@/local-copilot/lib/synthesize-assistant-summary'
import {
  admitPrePopulateDiscovery,
  buildUnresolvedFollowUpClosingMessage,
  shouldEnsureWorkflowBuildClosingMessage,
  shouldForceIncompleteWorkflowPopulateContinuation,
  shouldRefundPrePopulateDiscoveryRound,
  shouldSynthesizeAssistantSummary,
} from '@/local-copilot/lib/user-facing-text'

describe('pre-populate discovery budget', () => {
  it('allows two metadata or artifact calls, then rejects further ones', () => {
    expect(
      admitPrePopulateDiscovery({
        createdWorkflowThisTurn: true,
        successfulPopulateEdits: 0,
        discoveryCallsSoFar: 0,
        toolName: 'get_blocks_metadata',
      })
    ).toBe('allow')
    expect(
      admitPrePopulateDiscovery({
        createdWorkflowThisTurn: true,
        successfulPopulateEdits: 0,
        discoveryCallsSoFar: 2,
        toolName: 'load_copilot_artifact',
      })
    ).toBe('reject')
  })

  it('ignores the cap once a populate edit has succeeded', () => {
    expect(
      admitPrePopulateDiscovery({
        createdWorkflowThisTurn: true,
        successfulPopulateEdits: 1,
        discoveryCallsSoFar: 4,
        toolName: 'get_blocks_metadata',
      })
    ).toBe('ignore')
  })

  it('refunds a discovery-only round and does not refund a rejected one', () => {
    expect(
      shouldRefundPrePopulateDiscoveryRound({
        createdWorkflowThisTurn: true,
        successfulPopulateEdits: 0,
        roundToolNames: ['get_blocks_metadata', 'load_copilot_artifact'],
        refundsSoFar: 0,
        hadRejectedDiscovery: false,
      })
    ).toBe(true)
    expect(
      shouldRefundPrePopulateDiscoveryRound({
        createdWorkflowThisTurn: true,
        successfulPopulateEdits: 0,
        roundToolNames: ['get_blocks_metadata'],
        refundsSoFar: 0,
        hadRejectedDiscovery: true,
      })
    ).toBe(false)
    expect(
      shouldRefundPrePopulateDiscoveryRound({
        createdWorkflowThisTurn: true,
        successfulPopulateEdits: 0,
        roundToolNames: ['get_blocks_metadata', 'edit_workflow'],
        refundsSoFar: 0,
        hadRejectedDiscovery: false,
      })
    ).toBe(false)
  })
})

describe('shouldForceIncompleteWorkflowPopulateContinuation', () => {
  it('forces when create ran with no populate and no pending follow-ups', () => {
    expect(
      shouldForceIncompleteWorkflowPopulateContinuation({
        postBuildToolMode: 'all',
        createdWorkflowThisTurn: true,
        successfulPopulateEdits: 0,
        pendingFollowUpCount: 0,
        forcedIncompletePopulateContinuations: 0,
        maxForcedIncompletePopulateContinuations: 2,
        round: 3,
        maxToolRounds: 20,
      })
    ).toBe(true)
  })

  it('does not force when populate already succeeded', () => {
    expect(
      shouldForceIncompleteWorkflowPopulateContinuation({
        postBuildToolMode: 'all',
        createdWorkflowThisTurn: true,
        successfulPopulateEdits: 1,
        pendingFollowUpCount: 0,
        forcedIncompletePopulateContinuations: 0,
        maxForcedIncompletePopulateContinuations: 2,
        round: 3,
        maxToolRounds: 20,
      })
    ).toBe(false)
  })

  it('defers to mandatory follow-ups when they are still pending', () => {
    expect(
      shouldForceIncompleteWorkflowPopulateContinuation({
        postBuildToolMode: 'all',
        createdWorkflowThisTurn: true,
        successfulPopulateEdits: 0,
        pendingFollowUpCount: 1,
        forcedIncompletePopulateContinuations: 0,
        maxForcedIncompletePopulateContinuations: 2,
        round: 3,
        maxToolRounds: 20,
      })
    ).toBe(false)
  })
})

describe('shouldSynthesizeAssistantSummary for incomplete builds', () => {
  it('synthesizes when create-without-populate even if mid-progress prose exists', () => {
    expect(
      shouldSynthesizeAssistantSummary({
        streamedUserFacingText: 'Created "Agent" as an empty workflow.',
        toolRecordCount: 2,
        createdWithoutPopulate: true,
      })
    ).toBe(true)
  })

  it('synthesizes when unresolved follow-ups remain', () => {
    expect(
      shouldSynthesizeAssistantSummary({
        streamedUserFacingText: 'Updated the workflow with the requested blocks.',
        toolRecordCount: 3,
        unresolvedFollowUpCount: 1,
      })
    ).toBe(true)
  })

  it('still skips synthesize for complete mid-progress without incomplete flags', () => {
    expect(
      shouldSynthesizeAssistantSummary({
        streamedUserFacingText:
          'Created the workflow "Support Agent" and opened it in the panel. It now answers current-affairs questions and can generate charts.',
        toolRecordCount: 4,
      })
    ).toBe(false)
  })
})

describe('shouldEnsureWorkflowBuildClosingMessage', () => {
  it('requires a closing message after create without populate', () => {
    expect(
      shouldEnsureWorkflowBuildClosingMessage({
        hasDiscoveryTools: true,
        hasMutationTools: true,
        createdWorkflowThisTurn: true,
        successfulPopulateEdits: 0,
        pendingFollowUpCount: 0,
        streamedUserFacingText: 'Created "Agent" as an empty workflow.',
      })
    ).toBe(true)
  })

  it('requires a closing message when discovery ran with empty bubble', () => {
    expect(
      shouldEnsureWorkflowBuildClosingMessage({
        hasDiscoveryTools: true,
        hasMutationTools: false,
        createdWorkflowThisTurn: false,
        successfulPopulateEdits: 0,
        pendingFollowUpCount: 0,
        streamedUserFacingText: '',
      })
    ).toBe(true)
  })

  it('does not force when a populated build already has real prose', () => {
    expect(
      shouldEnsureWorkflowBuildClosingMessage({
        hasDiscoveryTools: true,
        hasMutationTools: true,
        createdWorkflowThisTurn: true,
        successfulPopulateEdits: 2,
        pendingFollowUpCount: 0,
        streamedUserFacingText:
          'Built a multi-agent workflow with research, chart, and image tools wired on the agent.',
      })
    ).toBe(false)
  })
})

describe('buildWorkflowBuildChatAppendix', () => {
  it('explains create-without-populate', () => {
    const appendix = buildWorkflowBuildChatAppendix(
      [
        {
          name: 'create_workflow',
          success: true,
          result: { workflowId: 'wf-1', workflowName: 'Current Affairs Agent' },
        },
      ],
      { createdWorkflowThisTurn: true, successfulPopulateEdits: 0 }
    )
    expect(appendix).toMatch(/empty workflow/i)
    expect(appendix).toMatch(/still need to be added/i)
  })

  it('reports the last edit failure instead of the create hint after an edit was attempted', () => {
    const appendix = buildWorkflowBuildChatAppendix(
      [
        {
          name: 'create_workflow',
          success: true,
          result: { workflowId: 'wf-1', workflowName: 'Daily Briefing' },
        },
        {
          name: 'edit_workflow',
          success: false,
          error: 'Call get_blocks_metadata before editing schedule_trigger.',
          result: {
            success: false,
            editPrecondition: 'metadata',
            error: 'Call get_blocks_metadata before editing schedule_trigger.',
          },
        },
      ],
      {
        createdWorkflowThisTurn: true,
        successfulPopulateEdits: 0,
        unresolvedFollowUpHint:
          'New workflow created. Do NOT create_workflow or get_workflow_context again.',
      }
    )
    expect(appendix).toMatch(/last edit did not add the blocks/i)
    expect(appendix).toMatch(/block metadata/i)
    expect(appendix).not.toMatch(/Do NOT create_workflow/i)
  })

  it('reports skipped operations from the last edit', () => {
    const appendix = buildWorkflowBuildChatAppendix(
      [
        {
          name: 'edit_workflow',
          success: true,
          result: {
            skippedItems: [{ reason: 'Unknown block type "schedule_trigger".' }],
          },
        },
      ],
      {
        createdWorkflowThisTurn: true,
        successfulPopulateEdits: 0,
        unresolvedFollowUpHint: 'New workflow created. Call edit_workflow.',
      }
    )
    expect(appendix).toMatch(/schedule_trigger/)
    expect(appendix).toMatch(/skipped/i)
  })

  it('surfaces unresolved follow-up hint', () => {
    const appendix = buildWorkflowBuildChatAppendix(
      [{ name: 'edit_workflow', success: true, result: { message: 'Updated' } }],
      {
        createdWorkflowThisTurn: true,
        successfulPopulateEdits: 1,
        unresolvedFollowUpHint: 'Call edit_workflow again with corrected operations.',
      }
    )
    expect(appendix).toMatch(/still need to finish/i)
    expect(appendix).toMatch(/edit_workflow again/i)
  })

  it('falls back to tool synthesize for populated edits', () => {
    const records = [
      {
        name: 'create_workflow',
        success: true,
        result: { workflowId: 'wf-1', workflowName: 'Agent' },
      },
      {
        name: 'edit_workflow',
        success: true,
        result: { message: 'Added agent and wired start → agent.' },
      },
    ]
    expect(buildWorkflowBuildChatAppendix(records)).toEqual(
      synthesizeAssistantSummaryFromTools(records)
    )
  })

  it('shows the patch-repair user sentence instead of the model hint', () => {
    const userHint =
      'I could not find that exact text in the file, so nothing was changed. Tell me the button label, heading, or section to update and I will try again.'
    const modelHint = 'Call read or grep NOW. Do not tell the user the file is missing.'
    expect(
      buildWorkflowBuildChatAppendix([], {
        unresolvedFollowUpHint: modelHint,
        unresolvedFollowUpUserHint: userHint,
      })
    ).toBe(userHint)
    expect(
      buildUnresolvedFollowUpClosingMessage([
        { hint: modelHint, userHint, resolveWith: ['read', 'grep'] },
      ])
    ).toBe(userHint)
    expect(buildUnresolvedFollowUpClosingMessage([{ hint: modelHint }])).toBe(
      `I made partial progress but still need to finish: ${modelHint}`
    )
  })
})
