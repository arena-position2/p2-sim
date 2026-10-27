/**
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi } from 'vitest'
import { MothershipStreamV1SessionKind } from '@/lib/mothership/generated/mothership-stream-v1'
import type { PersistedStreamEventEnvelope } from '@/lib/mothership/request/session/contract'
import { handleSessionEvent } from '@/app/workspace/[workspaceId]/home/hooks/stream/handle-session-event'
import type { StreamLoopContext } from '@/app/workspace/[workspaceId]/home/hooks/stream/stream-context'
import { makeStreamLoopDeps } from '@/app/workspace/[workspaceId]/home/hooks/stream/stream-test-helpers'

function chatSessionEvent(chatId: string): PersistedStreamEventEnvelope {
  return {
    type: 'session',
    v: 1,
    seq: 1,
    ts: '2026-01-01T00:00:00Z',
    stream: { streamId: 'stream-1', chatId },
    payload: { kind: MothershipStreamV1SessionKind.chat, chatId },
  } as PersistedStreamEventEnvelope
}

describe('handleSessionEvent', () => {
  it('adopts a newly assigned chat before chatIdRef is written', () => {
    const deps = makeStreamLoopDeps()
    deps.workflowIdRef.current = 'workflow-1'
    vi.mocked(deps.adoptResolvedChatId).mockImplementation((chatId) => {
      expect(deps.chatIdRef.current).toBeUndefined()
      deps.chatIdRef.current = chatId
    })

    handleSessionEvent({ deps } as StreamLoopContext, chatSessionEvent('chat-new') as never)

    expect(deps.adoptResolvedChatId).toHaveBeenCalledWith('chat-new')
    expect(deps.chatIdRef.current).toBe('chat-new')
  })

  it('does not re-run provisional adoption for an existing chat', () => {
    const deps = makeStreamLoopDeps()
    deps.chatIdRef.current = 'chat-existing'
    deps.selectedChatIdRef.current = 'chat-existing'

    handleSessionEvent({ deps } as StreamLoopContext, chatSessionEvent('chat-existing') as never)

    expect(deps.adoptResolvedChatId).not.toHaveBeenCalled()
    expect(deps.setResolvedChatId).toHaveBeenCalledWith('chat-existing')
  })

  it('hands a new home chat off to the standard chat path and keeps the current search', () => {
    window.history.replaceState(null, '', '/workspace/ws-1/home?resource=wf-1')
    const deps = makeStreamLoopDeps()

    handleSessionEvent({ deps } as StreamLoopContext, chatSessionEvent('chat-new') as never)

    expect(window.location.pathname).toBe('/workspace/ws-1/chat/chat-new')
    expect(window.location.search).toBe('?resource=wf-1')
  })

  it('keeps a new embed chat on the task embed path so workspace chrome stays hidden', () => {
    window.history.replaceState(null, '', '/workspace/ws-1/task/embed?role=exec')
    const deps = makeStreamLoopDeps()
    deps.isEmbedPageRef.current = true

    handleSessionEvent({ deps } as StreamLoopContext, chatSessionEvent('chat-new') as never)

    expect(window.location.pathname).toBe('/workspace/ws-1/task/chat-new/embed')
    expect(window.location.search).toBe('?role=exec')
  })

  it('does not rewrite the URL when the session is already bound to a workflow', () => {
    window.history.replaceState(null, '', '/workspace/ws-1/home')
    const deps = makeStreamLoopDeps()
    deps.workflowIdRef.current = 'workflow-1'
    const hrefBefore = window.location.href

    handleSessionEvent({ deps } as StreamLoopContext, chatSessionEvent('chat-new') as never)

    expect(window.location.href).toBe(hrefBefore)
  })
})
