'use client'

type SessionRequiredContentProps = {
  arenaUrl: string | undefined
}

export function SessionRequiredContent({ arenaUrl }: SessionRequiredContentProps) {
  return (
    <div className='flex min-h-screen flex-col items-center justify-center gap-6 p-8'>
      <div className='flex max-w-md flex-col items-center gap-3 text-center'>
        <h1 className='font-semibold text-xl tracking-tight'>You need to sign in again</h1>
        <p className='text-muted-foreground text-sm leading-relaxed'>
          There is no active session for this app. Sign in from Arena, then open the agent again.
        </p>
      </div>
      {arenaUrl ? (
        <a
          href={arenaUrl}
          rel='noopener noreferrer'
          className='inline-flex items-center justify-center rounded-[5px] bg-[var(--text-primary)] px-2 py-1.5 text-[12px] text-[var(--text-inverse)]'
        >
          Back to Arena
        </a>
      ) : (
        <p className='text-muted-foreground text-xs'>
          Configure{' '}
          <code className='rounded bg-muted px-1 py-0.5'>NEXT_PUBLIC_ARENA_FRONTEND_APP_URL</code>{' '}
          to enable the return link.
        </p>
      )}
    </div>
  )
}
