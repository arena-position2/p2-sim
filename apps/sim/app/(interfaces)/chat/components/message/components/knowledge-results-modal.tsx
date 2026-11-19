'use client'

import { useMemo } from 'react'
import { Modal, ModalBody, ModalContent, ModalHeader } from '@sim/emcn'
import { ExternalLink } from 'lucide-react'
import type { KnowledgeResultChunk } from '@/app/(interfaces)/chat/components/message/message'

interface KnowledgeResultsModalProps {
  isOpen: boolean
  onClose: () => void
  documentName: string
  chunks: KnowledgeResultChunk[]
  /** When set (user has workspace access), show "View in Knowledge Base" link */
  viewInKbUrl?: string
}

/**
 * Modal that shows knowledge base result chunks for a single document:
 * document name as heading, then each chunk with chunk index and content.
 *
 * The dialog portals to `document.body`, outside `.deployed-chat`. The content
 * root carries that class so surface and text tokens resolve; without it the
 * panel background is invalid and the chat shows through the file text.
 */
export function KnowledgeResultsModal({
  isOpen,
  onClose,
  documentName,
  chunks,
  viewInKbUrl,
}: KnowledgeResultsModalProps) {
  const sortedChunks = useMemo(
    () => [...chunks].sort((a, b) => a.chunkIndex - b.chunkIndex),
    [chunks]
  )

  return (
    <Modal open={isOpen} onOpenChange={(open) => !open && onClose()}>
      <ModalContent className='deployed-chat max-h-[85vh] max-w-2xl bg-[var(--color-ds-surface-raised)] text-[var(--color-ds-text-primary)]'>
        <ModalHeader className='border-[var(--color-ds-border-default)] border-b pb-3'>
          <div className='flex items-center justify-between gap-2'>
            <h2 className='font-semibold text-[var(--color-ds-text-primary)] text-lg'>
              {documentName}
            </h2>
            {viewInKbUrl && (
              <a
                href={viewInKbUrl}
                target='_blank'
                rel='noopener noreferrer'
                className='inline-flex shrink-0 items-center gap-1.5 rounded border border-[var(--color-ds-border-default)] bg-[var(--color-ds-surface-raised)] px-2.5 py-1.5 text-[var(--color-ds-text-secondary)] text-sm transition-colors hover:bg-[var(--color-ds-brand-surface)] hover:text-[var(--color-ds-text-link-hover)]'
              >
                <ExternalLink className='h-3.5 w-3.5' strokeWidth={2} />
                View in Knowledge Base
              </a>
            )}
          </div>
        </ModalHeader>
        <ModalBody className='overflow-y-auto py-4'>
          <div className='space-y-4'>
            {sortedChunks.map((chunk, index) => (
              <div
                key={`${chunk.documentId}-${chunk.chunkIndex}-${index}`}
                className='rounded-lg border border-[var(--color-ds-border-default)] bg-[var(--color-ds-surface-subtle)] p-3'
              >
                <div className='mb-1.5 font-medium text-[var(--color-ds-text-tertiary)] text-xs'>
                  Chunk {chunk.chunkIndex}
                </div>
                <div className='whitespace-pre-wrap break-words font-medium text-[var(--color-ds-text-primary)] text-sm leading-relaxed'>
                  {chunk.content}
                </div>
                {chunk.metadata &&
                  typeof chunk.metadata === 'object' &&
                  Object.keys(chunk.metadata).length > 0 && (
                    <div className='mt-2 border-[var(--color-ds-border-default)] border-t pt-2 text-[var(--color-ds-text-tertiary)] text-xs'>
                      {JSON.stringify(chunk.metadata)}
                    </div>
                  )}
              </div>
            ))}
          </div>
        </ModalBody>
      </ModalContent>
    </Modal>
  )
}
