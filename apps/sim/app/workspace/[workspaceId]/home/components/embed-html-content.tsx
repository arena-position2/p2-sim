'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { getErrorMessage } from '@sim/utils/errors'
import { useSession } from '@/lib/auth/client'

interface EmbedHtmlContentProps {
  persona?: string
  userId?: string
  email?: string | null
}

export function EmbedHtmlContent({ persona, userId, email }: EmbedHtmlContentProps = {}) {
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const [iframeHeight, setIframeHeight] = useState(900)
  const [reloadToken, setReloadToken] = useState(0)
  const { data: session, isPending: isSessionPending } = useSession()

  const resolvedUserId = userId ?? session?.user?.id
  const resolvedEmail = email ?? session?.user?.email

  const syncIframeHeight = useCallback(() => {
    const iframe = iframeRef.current
    const doc = iframe?.contentDocument
    if (!doc) return
    const nextHeight = Math.max(
      doc.documentElement?.scrollHeight ?? 0,
      doc.body?.scrollHeight ?? 0,
      900
    )
    setIframeHeight(nextHeight)
  }, [])

  const handleIframeLoad = useCallback(() => {
    syncIframeHeight()

    const iframe = iframeRef.current
    const doc = iframe?.contentDocument
    if (!doc) return

    const resizeObserver = new ResizeObserver(() => syncIframeHeight())
    resizeObserver.observe(doc.documentElement)
    if (doc.body) resizeObserver.observe(doc.body)

    iframe.dataset.resizeObserverAttached = 'true'
    ;(iframe as HTMLIFrameElement & { _resizeObserver?: ResizeObserver })._resizeObserver =
      resizeObserver
  }, [syncIframeHeight])

  const [htmlContent, setHtmlContent] = useState<string | null>(null)
  const [isLoadingHtml, setIsLoadingHtml] = useState(true)
  const [htmlError, setHtmlError] = useState<string | null>(null)

  useEffect(() => {
    if (isSessionPending) {
      setIsLoadingHtml(true)
      return
    }

    if (!resolvedUserId) {
      setIsLoadingHtml(false)
      setHtmlError('Sign in required to load the live dashboard.')
      setHtmlContent(null)
      return
    }

    const controller = new AbortController()

    async function loadEmbedHtml() {
      setIsLoadingHtml(true)
      setHtmlError(null)
      try {
        // boundary-raw-fetch: embed HTML payload is rendered via iframe srcDoc; not a typed JSON contract consumer
        const response = await fetch('/api/workflows/embed-html', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify({
            ...(persona ? { persona } : {}),
          }),
          signal: controller.signal,
        })

        if (!response.ok) {
          const payload = (await response.json().catch(() => null)) as { error?: string } | null
          throw new Error(
            payload?.error?.trim() || `Failed to load embedded HTML (${response.status})`
          )
        }

        const payload = (await response.json()) as { html?: string }
        if (typeof payload.html !== 'string' || payload.html.trim().length === 0) {
          throw new Error('Embedded HTML response missing html content')
        }

        setHtmlContent(payload.html)
      } catch (error) {
        if (controller.signal.aborted) return
        setHtmlError(getErrorMessage(error, 'Failed to load embedded HTML'))
      } finally {
        if (!controller.signal.aborted) {
          setIsLoadingHtml(false)
        }
      }
    }

    void loadEmbedHtml()
    return () => controller.abort()
  }, [reloadToken, persona, resolvedUserId, resolvedEmail, isSessionPending])

  return (
    <div className='mx-auto w-full px-4 pb-8 sm:px-6 lg:px-10'>
      {isLoadingHtml && (
        <div className='flex w-full flex-col items-center space-y-4 rounded-[12px] border border-[var(--border)] bg-[var(--surface)] p-5 text-center'>
          <div className='flex items-center justify-center gap-3'>
            <div className='h-4 w-4 animate-spin rounded-full border-2 border-[var(--border)] border-t-[var(--text-secondary)]' />
            <p className='text-[var(--text-secondary)] text-sm'>
              Building your live executive dashboard...
            </p>
          </div>
          <div className='w-full space-y-3'>
            <div className='mx-auto h-5 w-2/5 animate-pulse rounded bg-[var(--surface-tertiary)]' />
            <div className='grid grid-cols-1 gap-3 text-left md:grid-cols-3'>
              <div className='h-24 animate-pulse rounded-[10px] bg-[var(--surface-tertiary)]' />
              <div className='h-24 animate-pulse rounded-[10px] bg-[var(--surface-tertiary)]' />
              <div className='h-24 animate-pulse rounded-[10px] bg-[var(--surface-tertiary)]' />
            </div>
            <div className='h-56 animate-pulse rounded-[10px] bg-[var(--surface-tertiary)]' />
          </div>
        </div>
      )}

      {!isLoadingHtml && htmlError && (
        <div className='rounded-[12px] border border-[var(--border)] bg-[var(--surface)] p-5'>
          <p className='text-[var(--text-primary)] text-sm'>Could not load the live dashboard.</p>
          <p className='mt-1 text-[var(--text-secondary)] text-xs'>{htmlError}</p>
          <button
            type='button'
            onClick={() => setReloadToken((current) => current + 1)}
            className='mt-3 rounded-[8px] border border-[var(--border)] px-3 py-1.5 text-[var(--text-primary)] text-sm hover:bg-[var(--surface-hover)]'
          >
            Retry
          </button>
        </div>
      )}

      {!isLoadingHtml && !htmlError && htmlContent && (
        <iframe
          ref={iframeRef}
          title='Embedded HTML content'
          srcDoc={htmlContent}
          sandbox='allow-same-origin'
          onLoad={handleIframeLoad}
          style={{ height: `${iframeHeight}px` }}
          className='w-full rounded-[10px] border border-[var(--border)] bg-[var(--surface)]'
        />
      )}
    </div>
  )
}
