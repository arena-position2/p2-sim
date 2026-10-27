/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import { MAX_FILE_EDIT_CONTINUATION_ROUNDS } from '@/local-copilot/lib/agent/limits'
import {
  buildDebugInspectionChatAppendix,
  buildFileInspectionChatAppendix,
  formatDebugInspectionChatResult,
  synthesizeAssistantSummaryFromTools,
  type ToolTurnRecord,
  turnHasDebugInspectionTools,
  turnHasFileInspectionTools,
  turnHasWorkflowDiscoveryTools,
} from '@/local-copilot/lib/synthesize-assistant-summary'
import {
  buildFileEditContinuationMessage,
  isFileInspectionBridgeNarration,
  isLiveWebSearchToolCall,
  shouldForceDebugExplanationContinuation,
  shouldForceFileEditContinuation,
  shouldForceResearchSearchContinuation,
  shouldForceWorkflowBuildContinuation,
} from '@/local-copilot/lib/user-facing-text'

describe('debug inspection synthesis', () => {
  it('formats explain_error analysis into user-facing prose', () => {
    const record: ToolTurnRecord = {
      name: 'explain_error',
      success: true,
      result: {
        errorMessage: 'Unauthorized: invalid API key',
        blockId: 'agent-1',
        analysis: {
          rootCause: 'Credential or authentication issue',
          failingBlock: { id: 'agent-1', type: 'agent', name: 'Research Agent' },
          suggestedFixes: ['Reconnect or select the correct credential in workspace settings'],
        },
      },
    }

    const text = formatDebugInspectionChatResult(record)
    expect(text).toContain('Credential or authentication issue')
    expect(text).toContain('Research Agent')
    expect(text).toContain('Unauthorized')
    expect(text).toContain('Reconnect')
  })

  it('prefers explain_error over earlier query_logs when synthesizing', () => {
    const summary = synthesizeAssistantSummaryFromTools([
      {
        name: 'query_logs',
        success: true,
        result: { data: [{ status: 'error', workflowName: 'Demo', error: 'boom' }] },
      },
      {
        name: 'explain_error',
        success: true,
        result: {
          errorMessage: 'boom',
          analysis: {
            rootCause: 'Block execution failure',
            suggestedFixes: ['Inspect block inputs'],
          },
        },
      },
    ])

    expect(summary).toContain('Block execution failure')
    expect(summary).not.toContain('From the logs:')
  })

  it('buildDebugInspectionChatAppendix returns the latest debug tool summary', () => {
    const appendix = buildDebugInspectionChatAppendix([
      {
        name: 'get_execution_logs',
        success: true,
        result: {
          data: [{ status: 'error', workflowName: 'Pipeline', error: 'timeout' }],
        },
      },
    ])
    expect(appendix).toContain('Pipeline')
    expect(appendix).toContain('timeout')
  })

  it('turnHasDebugInspectionTools detects log/debug tools', () => {
    expect(
      turnHasDebugInspectionTools([{ name: 'edit_workflow', success: true, result: {} }])
    ).toBe(false)
    expect(turnHasDebugInspectionTools([{ name: 'query_logs', success: true, result: {} }])).toBe(
      true
    )
    expect(turnHasDebugInspectionTools([{ name: 'run', success: true, result: {} }])).toBe(true)
  })

  it('parses explain_error dumps from specialist findings', () => {
    const summary = synthesizeAssistantSummaryFromTools([
      {
        name: 'run',
        success: true,
        result: {
          message:
            '[explain_error] {"errorMessage":"Unauthorized","analysis":{"rootCause":"Credential or authentication issue","suggestedFixes":["Reconnect credentials"]}}',
        },
      },
    ])
    expect(summary).toContain('Credential or authentication issue')
    expect(summary).toContain('Reconnect')
  })
})

