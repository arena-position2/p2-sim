import { createLogger } from '@sim/logger'
import { type NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { checkInternalAuth } from '@/lib/auth/hybrid'
import { env } from '@/lib/core/config/env'
import { MAX_BUFFERED_TRANSFER_BYTES } from '@/lib/uploads/shared/types'
import { processFilesToUserFiles } from '@/lib/uploads/utils/file'
import { downloadServableFileFromStorage } from '@/lib/uploads/utils/file.server'
import { RawFileInputArraySchema } from '@/lib/uploads/utils/file-schemas'
import {
  appendUnipileLinkedinMentionsMultipartPart,
  mentionsToUnipileApiJson,
  parseLinkedinMentionsJson,
  type UnipileLinkedinMentionEntry,
} from '@/tools/unipile/linkedin_mentions_formdata'
import { normalizeUnipilePostPathId } from '@/tools/unipile/normalize_post_path_id'
import { UNIPILE_BASE_URL } from '@/tools/unipile/types'

const logger = createLogger('UnipileCommentPostAPI')

const optionalString = z.string().nullish()

const RequestSchema = z.object({
  post_id: z.string().min(1),
  account_id: z.string().min(1),
  text: z.string().min(1).max(1250),
  mentions: optionalString,
  name: optionalString,
  profile_id: optionalString,
  is_company: optionalString,
  external_link: optionalString,
  as_organization: optionalString,
  comment_id: optionalString,
  attachments: z.union([RawFileInputArraySchema, z.string()]).optional().nullable(),
})

function appendIfNonEmpty(form: FormData, key: string, value: string | null | undefined) {
  if (value == null || value.trim() === '') return
  form.append(key, value.trim())
}

/**
 * Drops JSON `null` so Zod optional unions do not fail on explicit nulls from merged tool params.
 */
function omitJsonNullProperties(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return value
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== null)
  )
}

/**
 * Proxies POST `/api/v1/posts/{post_id}/comments` to Unipile.
 *
 * @remarks
 * When there are **no** binary `attachments`, sends `application/json` so `mentions` is a real
 * JSON array (matches Unipile docs). With file uploads, uses `multipart/form-data` and a
 * `mentions` part as `application/json` (not a stringified array in a plain text field).
 *
 * @see https://developer.unipile.com/reference/postscontroller_sendcomment
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

    let mentionsPayload: UnipileLinkedinMentionEntry[] | null = null
    if (data.mentions != null && data.mentions.trim() !== '') {
      const parsed = parseLinkedinMentionsJson(data.mentions)
      if (!parsed.ok) {
        return NextResponse.json({ error: parsed.error }, { status: 400 })
      }
      mentionsPayload = parsed.entries
    } else if (
      data.name != null &&
      data.name.trim() !== '' &&
      data.profile_id != null &&
      data.profile_id.trim() !== ''
    ) {
      const entry: UnipileLinkedinMentionEntry = {
        name: data.name.trim(),
        profile_id: data.profile_id.trim(),
      }
      if (data.is_company === 'true') entry.is_company = true
      if (data.is_company === 'false') entry.is_company = false
      mentionsPayload = [entry]
    }

    const hasBinaryAttachments = Array.isArray(data.attachments) && data.attachments.length > 0
    const hasLegacyAttachmentString =
      typeof data.attachments === 'string' && data.attachments.trim() !== ''
    const useJsonBody = !hasBinaryAttachments && !hasLegacyAttachmentString

    const postId = normalizeUnipilePostPathId(data.post_id)
    if (!postId) {
      return NextResponse.json({ error: 'post_id is empty after normalization' }, { status: 400 })
    }
    const encoded = encodeURIComponent(postId)
    const url = `${baseUrl}/api/v1/posts/${encoded}/comments`

    const commonHeaders = {
      accept: 'application/json',
      'X-API-KEY': apiKey,
    } as const

    let upstream: Response

    if (useJsonBody) {
      const jsonBody: Record<string, unknown> = {
        account_id: data.account_id.trim(),
        text: data.text,
      }
      if (mentionsPayload && mentionsPayload.length > 0) {
        jsonBody.mentions = mentionsToUnipileApiJson(mentionsPayload)
      }
      if (data.external_link != null && data.external_link.trim() !== '') {
        const link = data.external_link.trim()
        if (!/^https?:\/\//i.test(link)) {
          return NextResponse.json(
            { error: 'external_link must start with http:// or https://' },
            { status: 400 }
          )
        }
        jsonBody.external_link = link
      }
      if (data.as_organization != null && data.as_organization.trim() !== '') {
        jsonBody.as_organization = data.as_organization.trim()
      }
      if (data.comment_id != null && data.comment_id.trim() !== '') {
        jsonBody.comment_id = data.comment_id.trim()
      }

      upstream = await fetch(url, {
        method: 'POST',
        headers: {
          ...commonHeaders,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(jsonBody),
      })
    } else {
      const form = new FormData()
      form.append('account_id', data.account_id.trim())
      form.append('text', data.text)
      if (mentionsPayload && mentionsPayload.length > 0) {
        appendUnipileLinkedinMentionsMultipartPart(form, mentionsPayload)
      }

      if (data.external_link != null && data.external_link.trim() !== '') {
        const link = data.external_link.trim()
        if (!/^https?:\/\//i.test(link)) {
          return NextResponse.json(
            { error: 'external_link must start with http:// or https://' },
            { status: 400 }
          )
        }
        form.append('external_link', link)
      }

      appendIfNonEmpty(form, 'as_organization', data.as_organization)
      appendIfNonEmpty(form, 'comment_id', data.comment_id)
      if (hasBinaryAttachments && Array.isArray(data.attachments)) {
        const files = processFilesToUserFiles(data.attachments, data.account_id.trim(), logger)
        for (const userFile of files) {
          const { buffer, contentType } = await downloadServableFileFromStorage(
            userFile,
            data.account_id.trim(),
            logger,
            { maxBytes: MAX_BUFFERED_TRANSFER_BYTES }
          )
          const blob = new Blob([new Uint8Array(buffer)], {
            type: contentType || userFile.type || 'application/octet-stream',
          })
          form.append('attachments', blob, userFile.name)
        }
      } else if (hasLegacyAttachmentString && typeof data.attachments === 'string') {
        appendIfNonEmpty(form, 'attachments', data.attachments)
      }

      upstream = await fetch(url, {
        method: 'POST',
        headers: commonHeaders,
        body: form,
      })
    }

    const responseText = await upstream.text()
    if (!upstream.ok) {
      logger.warn('Unipile comment post failed', {
        status: upstream.status,
        snippet: responseText.slice(0, 500),
      })
      return NextResponse.json(
        { error: responseText || upstream.statusText || 'Unipile request failed' },
        { status: upstream.status }
      )
    }

    try {
      return NextResponse.json(JSON.parse(responseText) as unknown)
    } catch {
      logger.error('Unipile returned non-JSON for comment post')
      return NextResponse.json({ error: 'Invalid JSON from Unipile' }, { status: 502 })
    }
  } catch (error) {
    const message = error instanceof z.ZodError ? error.message : 'Invalid request body'
    logger.warn('Unipile comment post validation failed', { error })
    return NextResponse.json({ error: message }, { status: 400 })
  }
}
