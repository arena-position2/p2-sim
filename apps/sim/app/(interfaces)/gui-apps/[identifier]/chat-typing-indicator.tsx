'use client'

/**
 * Host-owned Chat wait chrome. Three bouncing dots on the assistant side
 * while the bound action is in flight and no tokens have arrived yet.
 */
export function ChatTypingIndicator() {
  return (
    <div
      role='status'
      aria-live='polite'
      aria-busy='true'
      data-testid='generative-chat-typing'
      className='flex h-5 items-center'
    >
      <span className='sr-only'>Assistant is typing</span>
      <div className='flex space-x-0.5' aria-hidden>
        <span className='size-1 animate-bounce rounded-full bg-(--gui-text-muted,#575a66) [animation-delay:0ms] animation-duration-[1.2s]' />
        <span className='size-1 animate-bounce rounded-full bg-(--gui-text-muted,#575a66) [animation-delay:150ms] animation-duration-[1.2s]' />
        <span className='size-1 animate-bounce rounded-full bg-(--gui-text-muted,#575a66) [animation-delay:300ms] animation-duration-[1.2s]' />
      </div>
    </div>
  )
}
