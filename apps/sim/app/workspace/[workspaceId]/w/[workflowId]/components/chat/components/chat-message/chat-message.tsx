import { useCallback, useMemo, useState } from 'react'
import { Tooltip } from '@sim/emcn'
import { Check, Copy } from 'lucide-react'
import {
  resolveEChartsOptionsFromContent,
  stripEChartsJsonFromContent,
  stripIncompleteTrailingChartJson,
} from '@/lib/chart-generation/echarts-option'
import type { AssistantChatFile, AssistantGeneratedImage } from '@/lib/chat/assistant-assets'
import { resolveSelectableGeneratedImage } from '@/lib/chat/assistant-assets'
import { ChatEChartsRenderer } from '@/app/(interfaces)/chat/components/message/components/chat-echarts-renderer'
import { ChatFileDownload } from '@/app/(interfaces)/chat/components/message/components/file-download'
import { StreamingIndicator } from '@/app/(interfaces)/chat/components/message/components/streaming-indicator'
import { ChatMessageAttachments } from '@/app/workspace/[workspaceId]/home/components/chat-message-attachments'
import type { ChatMessageAttachment } from '@/app/workspace/[workspaceId]/home/types'
import ArenaCopilotMarkdownRenderer from '@/app/workspace/[workspaceId]/w/[workflowId]/components/panel/components/copilot/components/copilot-message/components/arena-markdown-renderer'
import { useThrottledValue } from '@/hooks/use-throttled-value'
import {
  extractBase64Image,
  getImageUrlFromContent,
  hasBase64Images,
  isBase64,
  isRenderableImageUrl,
  mergeToolOutputImageUrls,
  normalizeImageUrlForCompare,
  renderBs64Img,
  renderChatMessageImage,
  resolveMessageImagesAndProse,
  S3UploadFailedAlert,
} from './constants'

interface ChatMessageProps {
  message: {
    id: string
    content: any
    timestamp: string | Date
    type: 'user' | 'workflow'
    isStreaming?: boolean
    attachments?: ChatMessageAttachment[]
    files?: AssistantChatFile[]
    generatedImages?: AssistantGeneratedImage[]
  }
  onToggleGeneratedImage?: (
    messageId: string,
    image: {
      id: string
      name: string
      url: string
      key?: string
      type: string
      size?: number
      context?: string
    }
  ) => void
  onToggleUserAttachmentImage?: (messageId: string, attachment: ChatMessageAttachment) => void
  selectedGeneratedImageIds?: Set<string>
}

const MAX_WORD_LENGTH = 25

/**
 * Component for wrapping long words to prevent overflow
 */
const WordWrap = ({ text }: { text: string }) => {
  if (!text) return null

  const parts = text.split(/(\s+)/g)

  return (
    <>
      {parts.map((part, index) => {
        if (part.match(/\s+/) || part.length <= MAX_WORD_LENGTH) {
          return <span key={index}>{part}</span>
        }

        const chunks = []
        for (let i = 0; i < part.length; i += MAX_WORD_LENGTH) {
          chunks.push(part.substring(i, i + MAX_WORD_LENGTH))
        }

        return (
          <span key={index} className='break-all'>
            {chunks.map((chunk, chunkIndex) => (
              <span key={chunkIndex}>{chunk}</span>
            ))}
          </span>
        )
      })}
    </>
  )
}

const RenderButtons = ({
  message,
  formattedContent,
}: {
  message: ChatMessageProps['message']
  formattedContent: string
}) => {
  const [isCopied, setIsCopied] = useState<boolean>(false)

  const handleCopy = () => {
    const contentToCopy =
      typeof formattedContent === 'string'
        ? formattedContent
        : JSON.stringify(formattedContent, null, 2)
    navigator.clipboard.writeText(contentToCopy)
    setIsCopied(true)
    setTimeout(() => setIsCopied(false), 2000)
  }

  const containsBase64Images = hasBase64Images(message?.content)
  const hasImageUrl = !!getImageUrlFromContent(message?.content)

  return (
    <>
      {!message.isStreaming && (
        <div className='mt-2 flex items-center gap-2'>
          {!containsBase64Images && !hasImageUrl && (
            <Tooltip.Provider>
              <Tooltip.Root delayDuration={300}>
                <Tooltip.Trigger asChild>
                  <button
                    className='text-muted-foreground transition-colors hover:bg-muted'
                    onClick={() => {
                      handleCopy()
                    }}
                  >
                    {isCopied ? (
                      <Check className='h-4 w-4' strokeWidth={2} />
                    ) : (
                      <Copy className='h-4 w-4' strokeWidth={2} />
                    )}
                  </button>
                </Tooltip.Trigger>
                <Tooltip.Content side='top' align='center' sideOffset={5}>
                  {isCopied ? 'Copied!' : 'Copy to clipboard'}
                </Tooltip.Content>
              </Tooltip.Root>
            </Tooltip.Provider>
          )}
        </div>
      )}
    </>
  )
}

