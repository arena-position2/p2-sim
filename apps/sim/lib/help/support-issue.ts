import { db } from '@sim/db'
import { type HelpSupportIssueAttachment, helpSupportIssue } from '@sim/db/schema'
import type { HelpFormBody } from '@/lib/api/contracts/common'
import { StorageService } from '@/lib/uploads'
import { sanitizeFileName } from '@/executor/constants'

const HELP_SUPPORT_STORAGE_CONTEXT = 'workspace' as const

/** Presigned S3 (or app serve) URLs remain valid long enough for support triage. */
const ATTACHMENT_URL_TTL_SECONDS = 7 * 24 * 60 * 60

export type HelpSupportIssueType = HelpFormBody['type']

interface HelpSupportImageInput {
  filename: string
  content: Buffer
  contentType: string
}

interface PersistHelpSupportIssueInput {
  id: string
  userId?: string | null
  userEmail: string
  workspaceId?: string | null
  workflowId?: string | null
  type: HelpSupportIssueType
  subject: string
  message: string
  attachments: HelpSupportIssueAttachment[]
}

/**
 * Upload help-support images to object storage and return viewable URLs for email + DB.
 */
export async function uploadHelpSupportAttachments(
  issueId: string,
  images: HelpSupportImageInput[]
): Promise<HelpSupportIssueAttachment[]> {
  const attachments: HelpSupportIssueAttachment[] = []

  for (let index = 0; index < images.length; index++) {
    const image = images[index]
    const safeName = sanitizeFileName(image.filename)
    const storageKey = `help-support/${issueId}/${index}-${safeName}`

    await StorageService.uploadFile({
      file: image.content,
      fileName: safeName,
      contentType: image.contentType,
      context: HELP_SUPPORT_STORAGE_CONTEXT,
      preserveKey: true,
      customKey: storageKey,
    })

    const fileUrl = await StorageService.generatePresignedDownloadUrl(
      storageKey,
      HELP_SUPPORT_STORAGE_CONTEXT,
      ATTACHMENT_URL_TTL_SECONDS
    )

    attachments.push({
      filename: image.filename,
      content_type: image.contentType,
      file_url: fileUrl,
      storage_key: storageKey,
    })
  }

  return attachments
}

export async function persistHelpSupportIssue(input: PersistHelpSupportIssueInput): Promise<void> {
  if (!input.userId) {
    throw new Error('Help support issue requires a signed-in user')
  }
  await db.insert(helpSupportIssue).values({
    id: input.id,
    userId: input.userId,
    userEmail: input.userEmail,
    workspaceId: input.workspaceId ?? null,
    workflowId: input.workflowId ?? null,
    type: input.type,
    subject: input.subject,
    message: input.message,
    attachments: input.attachments,
  })
}

export function formatHelpSupportAttachmentLinks(
  attachments: HelpSupportIssueAttachment[]
): string {
  if (attachments.length === 0) {
    return ''
  }

  const lines = attachments.map(
    (attachment, index) => `${index + 1}. ${attachment.filename}: ${attachment.file_url}`
  )

  return `\n\nAttachments (${attachments.length}):\n${lines.join('\n')}`
}
