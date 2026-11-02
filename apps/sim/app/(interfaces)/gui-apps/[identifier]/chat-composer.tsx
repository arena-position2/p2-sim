'use client'

import { type FormEvent, useRef, useState } from 'react'
import { getErrorMessage } from '@sim/utils/errors'
import { Paperclip, Send, X } from 'lucide-react'
import { GuiButton } from '@/app/(interfaces)/gui-apps/gui-chrome'
import {
  type ArenaGenerativeChatProtocol,
  chatActionValues,
  chatProtocolWantsConversationId,
  getGenerativeAppConversationId,
} from '@/lib/arena-generative-ui/chat-protocol'
import { ARENA_GENERATIVE_INPUTS_KEY } from '@/lib/arena-generative-ui/types'

const MAX_CHAT_FILES = 15
const MAX_CHAT_FILE_BYTES = 10 * 1024 * 1024

interface ChatComposerProps {
  actionId: string
  placeholder: string
  protocol?: ArenaGenerativeChatProtocol
  conversationStorageKey?: string
  hostState: Record<string, unknown>
  pending: boolean
  onSubmit: (actionId: string, values: Record<string, unknown>) => Promise<void>
}

interface PendingChatFile {
  type: 'file'
  name: string
  mime: string
  data: string
}

export function ChatComposer({
  actionId,
  placeholder,
  protocol,
  conversationStorageKey,
  hostState,
  pending,
  onSubmit,
}: ChatComposerProps) {
  const [draft, setDraft] = useState('')
  const [files, setFiles] = useState<PendingChatFile[]>([])
  const [error, setError] = useState<string | null>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const allowFiles = protocol?.files === true

  const handleFiles = async (list: FileList | null) => {
    if (!list || list.length === 0) return
    try {
      const next = [...files]
      for (const file of Array.from(list)) {
        if (next.length >= MAX_CHAT_FILES) break
        if (file.size > MAX_CHAT_FILE_BYTES) {
          setError(`"${file.name}" is larger than 10MB`)
          return
        }
        next.push(await fileToChatPayload(file))
      }
      setFiles(next)
      setError(null)
    } catch (caught) {
      setError(getErrorMessage(caught, 'Could not attach that file'))
    }
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault()
    const input = draft.trim()
    if (!input || pending) return
    const conversationId = chatProtocolWantsConversationId(protocol)
      ? getGenerativeAppConversationId(conversationStorageKey ?? '')
      : undefined
    const values = chatActionValues({
      hostInputs: hostState[ARENA_GENERATIVE_INPUTS_KEY],
      input,
      files: files.length > 0 ? files : undefined,
      conversationId,
      protocol,
    })
    setDraft('')
    setFiles([])
    setError(null)
    await onSubmit(actionId, values)
  }

  return (
    <form
      data-testid='generative-chat'
      className='flex w-full flex-col gap-2 rounded-(--gui-radius,12px) border border-(--gui-border,#e2e3e5) bg-(--gui-surface,#fff) p-3'
      onSubmit={(event) => {
        void handleSubmit(event)
      }}
    >
      <textarea
        value={draft}
        onChange={(event) => setDraft(event.target.value)}
        placeholder={placeholder}
        rows={3}
        disabled={pending}
        className='min-h-18 w-full resize-none bg-transparent text-(length:--gui-body-size,14px) text-(--gui-text,#1a1c21) outline-none placeholder:text-(--gui-text-muted,#575a66)'
      />
      {files.length > 0 ? (
        <ul className='flex flex-wrap gap-2'>
          {files.map((file) => (
            <li
              key={`${file.name}-${file.data.slice(-12)}`}
              className='flex items-center gap-1 rounded-full bg-(--gui-border,#e2e3e5) px-2 py-0.5 text-caption'
            >
              <span className='max-w-40 truncate'>{file.name}</span>
              <button
                type='button'
                aria-label={`Remove ${file.name}`}
                onClick={() => setFiles((current) => current.filter((item) => item !== file))}
              >
                <X className='size-[12px] text-(--gui-text-muted,#575a66)' />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {error ? <p className='text-caption text-(--gui-danger,#c62828)'>{error}</p> : null}
      <div className='flex items-center justify-between gap-2'>
        {allowFiles ? (
          <>
            <input
              ref={fileInputRef}
              type='file'
              multiple
              className='hidden'
              onChange={(event) => {
                void handleFiles(event.target.files)
              }}
            />
            <button
              type='button'
              aria-label='Attach files'
              disabled={pending}
              onClick={() => fileInputRef.current?.click()}
              className='rounded-(--gui-radius-sm,8px) p-1.5 text-(--gui-text-muted,#575a66) hover:bg-(--gui-canvas,#f7f8f9)'
            >
              <Paperclip className='size-[14px]' />
            </button>
          </>
        ) : (
          <span />
        )}
        <GuiButton
          type='submit'
          variant='primary'
          size='sm'
          className='gap-1'
          disabled={pending || draft.trim().length === 0}
        >
          <Send className='size-[14px]' />
          Send
        </GuiButton>
      </div>
    </form>
  )
}

async function fileToChatPayload(file: File): Promise<PendingChatFile> {
  const data = await readFileAsDataUrl(file)
  return {
    type: 'file',
    name: file.name,
    mime: file.type || 'application/octet-stream',
    data,
  }
}

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        resolve(reader.result)
        return
      }
      reject(new Error('Could not read file'))
    }
    reader.onerror = () => reject(new Error('Could not read file'))
    reader.readAsDataURL(file)
  })
}