/**
 * Renders a chat message with optional file attachments
 */
export function ChatMessage({
  message,
  onToggleGeneratedImage,
  onToggleUserAttachmentImage,
  selectedGeneratedImageIds,
}: ChatMessageProps) {
  const rawContent = useMemo(() => {
    if (typeof message.content === 'object' && message.content !== null) {
      return JSON.stringify(message.content, null, 2)
    }
    return String(message.content || '')
  }, [message.content])

  const throttled = useThrottledValue(rawContent)
  const formattedContent = message.type === 'user' ? rawContent : throttled
  const generatedImagesByUrl = useMemo(() => {
    const entries = (message.generatedImages ?? []).map(
      (image): [string, AssistantGeneratedImage] => [normalizeImageUrlForCompare(image.url), image]
    )
    return new Map(entries)
  }, [message.generatedImages])

  // While streaming, hide a partially received trailing chart JSON payload so
  // raw JSON never flashes as text; the chart renders once its payload completes.
  const displayContent = useMemo(() => {
    if (message.isStreaming && typeof message.content === 'string') {
      return stripIncompleteTrailingChartJson(message.content)
    }
    return message.content
  }, [message.content, message.isStreaming])

  const messageChartOptions = useMemo(
    () => resolveEChartsOptionsFromContent(displayContent),
    [displayContent]
  )

  const getGeneratedImageSelectionProps = useCallback(
    (imageUrl?: string) => {
      if (!imageUrl || !onToggleGeneratedImage) {
        return {}
      }

      const matchedImage = resolveSelectableGeneratedImage(imageUrl, generatedImagesByUrl)
      if (!matchedImage) {
        return {}
      }

      const isSelected = selectedGeneratedImageIds?.has(matchedImage.id) ?? false

      return {
        onSelect: () =>
          onToggleGeneratedImage(message.id, {
            id: matchedImage.id,
            name: matchedImage.name || 'Generated image',
            url: matchedImage.url,
            key: matchedImage.key,
            type: matchedImage.type,
            size: matchedImage.size,
            context: matchedImage.context,
          }),
        selectLabel: isSelected ? 'Selected' : 'Select',
        isSelected,
      }
    },
    [generatedImagesByUrl, message.id, onToggleGeneratedImage, selectedGeneratedImageIds]
  )

  const renderMarkdownImage = useCallback(
    ({ src }: { src: string; alt?: string }) =>
      renderChatMessageImage(src, getGeneratedImageSelectionProps(src)),
    [getGeneratedImageSelectionProps]
  )

  if (message.type === 'user') {
    const hasAttachments = message.attachments && message.attachments.length > 0
    return (
      <div className='w-full max-w-full overflow-hidden opacity-100 transition-opacity duration-200'>
        {hasAttachments && (
          <ChatMessageAttachments
            attachments={message.attachments!}
            align='start'
            className='mb-[4px]'
            onImageSelect={
              onToggleUserAttachmentImage
                ? (attachment) => onToggleUserAttachmentImage(message.id, attachment)
                : undefined
            }
            selectedImageIds={selectedGeneratedImageIds}
          />
        )}

        {formattedContent && !formattedContent.startsWith('Uploaded') && (
          <div className='rounded-[4px] border border-[var(--border-1)] bg-[var(--surface-5)] px-[8px] py-[6px] transition-all duration-200'>
            <div className='whitespace-pre-wrap break-words font-sans text-[var(--text-primary)] text-sm leading-[1.25rem]'>
              <WordWrap text={formattedContent} />
            </div>
          </div>
        )}
      </div>
    )
  }

  const renderContent = (content: unknown) => {
    if (!content) {
      return null
    }

    if (content === displayContent && messageChartOptions) {
      const prose = typeof content === 'string' ? stripEChartsJsonFromContent(content) : ''
      return (
        <>
          {prose ? (
            <ArenaCopilotMarkdownRenderer content={prose} renderImage={renderMarkdownImage} />
          ) : null}
          {messageChartOptions.map((option, index) => (
            <ChatEChartsRenderer key={index} option={option} />
          ))}
        </>
      )
    }

    try {
      if (typeof content === 'object' && content !== null) {
        const o = content as Record<string, unknown>
        const imgRaw = typeof o.image === 'string' ? o.image : ''
        const txtRaw = typeof o.content === 'string' ? o.content : ''

        const imageBase64 =
          imgRaw.trim() && isBase64(imgRaw) && !isRenderableImageUrl(imgRaw)
            ? imgRaw.replace(/\s+/g, '')
            : ''

        const { uniqueUrls, prose: proseWithoutUrlLines } = mergeToolOutputImageUrls(
          imgRaw,
          txtRaw,
          o.images
        )
        const proseTrim = proseWithoutUrlLines.trim()
        const txtTrim = txtRaw.trim()

        const showS3 = o.s3UploadFailed === true && (uniqueUrls.length > 0 || Boolean(imageBase64))

        if (uniqueUrls.length > 0 || imageBase64) {
          return (
            <>
              {proseTrim ? (
                <ArenaCopilotMarkdownRenderer
                  content={proseTrim}
                  renderImage={renderMarkdownImage}
                />
              ) : null}
              {showS3 && <S3UploadFailedAlert />}
              {uniqueUrls.map((url) => (
                <div key={normalizeImageUrlForCompare(url)} className='w-full'>
                  {renderBs64Img({
                    isBase64: false,
                    imageData: '',
                    imageUrl: url,
                    ...getGeneratedImageSelectionProps(url),
                  })}
                </div>
              ))}
              {imageBase64 && (
                <div className='w-full'>
                  {renderBs64Img({
                    isBase64: true,
                    imageData: imageBase64,
                    ...getGeneratedImageSelectionProps(imgRaw),
                  })}
                </div>
              )}
            </>
          )
        }

        if (txtTrim) {
          return (
            <ArenaCopilotMarkdownRenderer content={txtTrim} renderImage={renderMarkdownImage} />
          )
        }

        return (
          <ArenaCopilotMarkdownRenderer
            content={JSON.stringify(content, null, 2)}
            renderImage={renderMarkdownImage}
          />
        )
      }

      if (typeof content === 'string') {
        const { urls, prose } = resolveMessageImagesAndProse(content)
        if (urls.length > 0) {
          return (
            <>
              {prose ? (
                <ArenaCopilotMarkdownRenderer content={prose} renderImage={renderMarkdownImage} />
              ) : null}
              {urls.map((url) => (
                <div key={normalizeImageUrlForCompare(url)} className='w-full'>
                  {renderBs64Img({
                    isBase64: false,
                    imageData: '',
                    imageUrl: url,
                    ...getGeneratedImageSelectionProps(url),
                  })}
                </div>
              ))}
            </>
          )
        }
      }

      if (typeof content === 'string' && isBase64(content)) {
        const cleanedContent = content.replace(/\s+/g, '')
        return renderBs64Img({
          isBase64: true,
          imageData: cleanedContent,
          ...getGeneratedImageSelectionProps(content),
        })
      }

      if (typeof content === 'string') {
        const trimmed = content.trim()
        if (isRenderableImageUrl(trimmed)) {
          return (
            <div className='w-full'>
              {renderBs64Img({
                isBase64: false,
                imageData: '',
                imageUrl: trimmed,
                ...getGeneratedImageSelectionProps(trimmed),
              })}
            </div>
          )
        }
      }

      if (typeof content === 'string') {
        const { textParts, base64Images } = extractBase64Image(content)

        if (base64Images.length > 0) {
          return (
            <>
              {textParts.length > 0 && (
                <ArenaCopilotMarkdownRenderer
                  content={textParts.join('\n\n')}
                  renderImage={renderMarkdownImage}
                />
              )}
              {base64Images.map((imageData, index) => (
                <div key={index}>
                  {renderBs64Img({
                    isBase64: true,
                    imageData,
                    ...getGeneratedImageSelectionProps(imageData),
                  })}
                </div>
              ))}
            </>
          )
        }

        return <ArenaCopilotMarkdownRenderer content={content} renderImage={renderMarkdownImage} />
      }

      return (
        <ArenaCopilotMarkdownRenderer content={String(content)} renderImage={renderMarkdownImage} />
      )
    } catch {
      return (
        <div className='rounded-lg border border-red-200 bg-red-50 p-3 text-red-700 dark:border-red-800 dark:bg-red-950 dark:text-red-300'>
          <p className='text-sm'>⚠️ Error displaying content. Please try refreshing the chat.</p>
        </div>
      )
    }
  }

  return (
    <div className='w-full max-w-full overflow-hidden pl-[2px] opacity-100 transition-opacity duration-200'>
      <div className='whitespace-normal break-words font-[470] font-season text-[#E8E8E8] text-sm leading-[1.25rem]'>
        {/* <WordWrap text={formattedContent} /> */}
        {renderContent(displayContent)}
        {message?.isStreaming && <StreamingIndicator className='mt-1 text-[#E8E8E8]' />}
      </div>
      {message.files && message.files.length > 0 && (
        <div className='mt-2 flex flex-wrap gap-2'>
          {message.files.map((file) => (
            <ChatFileDownload key={file.id} file={file} />
          ))}
        </div>
      )}
      <RenderButtons message={message} formattedContent={formattedContent} />
    </div>
  )
}