describe('shouldForceResearchSearchContinuation', () => {
  it('forces when research intent settled without a live search tool', () => {
    expect(
      shouldForceResearchSearchContinuation({
        postBuildToolMode: 'all',
        needsLiveSearch: true,
        forcedResearchSearchContinuations: 0,
        maxForcedResearchSearchContinuations: 1,
        round: 0,
        maxToolRounds: 10,
        hasLiveWebSearch: false,
      })
    ).toBe(true)
  })

  it('does not force after search_online / exa already ran', () => {
    expect(
      shouldForceResearchSearchContinuation({
        postBuildToolMode: 'all',
        needsLiveSearch: true,
        forcedResearchSearchContinuations: 0,
        maxForcedResearchSearchContinuations: 1,
        round: 0,
        maxToolRounds: 10,
        hasLiveWebSearch: true,
      })
    ).toBe(false)
  })

  it('does not force for non-research intents', () => {
    expect(
      shouldForceResearchSearchContinuation({
        postBuildToolMode: 'all',
        needsLiveSearch: false,
        forcedResearchSearchContinuations: 0,
        maxForcedResearchSearchContinuations: 1,
        round: 0,
        maxToolRounds: 10,
        hasLiveWebSearch: false,
      })
    ).toBe(false)
  })
})

describe('isLiveWebSearchToolCall', () => {
  it('matches search_online and exa invoke tools', () => {
    expect(isLiveWebSearchToolCall('search_online')).toBe(true)
    expect(
      isLiveWebSearchToolCall('invoke_integration_tool', JSON.stringify({ toolId: 'exa_answer' }))
    ).toBe(true)
    expect(
      isLiveWebSearchToolCall(
        'invoke_integration_tool',
        JSON.stringify({ toolId: 'gmail_draft_v2' })
      )
    ).toBe(false)
  })
})

describe('shouldForceDebugExplanationContinuation', () => {
  it('forces a continuation when debug tools ran and no reply was streamed', () => {
    expect(
      shouldForceDebugExplanationContinuation({
        postBuildToolMode: 'all',
        forcedDebugExplanations: 0,
        maxForcedDebugExplanations: 1,
        round: 2,
        maxToolRounds: 10,
        hasDebugTools: true,
        streamedUserFacingText: '',
        roundDisplayText: '',
      })
    ).toBe(true)
  })

  it('does not force when the model already wrote a real reply', () => {
    expect(
      shouldForceDebugExplanationContinuation({
        postBuildToolMode: 'all',
        forcedDebugExplanations: 0,
        maxForcedDebugExplanations: 1,
        round: 2,
        maxToolRounds: 10,
        hasDebugTools: true,
        streamedUserFacingText: 'The agent block failed because the API key is invalid.',
        roundDisplayText: '',
      })
    ).toBe(false)
  })

  it('does not force twice', () => {
    expect(
      shouldForceDebugExplanationContinuation({
        postBuildToolMode: 'all',
        forcedDebugExplanations: 1,
        maxForcedDebugExplanations: 1,
        round: 2,
        maxToolRounds: 10,
        hasDebugTools: true,
        streamedUserFacingText: '',
        roundDisplayText: '',
      })
    ).toBe(false)
  })
})

describe('shouldForceWorkflowBuildContinuation', () => {
  it('forces a continuation after discovery tools with no create/edit', () => {
    expect(
      shouldForceWorkflowBuildContinuation({
        postBuildToolMode: 'all',
        forcedWorkflowBuildContinuations: 0,
        maxForcedWorkflowBuildContinuations: 2,
        round: 2,
        maxToolRounds: 10,
        hasDiscoveryTools: true,
        hasMutationTools: false,
        streamedUserFacingText: '',
        roundDisplayText: '',
      })
    ).toBe(true)
  })

  it('does not force after create_workflow / edit_workflow already ran', () => {
    expect(
      shouldForceWorkflowBuildContinuation({
        postBuildToolMode: 'all',
        forcedWorkflowBuildContinuations: 0,
        maxForcedWorkflowBuildContinuations: 2,
        round: 2,
        maxToolRounds: 10,
        hasDiscoveryTools: true,
        hasMutationTools: true,
        streamedUserFacingText: '',
        roundDisplayText: '',
      })
    ).toBe(false)
  })
})

