import type { SVGProps } from 'react'
import {
  AudioIcon,
  ChartFileIcon,
  CsvIcon,
  DefaultFileIcon,
  DocxIcon,
  HtmlIcon,
  JsonIcon,
  MarkdownIcon,
  PdfIcon,
  PptxIcon,
  TxtIcon,
  VideoIcon,
  XlsxIcon,
  ZipIcon,
} from '@sim/emcn/icons'
import {
  SUPPORTED_ARCHIVE_EXTENSIONS,
  SUPPORTED_ARCHIVE_MIME_TYPES,
  SUPPORTED_AUDIO_EXTENSIONS,
  SUPPORTED_VIDEO_EXTENSIONS,
} from '@/lib/uploads/utils/validation'

export function getDocumentIcon(
  rawMimeType: string,
  filename: string
): (props: SVGProps<SVGSVGElement>) => React.JSX.Element {
  const mimeType = rawMimeType.split(';')[0].trim().toLowerCase()
  const extension = filename.split('.').pop()?.toLowerCase()

  if (
    mimeType.startsWith('audio/') ||
    (extension &&
      SUPPORTED_AUDIO_EXTENSIONS.includes(extension as (typeof SUPPORTED_AUDIO_EXTENSIONS)[number]))
  ) {
    return AudioIcon
  }

  if (
    mimeType.startsWith('video/') ||
    (extension &&
      SUPPORTED_VIDEO_EXTENSIONS.includes(extension as (typeof SUPPORTED_VIDEO_EXTENSIONS)[number]))
  ) {
    return VideoIcon
  }

  if (mimeType === 'application/pdf' || extension === 'pdf') {
    return PdfIcon
  }

  if (
    mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' ||
    mimeType === 'application/msword' ||
    extension === 'docx' ||
    extension === 'doc'
  ) {
    return DocxIcon
  }

  if (
    mimeType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ||
    mimeType === 'application/vnd.ms-excel' ||
    extension === 'xlsx' ||
    extension === 'xls'
  ) {
    return XlsxIcon
  }

  if (mimeType === 'text/csv' || extension === 'csv') {
    return CsvIcon
  }

  if (mimeType === 'text/plain' || extension === 'txt') {
    return TxtIcon
  }

  if (
    mimeType === 'application/vnd.openxmlformats-officedocument.presentationml.presentation' ||
    mimeType === 'application/vnd.ms-powerpoint' ||
    extension === 'pptx' ||
    extension === 'ppt'
  ) {
    return PptxIcon
  }

  if (
    SUPPORTED_ARCHIVE_MIME_TYPES.includes(mimeType) ||
    (extension &&
      SUPPORTED_ARCHIVE_EXTENSIONS.includes(
        extension as (typeof SUPPORTED_ARCHIVE_EXTENSIONS)[number]
      ))
  ) {
    return ZipIcon
  }

  if (mimeType === 'text/x-sim-chart' || extension === 'chart') {
    return ChartFileIcon
  }

  // Sim pages present as plain documents, not as HTML artifacts — the .html
  // is an implementation detail (legacy pages still carry the extension).
  if (mimeType === 'text/x-sim-page') {
    return DefaultFileIcon
  }

  if (mimeType === 'text/html' || extension === 'html' || extension === 'htm') {
    return HtmlIcon
  }

  if (mimeType === 'application/json' || extension === 'json') {
    return JsonIcon
  }

  if (mimeType === 'text/markdown' || extension === 'md' || extension === 'mdx') {
    return MarkdownIcon
  }

  return DefaultFileIcon
}

/**
 * Renders the Spyfu icon as an SVG component.
 * @param props - The icon props for customizing the className and styling.
 * @returns The Spyfu icon as a React functional component.
 */
export const SpyfuIcon: React.FC<SVGProps<SVGSVGElement>> = (props) => (
  <svg
    {...props}
    width='32'
    height='32'
    viewBox='0 0 32 32'
    xmlns='http://www.w3.org/2000/svg'
    fill='none'
  >
    <rect width='32' height='32' rx='8' fill='#14213D' />
    <path
      d='M8 20C8 14.477 12.477 10 18 10C22.418 10 26 13.582 26 18C26 22.418 22.418 26 18 26'
      stroke='#FCA311'
      strokeWidth='2'
      strokeLinecap='round'
    />
    <path
      d='M8 20C8 22.2091 9.79086 24 12 24H18'
      stroke='#E5E5E5'
      strokeWidth='2'
      strokeLinecap='round'
    />
    <circle cx='12' cy='24' r='2' fill='#E5E5E5' />
    <circle cx='18' cy='26' r='2' fill='#FCA311' />
  </svg>
)
