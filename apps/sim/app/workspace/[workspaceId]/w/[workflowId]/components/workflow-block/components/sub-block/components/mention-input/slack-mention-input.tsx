'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Button, cn, Textarea } from '@sim/emcn'
import { createLogger } from '@sim/logger'
import { toError } from '@sim/utils/errors'
import { AtSign, Check, User } from 'lucide-react'
import {
  checkTagTrigger,
  TagDropdown,
} from '@/app/workspace/[workspaceId]/w/[workflowId]/components/panel/components/editor/components/sub-block/components/tag-dropdown/tag-dropdown'

const logger = createLogger('SlackMentionInput')

export interface SlackUserInfo {
  id: string
  name: string
  realName: string
  displayName: string
}

interface SlackMentionInputProps {
  value: string
  onChange: (value: string) => void
  credential?: string
  disabled?: boolean
  workflowId?: string
  isForeignCredential?: boolean
  placeholder?: string
  blockId?: string
  /** When true, list with the OAuth user token (`xoxp-`) instead of the bot token. */
  useUserToken?: boolean
}

export function SlackMentionInput({
  value,
  onChange,
  credential,
  disabled = false,
  workflowId,
  placeholder = 'Type your message... Use @ to mention users',
  blockId,
  useUserToken = false,
}: SlackMentionInputProps) {
  const [users, setUsers] = useState<SlackUserInfo[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showMentionMenu, setShowMentionMenu] = useState(false)
  const [mentionQuery, setMentionQuery] = useState('')
  const [mentionPosition, setMentionPosition] = useState(0)
  const [selectedMentionIndex, setSelectedMentionIndex] = useState(0)

  // Tag dropdown state for variable/block references
  const [showTagDropdown, setShowTagDropdown] = useState(false)
  const [tagCursorPosition, setTagCursorPosition] = useState(0)
  const [activeSourceBlockId, setActiveSourceBlockId] = useState<string | null>(null)

  // Display value (user-friendly) and actual value (with mention format)
  const [displayValue, setDisplayValue] = useState('')
  const [actualValue, setActualValue] = useState('')

  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const mentionMenuRef = useRef<HTMLDivElement>(null)

  // Fetch users when credential is available
  const fetchUsers = useCallback(async () => {
    if (!credential) return

    setLoading(true)
    setError(null)

    try {
      const response = await fetch('/api/tools/slack/users', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          credential,
          workflowId,
          useUserToken: useUserToken || undefined,
        }),
      })

      if (!response.ok) {
        const errorData = await response.json()
        throw new Error(errorData.error || 'Failed to fetch users')
      }

      const data = await response.json()
      setUsers(data.users || [])
    } catch (err) {
      logger.error('Error fetching Slack users', { error: toError(err).message })
      setError(toError(err).message || 'Failed to fetch users')
    } finally {
      setLoading(false)
    }
  }, [credential, workflowId, useUserToken])

  // Load users when credential changes
  useEffect(() => {
    setUsers([])
  }, [credential, useUserToken])

  useEffect(() => {
    if (credential && users.length === 0) {
      fetchUsers()
    }
  }, [credential, fetchUsers, users.length])

  // Initialize display and actual values from prop
  useEffect(() => {
    if (value !== undefined) {
      const { display, actual } = convertToDisplayFormat(value, users)
      setDisplayValue(display)
      setActualValue(actual)
    }
  }, [value, users])

  // Convert mention format to display format
  const convertToDisplayFormat = (text: string, userList: SlackUserInfo[]) => {
    let display = text
    const actual = text

    // Replace <@USER_ID> with @DisplayName for display
    const mentionRegex = /<@([A-Z0-9]+)>/g
    display = display.replace(mentionRegex, (match, userId) => {
      const user = userList.find((u) => u.id === userId)
      return user ? `@${user.displayName || user.realName || user.name}` : match
    })

    return { display, actual }
  }

  // Convert display format back to mention format
  const convertToMentionFormat = (displayText: string, userList: SlackUserInfo[]) => {
    let actual = displayText

    // Replace @DisplayName with <@USER_ID> for actual value
    userList.forEach((user) => {
      const displayName = user.displayName || user.realName || user.name
      const regex = new RegExp(`@${displayName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'g')
      actual = actual.replace(regex, `<@${user.id}>`)
    })

    return actual
  }

  // Detect @ mentions when displayValue changes (backup mechanism)
  useEffect(() => {
    if (!textareaRef.current || !displayValue) return

    // Use setTimeout to ensure cursor position is updated
    const timeoutId = setTimeout(() => {
      const cursorPosition = textareaRef.current?.selectionStart ?? displayValue.length
      const textBeforeCursor = displayValue.substring(0, cursorPosition)
      const lastAtIndex = textBeforeCursor.lastIndexOf('@')

      if (lastAtIndex !== -1) {
        const textAfterAt = textBeforeCursor.substring(lastAtIndex + 1)

        // Check if we're in a mention (no space after @ and not already a complete mention)
        const isInMention =
          !textAfterAt.includes(' ') &&
          !textAfterAt.includes('\n') &&
          !textAfterAt.includes('<@') &&
          !textAfterAt.includes('>') &&
          textAfterAt.length >= 0

        if (isInMention && users.length > 0) {
          setMentionQuery(textAfterAt)
          setMentionPosition(lastAtIndex)
          setShowMentionMenu(true)
          setSelectedMentionIndex(0)
        } else if (!isInMention) {
          setShowMentionMenu(false)
        }
      } else {
        setShowMentionMenu(false)
      }
    }, 0)

    return () => clearTimeout(timeoutId)
  }, [displayValue, users.length])

  // Close mention menu and tag dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (
        mentionMenuRef.current &&
        !mentionMenuRef.current.contains(event.target as Node) &&
        textareaRef.current &&
        !textareaRef.current.contains(event.target as Node)
      ) {
        setShowMentionMenu(false)
      }
      // TagDropdown handles its own click outside logic
    }

    if (showMentionMenu) {
      document.addEventListener('mousedown', handleClickOutside)
      return () => document.removeEventListener('mousedown', handleClickOutside)
    }
  }, [showMentionMenu])

  // Handle text change and detect @ mentions and < tag triggers
  const handleTextChange = (newDisplayValue: string, cursorPos?: number) => {
    setDisplayValue(newDisplayValue)

    // Convert display value to actual value with mention format
    const newActualValue = convertToMentionFormat(newDisplayValue, users)
    setActualValue(newActualValue)

    // Send actual value to parent
    onChange(newActualValue)

    // Use provided cursor position or get from textarea ref
    const cursorPosition =
      cursorPos ?? textareaRef.current?.selectionStart ?? newDisplayValue.length
    setTagCursorPosition(cursorPosition)

    // Check for tag trigger (<) first, as it takes precedence
    // Use actual value for tag trigger check since tag dropdown works with actual format
    if (blockId) {
      // Map cursor position from display value to actual value
      // For simplicity, use the same cursor position (they should be similar unless there are mentions)
      const tagTrigger = checkTagTrigger(newActualValue, cursorPosition)
      if (tagTrigger.show) {
        setShowTagDropdown(true)
        setShowMentionMenu(false)

        // Determine active source block ID if applicable
        const textBeforeCursor = newActualValue.slice(0, cursorPosition)
        const lastOpenBracket = textBeforeCursor.lastIndexOf('<')
        const tagContent = textBeforeCursor.slice(lastOpenBracket + 1)
        const dotIndex = tagContent.indexOf('.')
        const sourceBlock = dotIndex > 0 ? tagContent.slice(0, dotIndex) : null
        setActiveSourceBlockId(sourceBlock)
        return
      }
      setShowTagDropdown(false)
    }

    // Check for @ mentions
    const textBeforeCursor = newDisplayValue.substring(0, cursorPosition)
    const lastAtIndex = textBeforeCursor.lastIndexOf('@')

    if (lastAtIndex !== -1) {
      const textAfterAt = textBeforeCursor.substring(lastAtIndex + 1)

      // Check if we're in a mention (no space after @ and not already a complete mention)
      const isInMention =
        !textAfterAt.includes(' ') &&
        !textAfterAt.includes('\n') &&
        !textAfterAt.includes('<@') &&
        !textAfterAt.includes('>') &&
        textAfterAt.length >= 0

      if (isInMention) {
        setMentionQuery(textAfterAt)
        setMentionPosition(lastAtIndex)
        setShowMentionMenu(true)
        setSelectedMentionIndex(0)
        return
      }
    }

    setShowMentionMenu(false)
  }

  // Filter users based on mention query
  const filteredUsers = users?.filter((user) => {
    const searchText = mentionQuery?.toLowerCase()
    return (
      user?.name?.toLowerCase()?.includes(searchText) ||
      user?.realName?.toLowerCase()?.includes(searchText) ||
      user?.displayName?.toLowerCase()?.includes(searchText)
    )
  })

  // Handle user selection
  const handleUserSelect = (user: SlackUserInfo) => {
    const beforeMention = displayValue.substring(0, mentionPosition)
    const afterMention = displayValue.substring(
      textareaRef.current?.selectionStart || displayValue.length
    )

    const newDisplayValue = `${beforeMention}@${user.displayName || user.realName || user.name} ${afterMention}`
    handleTextChange(newDisplayValue)

    setShowMentionMenu(false)
    setMentionQuery('')

    // Focus back to textarea
    setTimeout(() => {
      textareaRef.current?.focus()
      const newCursorPosition =
        beforeMention.length + `@${user.displayName || user.realName || user.name} `.length
      textareaRef.current?.setSelectionRange(newCursorPosition, newCursorPosition)
    }, 0)
  }

  // Handle tag selection from TagDropdown
  const handleTagSelect = (newValue: string) => {
    // The newValue already contains the tag in format like <block.output>
    // Convert it to display format (only Slack mentions will be converted)
    const { display } = convertToDisplayFormat(newValue, users)
    setDisplayValue(display)
    setActualValue(newValue)
    onChange(newValue)
    setShowTagDropdown(false)
    setActiveSourceBlockId(null)

    // Focus back to textarea and position cursor after the inserted tag
    setTimeout(() => {
      textareaRef.current?.focus()
      const newCursorPosition = newValue.length
      textareaRef.current?.setSelectionRange(newCursorPosition, newCursorPosition)
    }, 0)
  }

  // Handle keyboard navigation
  const handleKeyDown = (e: React.KeyboardEvent) => {
    // If tag dropdown is open, let it handle keyboard events
    if (showTagDropdown) {
      return
    }

    if (!showMentionMenu || filteredUsers.length === 0) return

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault()
        e.stopPropagation()
        setSelectedMentionIndex((prev) => (prev < filteredUsers.length - 1 ? prev + 1 : 0))
        break
      case 'ArrowUp':
        e.preventDefault()
        e.stopPropagation()
        setSelectedMentionIndex((prev) => (prev > 0 ? prev - 1 : filteredUsers.length - 1))
        break
      case 'Enter':
        e.preventDefault()
        e.stopPropagation()
        if (filteredUsers[selectedMentionIndex]) {
          handleUserSelect(filteredUsers[selectedMentionIndex])
        }
        break
      case 'Escape':
        e.preventDefault()
        e.stopPropagation()
        setShowMentionMenu(false)
        break
      case 'Tab':
        if (filteredUsers[selectedMentionIndex]) {
          e.preventDefault()
          e.stopPropagation()
          handleUserSelect(filteredUsers[selectedMentionIndex])
        }
        break
    }
  }

  // Scroll selected item into view
  useEffect(() => {
    if (showMentionMenu && mentionMenuRef.current) {
      const selectedElement = mentionMenuRef.current.querySelector(
        `[data-mention-index="${selectedMentionIndex}"]`
      )
      if (selectedElement) {
        selectedElement.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
      }
    }
  }, [selectedMentionIndex, showMentionMenu])

  return (
    <div className='flex w-full flex-col gap-2'>
      <div className='group relative'>
        <Textarea
          ref={textareaRef}
          value={displayValue}
          onChange={(e) => {
            const cursorPos = e.target.selectionStart
            handleTextChange(e.target.value, cursorPos)
          }}
          onKeyDown={handleKeyDown}
          placeholder={placeholder}
          disabled={disabled || !credential}
          className='min-h-[100px] pr-10'
        />

        {!disabled && credential && (
          <div className='absolute top-1.5 right-1.5 z-[calc(var(--z-dropdown)-1)] flex items-center opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100'>
            <Button
              type='button'
              variant='ghost'
              size='sm'
              onClick={() => {
                const cursorPosition = textareaRef.current?.selectionStart || 0
                const beforeCursor = displayValue.substring(0, cursorPosition)
                const afterCursor = displayValue.substring(cursorPosition)
                const newValue = `${beforeCursor}@${afterCursor}`
                handleTextChange(newValue)

                setTimeout(() => {
                  textareaRef.current?.focus()
                  const newCursorPosition = beforeCursor.length + 1
                  textareaRef.current?.setSelectionRange(newCursorPosition, newCursorPosition)
                }, 0)
              }}
              disabled={disabled}
              aria-label='Insert @ to mention Slack users'
              className='h-7 w-7 shrink-0 rounded-[5px] border border-[var(--border-1)] bg-[var(--surface-5)] p-0 text-[var(--text-secondary)] shadow-subtle transition-colors hover-hover:border-[var(--border)] hover-hover:bg-[var(--surface-6)] hover-hover:text-[var(--text-primary)]'
            >
              <AtSign className='h-3.5 w-3.5' strokeWidth={2} aria-hidden />
            </Button>
          </div>
        )}

        {/* Tag dropdown for variable/block references */}
        {showTagDropdown && blockId && (
          <TagDropdown
            visible={showTagDropdown}
            onSelect={handleTagSelect}
            blockId={blockId}
            activeSourceBlockId={activeSourceBlockId}
            inputValue={actualValue}
            cursorPosition={tagCursorPosition}
            onClose={() => setShowTagDropdown(false)}
            inputRef={textareaRef as React.RefObject<HTMLInputElement | HTMLTextAreaElement>}
          />
        )}

        {showMentionMenu && (
          <div
            ref={mentionMenuRef}
            role='listbox'
            aria-label='Slack users'
            className='absolute top-full left-0 z-[var(--z-dropdown)] mt-1 max-h-60 w-full max-w-[min(100%,20rem)] overflow-auto rounded-sm border border-[var(--border-1)] bg-[var(--surface-6)] py-0.5 shadow-overlay'
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault()
                e.stopPropagation()
              }
            }}
          >
            {loading && (
              <div className='flex items-center justify-center py-3.5'>
                <span className='text-[length:12px] text-[var(--text-muted)]'>Loading users…</span>
              </div>
            )}
            {error && (
              <div className='flex items-center justify-center px-3 py-3.5'>
                <span className='text-center text-[length:12px] text-[var(--text-error)]'>
                  {error}
                </span>
              </div>
            )}
            {!loading && !error && filteredUsers.length === 0 && (
              <div className='px-3 py-3.5 text-center text-[length:12px] text-[var(--text-muted)]'>
                No users found.
              </div>
            )}
            {!loading && !error && filteredUsers.length > 0 && (
              <div className='flex flex-col gap-0.5 p-0.5'>
                {filteredUsers.map((user, index) => (
                  <div
                    key={user.id}
                    role='option'
                    aria-selected={index === selectedMentionIndex}
                    data-mention-index={index}
                    onClick={() => handleUserSelect(user)}
                    className={cn(
                      'flex cursor-pointer items-center gap-2 rounded-[4px] px-2 py-1.5 text-[length:12px] transition-colors',
                      index === selectedMentionIndex
                        ? 'bg-[var(--surface-active)] text-[var(--text-primary)]'
                        : 'text-[var(--text-primary)] hover-hover:bg-[var(--surface-hover)]'
                    )}
                  >
                    <Check
                      className={cn(
                        'h-3.5 w-3.5 shrink-0 text-[var(--text-icon)]',
                        index === selectedMentionIndex ? 'opacity-100' : 'opacity-0'
                      )}
                      aria-hidden
                    />
                    <User className='h-3.5 w-3.5 shrink-0 text-[var(--text-icon)]' aria-hidden />
                    <div className='flex min-w-0 flex-1 flex-col gap-0.5'>
                      <span className='truncate'>
                        {user.displayName || user.realName || user.name}
                      </span>
                      <span className='truncate text-[length:11px] text-[var(--text-muted)]'>
                        @{user.name}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </div>

      <p className='m-0 text-[length:11px] text-[var(--text-muted)] leading-snug'>
        Type @ or use the button to mention users. Type &lt; for variables and block outputs.
      </p>
    </div>
  )
}
