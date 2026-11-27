'use client'

import { Modal, ModalContent } from '@sim/emcn'
import { WelcomeMessageWithCtas } from '@/app/(interfaces)/chat/components/message/components/welcome-message-with-ctas'
import {
  DEPLOYED_CHAT_CANVAS_BG,
  DEPLOYED_CHAT_DIVIDER,
  DEPLOYED_CHAT_SIDEBAR_BORDER,
  DEPLOYED_CHAT_TEXT_BODY,
  DEPLOYED_CHAT_TEXT_DISPLAY,
} from '@/app/(interfaces)/chat/constants'

const DEPLOYED_CHAT_DEPARTMENT_BADGE_TEXT = 'var(--color-ds-purple-600)'
const DEPLOYED_CHAT_DEPARTMENT_BADGE_BORDER = 'var(--color-ds-purple-200)'

interface DeployedChatDescriptionModalProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description: string
  department?: string | null
  /** When set, `{{query}}` tokens submit that query and close the modal */
  onWelcomeQueryClick?: (query: string) => void
}

function shouldShowDepartmentBadge(department?: string | null): boolean {
  if (!department) return false
  const trimmed = department.trim()
  return trimmed.length > 0 && trimmed.toLowerCase() !== 'default'
}

export function DeployedChatDescriptionModal({
  open,
  onOpenChange,
  title,
  description,
  department,
  onWelcomeQueryClick,
}: DeployedChatDescriptionModalProps) {
  const showBadge = shouldShowDepartmentBadge(department)

  const handleQueryClick = (query: string) => {
    onOpenChange(false)
    onWelcomeQueryClick?.(query)
  }

  return (
    <Modal open={open} onOpenChange={onOpenChange}>
      <ModalContent
        bare
        showClose={false}
        srTitle={title}
        size='lg'
        className='flex max-h-[min(85vh,720px)] w-full flex-col overflow-hidden border-0 bg-transparent p-0 shadow-none'
      >
        <div
          className='flex min-h-0 w-full flex-1 flex-col overflow-hidden rounded-2xl border p-6'
          style={{
            backgroundColor: DEPLOYED_CHAT_CANVAS_BG,
            borderColor: DEPLOYED_CHAT_SIDEBAR_BORDER,
          }}
        >
          <div className='mb-4 flex shrink-0 items-start justify-between gap-3'>
            <h2
              className='min-w-0 flex-1 break-words font-semibold text-[20px] leading-[1.25]'
              style={{ color: DEPLOYED_CHAT_TEXT_DISPLAY }}
            >
              {title}
            </h2>
            {showBadge ? (
              <span
                className='max-w-[45%] shrink-0 break-words rounded-md border bg-[var(--color-ds-surface-raised)] px-3 py-1 font-medium text-[13px]'
                style={{
                  color: DEPLOYED_CHAT_DEPARTMENT_BADGE_TEXT,
                  borderColor: DEPLOYED_CHAT_DEPARTMENT_BADGE_BORDER,
                }}
              >
                {department}
              </span>
            ) : null}
          </div>

          <div
            className='min-h-0 flex-1 overflow-y-auto rounded-xl border bg-[var(--color-ds-surface-raised)] p-6'
            style={{ borderColor: DEPLOYED_CHAT_DIVIDER }}
          >
            <div
              className='whitespace-pre-wrap break-words text-left font-normal text-[14px] leading-[1.6]'
              style={{ color: DEPLOYED_CHAT_TEXT_BODY }}
            >
              <WelcomeMessageWithCtas
                content={description}
                variant='landing'
                onQueryClick={onWelcomeQueryClick ? handleQueryClick : undefined}
              />
            </div>
          </div>
        </div>
      </ModalContent>
    </Modal>
  )
}
