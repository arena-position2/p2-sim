import { createLogger } from '@sim/logger'
import { type NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { checkInternalAuth } from '@/lib/auth/hybrid'
import { env } from '@/lib/core/config/env'
import { MAX_BUFFERED_TRANSFER_BYTES } from '@/lib/uploads/shared/types'
import { processFilesToUserFiles } from '@/lib/uploads/utils/file'
import { downloadServableFileFromStorage } from '@/lib/uploads/utils/file.server'
import { RawFileInputArraySchema } from '@/lib/uploads/utils/file-schemas'
import { UNIPILE_BASE_URL } from '@/tools/unipile/types'

const logger = createLogger('UnipileSendChatMessageAPI')

/**
 * Drops top-level JSON `null` entries so optional fields are absent instead of `null` (Zod
 * `optional()` does not accept `null`; clients and merges often send explicit nulls).
 */
function omitJsonNullProperties(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return value
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== null)
  )
}

/** Accepts null/empty from clients; yields `undefined` so optional form fields are skipped safely. */
const optionalFormString = z.union([z.string(), z.null(), z.undefined()]).transform((v) => {
  if (v == null) return undefined
  const t = v.trim()
  return t === '' ? undefined : t
})

const RequestSchema = z.object({
  chat_id: z.string().min(1),
  text: z.string().min(1),
  account_id: z.string().min(1),
  thread_id: optionalFormString,
  quote_id: optionalFormString,
  attachments: z.union([RawFileInputArraySchema, z.string()]).optional(),
  typing_duration: optionalFormString,
})

function appendIfNonEmpty(form: FormData, key: string, value: string | undefined) {
  if (value !== undefined && value.trim() !== '') {
    form.append(key, value.trim())
  }
}

/**
 * Proxies POST `/api/v1/chats/{chat_id}/messages` to Unipile as multipart form data.
 */
export async function POST(request: NextRequest) {
  const authResult = await checkInternalAuth(request, { requireWorkflowId: false })
  if (!authResult.success) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const apiKey = env.UNIPILE_API_KEY?.trim()
  if (!apiKey) {
    return NextResponse.json({ error: 'UNIPILE_API_KEY is not configured' }, { status: 503 })
  }

  const baseUrl = UNIPILE_BASE_URL.replace(/\/$/, '')

  try {
    const body = await request.json()
    const data = RequestSchema.parse(omitJsonNullProperties(body))

    const form = new FormData()
    form.append('text', data.text)
    form.append('account_id', data.account_id.trim())
    appendIfNonEmpty(form, 'thread_id', data.thread_id)
    appendIfNonEmpty(form, 'quote_id', data.quote_id)
    if (Array.isArray(data.attachments) && data.attachments.length > 0) {
      const userFiles = processFilesToUserFiles(data.attachments, data.chat_id, logger)
      for (const userFile of userFiles) {
        const { buffer, contentType } = await downloadServableFileFromStorage(
          userFile,
          data.chat_id,
          logger,
          { maxBytes: MAX_BUFFERED_TRANSFER_BYTES }
        )
        const blob = new Blob([new Uint8Array(buffer)], {
          type: contentType || userFile.type || 'application/octet-stream',
        })
        form.append('attachments', blob, userFile.name)
      }
    } else if (typeof data.attachments === 'string') {
      appendIfNonEmpty(form, 'attachments', data.attachments)
    }
    appendIfNonEmpty(form, 'typing_duration', data.typing_duration)

    const encoded = encodeURIComponent(data.chat_id.trim())
    const url = `${baseUrl}/api/v1/chats/${encoded}/messages`

    const upstream = await fetch(url, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'X-API-KEY': apiKey,
      },
      body: form,
    })

    const responseText = await upstream.text()
    if (!upstream.ok) {
      logger.warn('Unipile send chat message failed', {
        status: upstream.status,
        snippet: responseText.slice(0, 500),
      })
      return NextResponse.json(
        { error: responseText || upstream.statusText || 'Unipile request failed' },
        { status: upstream.status }
      )
    }

    let parsed: unknown
    try {
      parsed = JSON.parse(responseText) as unknown
    } catch {
      logger.error('Unipile returned non-JSON for send chat message')
      return NextResponse.json({ error: 'Invalid JSON from Unipile' }, { status: 502 })
    }

    return NextResponse.json(parsed)
  } catch (error) {
    const message = error instanceof z.ZodError ? error.message : 'Invalid request body'
    logger.warn('Unipile send chat message validation failed', { error })
    return NextResponse.json({ error: message }, { status: 400 })
  }
}
