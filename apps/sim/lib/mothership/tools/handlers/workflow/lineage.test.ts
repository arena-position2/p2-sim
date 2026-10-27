/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import { buildCopilotWorkflowLineageOptions } from '@/lib/mothership/tools/handlers/workflow/lineage'

describe('buildCopilotWorkflowLineageOptions', () => {
  it('passes triggering ids for standalone copilot chat runs', () => {
    expect(
      buildCopilotWorkflowLineageOptions({
        userId: 'user-1',
        workflowId: 'wf-1',
        chatId: 'chat-1',
        runId: 'run-1',
        executionId: 'copilot-exec-1',
      })
    ).toEqual({
      triggeringChatId: 'chat-1',
      triggeringRunId: 'run-1',
    })
  })

  it('passes parent execution for in-workflow mothership runs', () => {
    expect(
      buildCopilotWorkflowLineageOptions({
        userId: 'user-1',
        workflowId: 'wf-1',
        chatId: 'chat-1',
        executionId: 'hosting-exec-1',
      })
    ).toEqual({
      triggeringChatId: 'chat-1',
      parentExecutionId: 'hosting-exec-1',
    })
  })
})
