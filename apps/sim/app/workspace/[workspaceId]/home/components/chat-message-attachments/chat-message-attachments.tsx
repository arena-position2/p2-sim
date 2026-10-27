import { ChipTag, cn, Lightbox, OverflowText } from '@sim/emcn'
import { getDocumentIcon } from '@/components/icons/document-icons'
import type { ChatMessageAttachment } from '@/app/workspace/[workspaceId]/home/types'
import {
  downloadImage,
  ImageWithViewFullOverlay,
} from '@/app/workspace/[workspaceId]/w/[workflowId]/components/chat/components/chat-message/constants'

function FileAttachmentPill(props: { mediaType: string; filename: string }) {
  const Icon = getDocumentIcon(props.mediaType, props.filename)
  return (
    <ChipTag variant='mono' leftIcon={Icon} className='max-w-[140px]'>
      <OverflowText label={props.filename} />
    </ChipTag>
  )
}

export function ChatMessageAttachments(props: {
  attachments: ChatMessageAttachment[]
  align?: 'start' | 'end'
  className?: string
  onImageSelect?: (attachment: ChatMessageAttachment, index: number) => void
  selectedImageIds?: Set<string>
}) {
  const { attachments, align = 'end', className, onImageSelect, selectedImageIds } = props

  if (!attachments.length) return null

  return (
    <div
      className={cn(
        'flex flex-wrap gap-[6px]',
        align === 'end' ? 'justify-end' : 'justify-start',
        className
      )}
    >
      {attachments.map((att, index) => {
        const isImage = att.media_type.startsWith('image/')
        const isSelected = selectedImageIds?.has(att.id) ?? false
        if (isImage && att.previewUrl) {
          return (
            <ImageWithViewFullOverlay
              key={att.id}
              src={att.previewUrl}
              wrapperClassName={
                isSelected
                  ? 'h-[120px] w-[120px] overflow-hidden rounded-[8px] border border-[var(--selection)] bg-[var(--surface-5)] ring-1 ring-[var(--selection)] transition-[border-color,box-shadow]'
                  : 'h-[120px] w-[120px] overflow-hidden rounded-[8px] border border-[var(--border-1)] bg-[var(--surface-5)] transition-[border-color,box-shadow]'
              }
              onDownload={() => downloadImage(false, undefined, att.previewUrl)}
              onSelect={onImageSelect ? () => onImageSelect(att, index) : undefined}
              selectLabel={onImageSelect ? (isSelected ? 'Selected' : 'Select') : undefined}
              compactActions
            >
              <img src={att.previewUrl} alt={att.filename} className='h-full w-full object-cover' />
            </ImageWithViewFullOverlay>
          )
        }
        if (!att.previewUrl) {
          return (
            <FileAttachmentPill key={att.id} mediaType={att.media_type} filename={att.filename} />
          )
        }
        const isVideo = att.media_type.startsWith('video/')
        if (isVideo) {
          const Icon = getDocumentIcon(att.media_type, att.filename)
          return (
            <div
              key={att.id}
              className='relative size-[56px] overflow-hidden rounded-lg bg-[var(--surface-5)]'
            >
              <div className='absolute inset-0 flex items-center justify-center text-[var(--text-icon)]'>
                <Icon className='size-[18px]' />
              </div>
              <video
                src={att.previewUrl}
                muted
                playsInline
                preload='metadata'
                className='relative size-full object-cover'
              />
            </div>
          )
        }
        return (
          <Lightbox key={att.id} src={att.previewUrl} alt={att.filename}>
            <button
              type='button'
              aria-label={`Preview ${att.filename}`}
              className='size-[56px] cursor-pointer overflow-hidden rounded-lg'
            >
              <img src={att.previewUrl} alt={att.filename} className='size-full object-cover' />
            </button>
          </Lightbox>
        )
      })}
    </div>
  )
}
