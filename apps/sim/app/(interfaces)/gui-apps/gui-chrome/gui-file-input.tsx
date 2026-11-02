'use client'

import { useRef, useState } from 'react'
import { cn } from '@sim/emcn'
import { Paperclip, X } from 'lucide-react'
import { GUI_FIELD_INPUT_CLASS } from '@/app/(interfaces)/gui-apps/gui-chrome/gui-tokens'

export const GUI_MAX_FORM_FILES = 15
export const GUI_MAX_FORM_FILE_BYTES = 10 * 1024 * 1024

export interface GuiFormFile {
  type: 'file'
  name: string
  mime: string
  data: string
}

interface GuiFileInputProps {
  id: string
  name: string
  accept?: string
  multiple?: boolean
  required?: boolean
  error?: string
  value: readonly GuiFormFile[]
  onChange: (files: GuiFormFile[]) => void
}

export function GuiFileInput({
  id,
  name,
  accept,
  multiple = false,
  required,
  error,
  value,
  onChange,
}: GuiFileInputProps) {
  const inputRef = useRef<HTMLInputElement>(null)
  const [localError, setLocalError] = useState<string | null>(null)

  const handleFiles = async (list: FileList | null) => {
    if (!list || list.length === 0) return
    const next = multiple ? [...value] : []
    try {
      for (const file of Array.from(list)) {
        if (next.length >= GUI_MAX_FORM_FILES) break
        if (file.size > GUI_MAX_FORM_FILE_BYTES) {
          setLocalError(`"${file.name}" is larger than 10MB`)
          return
        }
        next.push(await fileToFormPayload(file))
      }
      setLocalError(null)
      onChange(next)
    } catch {
      setLocalError('Could not attach that file')
    }
    if (inputRef.current) inputRef.current.value = ''
  }

  const message = error || localError

  return (
    <div className='flex w-full flex-col gap-2'>
      <label
        htmlFor={id}
        className={cn(
          GUI_FIELD_INPUT_CLASS,
          'inline-flex cursor-pointer items-center gap-2',
          message && 'border-(--gui-danger,#f31a1a)'
        )}
      >
        <Paperclip className='size-[14px] text-(--gui-text-muted,#575a66)' aria-hidden />
        <span className='truncate text-(--gui-text-muted,#575a66)'>
          {value.length > 0
            ? `${value.length} file${value.length === 1 ? '' : 's'} attached`
            : 'Choose file'}
        </span>
        <input
          ref={inputRef}
          id={id}
          name={name}
          type='file'
          accept={accept || undefined}
          multiple={multiple}
          required={required && value.length === 0}
          className='sr-only'
          onChange={(event) => void handleFiles(event.target.files)}
        />
      </label>
      {value.length > 0 ? (
        <ul className='flex flex-col gap-1'>
          {value.map((file) => (
            <li
              key={`${file.name}-${file.data.slice(0, 24)}`}
              className='flex items-center justify-between gap-2 text-(length:--gui-label-size,12px) text-(--gui-text,#2c2d33)'
            >
              <span className='min-w-0 truncate'>{file.name}</span>
              <button
                type='button'
                aria-label={`Remove ${file.name}`}
                className='rounded-(--gui-radius-sm,8px) p-1 text-(--gui-text-muted,#575a66) hover:bg-(--gui-canvas,#f7f8f9)'
                onClick={() => onChange(value.filter((item) => item !== file))}
              >
                <X className='size-[14px]' aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      {message ? <p className='text-(length:--gui-label-size,12px) text-(--gui-danger,#f31a1a)'>{message}</p> : null}
    </div>
  )
}

export function asGuiFormFiles(value: unknown): GuiFormFile[] {
  if (!Array.isArray(value)) return []
  return value.filter(isGuiFormFile)
}

function isGuiFormFile(value: unknown): value is GuiFormFile {
  if (!value || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return (
    record.type === 'file' &&
    typeof record.name === 'string' &&
    typeof record.mime === 'string' &&
    typeof record.data === 'string'
  )
}

async function fileToFormPayload(file: File): Promise<GuiFormFile> {
  const data = await readFileAsDataUrl(file)
  return { type: 'file', name: file.name, mime: file.type || 'application/octet-stream', data }
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