describe('file inspection continuation', () => {
  it('treats multi-sentence let-me-grep narration as a bridge', () => {
    expect(
      isFileInspectionBridgeNarration(
        'The markup is fine. Now I need to see the toggle JavaScript — that is almost certainly where the binding fails. Let me grep the script portion narrowly.'
      )
    ).toBe(true)
  })

  it('does not treat a completed-fix claim as a bridge', () => {
    expect(
      isFileInspectionBridgeNarration('I fixed the Dark toggle by patching the click handler.')
    ).toBe(false)
  })

  it('forces a continuation after read/grep/artifact with no file write', () => {
    expect(
      shouldForceFileEditContinuation({
        postBuildToolMode: 'all',
        forcedFileEditContinuations: 0,
        maxForcedFileEditContinuations: MAX_FILE_EDIT_CONTINUATION_ROUNDS,
        round: 2,
        maxToolRounds: 10,
        hasFileInspectionTools: true,
        hasFileMutationTools: false,
        streamedUserFacingText:
          'The markup is fine. Now I need to see the toggle JavaScript. Let me grep the script portion narrowly.',
        roundDisplayText: '',
      })
    ).toBe(true)
  })

  it('allows multiple inspect-only continuations before giving up', () => {
    expect(MAX_FILE_EDIT_CONTINUATION_ROUNDS).toBeGreaterThanOrEqual(3)
    expect(
      shouldForceFileEditContinuation({
        postBuildToolMode: 'all',
        forcedFileEditContinuations: 2,
        maxForcedFileEditContinuations: MAX_FILE_EDIT_CONTINUATION_ROUNDS,
        round: 4,
        maxToolRounds: 20,
        hasFileInspectionTools: true,
        hasFileMutationTools: false,
        streamedUserFacingText: 'Let me read the rest of the standalone.',
        roundDisplayText: '',
      })
    ).toBe(true)
    expect(
      shouldForceFileEditContinuation({
        postBuildToolMode: 'all',
        forcedFileEditContinuations: MAX_FILE_EDIT_CONTINUATION_ROUNDS,
        maxForcedFileEditContinuations: MAX_FILE_EDIT_CONTINUATION_ROUNDS,
        round: 5,
        maxToolRounds: 20,
        hasFileInspectionTools: true,
        hasFileMutationTools: false,
        streamedUserFacingText: 'Let me read the rest of the standalone.',
        roundDisplayText: '',
      })
    ).toBe(false)
  })

  it('nudge tells the model to stop paging and apply one fat patch', () => {
    const message = buildFileEditContinuationMessage()
    expect(message).toMatch(/STOP paging/i)
    expect(message).toMatch(/workspace_file/i)
    expect(message).toMatch(/edit_content/i)
    expect(message).toMatch(/single fat edit|one targeted patch/i)
  })

  it('does not force after workspace_file / edit_content already ran', () => {
    expect(
      shouldForceFileEditContinuation({
        postBuildToolMode: 'all',
        forcedFileEditContinuations: 0,
        maxForcedFileEditContinuations: MAX_FILE_EDIT_CONTINUATION_ROUNDS,
        round: 2,
        maxToolRounds: 10,
        hasFileInspectionTools: true,
        hasFileMutationTools: true,
        streamedUserFacingText: '',
        roundDisplayText: '',
      })
    ).toBe(false)
  })

  it('load_copilot_artifact alone is file inspection, not workflow discovery', () => {
    const records: ToolTurnRecord[] = [
      { name: 'read', success: true, result: {} },
      { name: 'load_copilot_artifact', success: true, result: { content: '<html></html>' } },
    ]
    expect(turnHasFileInspectionTools(records)).toBe(true)
    expect(turnHasWorkflowDiscoveryTools(records)).toBe(false)
  })

  it('synthesizes a closing note when only file inspection ran', () => {
    expect(
      buildFileInspectionChatAppendix([
        { name: 'read', success: true, result: {} },
        { name: 'grep', success: true, result: {} },
        { name: 'load_copilot_artifact', success: true, result: {} },
      ])
    ).toMatch(/did not finish applying the fix/i)
  })
})

describe('synthesizeAssistantSummaryFromTools discovery-only', () => {
  it('explains when only block discovery tools ran', () => {
    expect(
      synthesizeAssistantSummaryFromTools([
        { name: 'get_available_blocks', success: true, result: { blocks: [] } },
        { name: 'get_blocks_metadata', success: true, result: { metadata: {} } },
      ])
    ).toMatch(/looked up the available blocks/i)
  })
})
