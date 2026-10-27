import { createLogger } from '@sim/logger'
import { type NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { checkInternalAuth } from '@/lib/auth/hybrid'
import { env } from '@/lib/core/config/env'
import { MAX_BUFFERED_TRANSFER_BYTES } from '@/lib/uploads/shared/types'
import { RawFileInputArraySchema, RawFileInputSchema } from '@/lib/uploads/utils/file-schemas'
import { processFilesToUserFiles } from '@/lib/uploads/utils/file-utils'
import { downloadServableFileFromStorage } from '@/lib/uploads/utils/file-utils.server'
import { UNIPILE_BASE_URL } from '@/tools/unipile/types'

const logger = createLogger('UnipileStartChatAPI')

/** Optional strings from workflows are often JSON `null`, not omitted. */
const optionalString = z.string().nullish()

const RequestSchema = z.object({
  account_id: z.string().min(1),
  text: z.string().min(1),
  attendees_ids: z.union([
    z
      .array(z.string().min(1))
      .min(1, { message: 'attendees_ids must include at least one attendee id' }),
    z
      .string()
      .transform((s) => s.trim())
      .refine((s) => s.length > 0, {
        message: 'attendees_ids is required (comma-separated relation / member ids)',
      }),
  ]),
  attachments: z.union([RawFileInputArraySchema, optionalString]).optional(),
  voice_message: z.union([RawFileInputSchema, optionalString]).optional(),
  video_message: z.union([RawFileInputSchema, optionalString]).optional(),
  subject: optionalString,
  api: optionalString,
  topic: optionalString,
  applicant_id: optionalString,
  invitation_id: optionalString,
  inmail: z.union([z.boolean(), z.string()]).nullish(),
  signature: optionalString,
  hiring_project_id: optionalString,
  job_posting_id: optionalString,
  sourcing_channel: optionalString,
  email_address: optionalString,
  visibility: optionalString,
  follow_up: optionalString,
})

function appendIfNonEmpty(form: FormData, key: string, value: string | null | undefined) {
  if (value == null || value.trim() === '') return
  form.append(key, value.trim())
}

function normalizeAttendeesIds(raw: string[] | string): string[] {
  if (Array.isArray(raw)) {
    return Array.from(new Set(raw.map((v) => v.trim()).filter((v) => v.length > 0)))
  }
  return Array.from(
    new Set(
      raw
        .split(',')
        .map((v) => v.trim())
        .filter((v) => v.length > 0)
    )
  )
}

/**
 * Proxies POST `/api/v1/chats` to Unipile as multipart form data.
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
    const data = RequestSchema.parse(body)

    const form = new FormData()
    form.append('account_id', data.account_id.trim())
    form.append('text', data.text)
    if (Array.isArray(data.attachments) && data.attachments.length > 0) {
      const attachmentFiles = processFilesToUserFiles(data.attachments, data.account_id, logger)
      for (const file of attachmentFiles) {
        const { buffer, contentType } = await downloadServableFileFromStorage(
          file,
          data.account_id,
          logger,
          { maxBytes: MAX_BUFFERED_TRANSFER_BYTES }
        )
        const blob = new Blob([new Uint8Array(buffer)], {
          type: contentType || file.type || 'application/octet-stream',
        })
        form.append('attachments', blob, file.name)
      }
    } else if (typeof data.attachments === 'string') {
      appendIfNonEmpty(form, 'attachments', data.attachments)
    }

    if (
      data.voice_message &&
      typeof data.voice_message === 'object' &&
      !Array.isArray(data.voice_message)
    ) {
      const [voiceFile] = processFilesToUserFiles([data.voice_message], data.account_id, logger)
      if (voiceFile) {
        const { buffer, contentType } = await downloadServableFileFromStorage(
          voiceFile,
          data.account_id,
          logger,
          { maxBytes: MAX_BUFFERED_TRANSFER_BYTES }
        )
        const blob = new Blob([new Uint8Array(buffer)], {
          type: contentType || voiceFile.type || 'application/octet-stream',
        })
        form.append('voice_message', blob, voiceFile.name)
      }
    } else if (typeof data.voice_message === 'string') {
      appendIfNonEmpty(form, 'voice_message', data.voice_message)
    }

    if (
      data.video_message &&
      typeof data.video_message === 'object' &&
      !Array.isArray(data.video_message)
    ) {
      const [videoFile] = processFilesToUserFiles([data.video_message], data.account_id, logger)
      if (videoFile) {
        const { buffer, contentType } = await downloadServableFileFromStorage(
          videoFile,
          data.account_id,
          logger,
          { maxBytes: MAX_BUFFERED_TRANSFER_BYTES }
        )
        const blob = new Blob([new Uint8Array(buffer)], {
          type: contentType || videoFile.type || 'application/octet-stream',
        })
        form.append('video_message', blob, videoFile.name)
      }
    } else if (typeof data.video_message === 'string') {
      appendIfNonEmpty(form, 'video_message', data.video_message)
    }

    const attendeesIds = normalizeAttendeesIds(data.attendees_ids)
    attendeesIds.forEach((attendeeId, index) => {
      form.append(`attendees_ids[${index}]`, attendeeId)
    })
    appendIfNonEmpty(form, 'subject', data.subject)

    const apiMode = (data.api ?? 'classic').trim()
    form.append('api', apiMode)

    if (apiMode === 'classic') {
      appendIfNonEmpty(form, 'topic', data.topic)
      appendIfNonEmpty(form, 'applicant_id', data.applicant_id)
      appendIfNonEmpty(form, 'invitation_id', data.invitation_id)
      if (data.inmail != null) {
        const flag =
          data.inmail === true ||
          (typeof data.inmail === 'string' && data.inmail.toLowerCase() === 'true')
        form.append('linkedin[inmail]', flag ? 'true' : 'false')
      }
    }

    if (apiMode === 'recruiter') {
      appendIfNonEmpty(form, 'signature', data.signature)
      appendIfNonEmpty(form, 'hiring_project_id', data.hiring_project_id)
      appendIfNonEmpty(form, 'job_posting_id', data.job_posting_id)
      appendIfNonEmpty(form, 'sourcing_channel', data.sourcing_channel)
      appendIfNonEmpty(form, 'email_address', data.email_address)
      appendIfNonEmpty(form, 'visibility', data.visibility)
      if (data.follow_up != null && data.follow_up.trim() !== '') {
        const trimmed = data.follow_up.trim()
        try {
          JSON.parse(trimmed)
        } catch {
          return NextResponse.json({ error: 'follow_up must be valid JSON' }, { status: 400 })
        }
        form.append('follow_up', trimmed)
      }
    }

    const url = `${baseUrl}/api/v1/chats`
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
      logger.warn('Unipile start chat failed', {
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
      logger.error('Unipile returned non-JSON for start chat')
      return NextResponse.json({ error: 'Invalid JSON from Unipile' }, { status: 502 })
    }

    return NextResponse.json(parsed)
  } catch (error) {
    const message = error instanceof z.ZodError ? error.message : 'Invalid request body'
    logger.warn('Unipile start chat validation failed', { error })
    return NextResponse.json({ error: message }, { status: 400 })
  }
}
