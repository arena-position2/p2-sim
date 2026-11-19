'use client'

import * as React from 'react'
import { Button, cn, Textarea } from '@sim/emcn'
import { createLogger } from '@sim/logger'
import axios from 'axios'
import { ChevronsUpDown, Wand2 } from 'lucide-react'
import { createPortal } from 'react-dom'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import { getArenaToken } from '@/lib/arena-utils/cookie-utils'
import { getEnv } from '@/lib/core/config/env'
import { arenaSiblingSubBlockStoreKey } from '@/app/workspace/[workspaceId]/w/[workflowId]/components/panel/components/editor/components/sub-block/components/arena/arena-dependency-helpers'
import { formatDisplayText } from '@/app/workspace/[workspaceId]/w/[workflowId]/components/panel/components/editor/components/sub-block/components/formatted-text'
import { SubBlockInputController } from '@/app/workspace/[workspaceId]/w/[workflowId]/components/panel/components/editor/components/sub-block/components/sub-block-input-controller'
import { useSubBlockInput } from '@/app/workspace/[workspaceId]/w/[workflowId]/components/panel/components/editor/components/sub-block/hooks/use-sub-block-input'
import { useSubBlockValue } from '@/app/workspace/[workspaceId]/w/[workflowId]/components/panel/components/editor/components/sub-block/hooks/use-sub-block-value'
import type { WandControlHandlers } from '@/app/workspace/[workspaceId]/w/[workflowId]/components/panel/components/editor/components/sub-block/sub-block'
import { WandPromptBar } from '@/app/workspace/[workspaceId]/w/[workflowId]/components/wand-prompt-bar/wand-prompt-bar'
import { useAccessibleReferencePrefixes } from '@/app/workspace/[workspaceId]/w/[workflowId]/hooks/use-accessible-reference-prefixes'
import { useWand } from '@/app/workspace/[workspaceId]/w/[workflowId]/hooks/use-wand'
import type { SubBlockConfig } from '@/blocks/types'
import { useWorkflowRegistry } from '@/stores/workflows/registry/store'
import { useSubBlockStore } from '@/stores/workflows/subblock/store'

const logger = createLogger('ArenaCommentInput')

const DEFAULT_ROWS = 5
const ROW_HEIGHT_PX = 24
const MIN_HEIGHT_PX = 80

interface ArenaUser {
  sysId: string
  name: string
}

interface ArenaCommentInputProps {
  placeholder?: string
  blockId: string
  subBlockId: string
  config: SubBlockConfig
  rows?: number
  isPreview?: boolean
  previewValue?: string | null
  value?: string
  onChange?: (value: string) => void
  disabled?: boolean
  wandControlRef?: React.MutableRefObject<WandControlHandlers | null>
  hideInternalWand?: boolean
}

/**
 * Converts HTML with mentions to plain text for display
 * Preserves unresolved variables like <agent1.content> by extracting them before parsing
 * Preserves non-mention anchor tags by including their HTML source in the display text
 */
function htmlToDisplayText(html: string): string {
  if (!html) return ''

  // Extract unresolved variables from the raw HTML string before parsing
  // These look like <agent1.content> and need to be preserved
  const variableMarkers = new Map<string, string>()
  let markerIndex = 0

  // Pattern to find potential variable references in the HTML string
  // We look for <word> or <word.word> patterns
  const variablePattern = /<([a-zA-Z_][a-zA-Z0-9_.]*[a-zA-Z0-9_])>/g
  let htmlWithMarkers = html

  // Find all potential variables and replace with markers
  const matches: Array<{ match: string; index: number; varName: string }> = []
  let match: RegExpExecArray | null

  // Reset regex
  variablePattern.lastIndex = 0

  while ((match = variablePattern.exec(html)) !== null) {
    const varName = match[1]
    const matchIndex = match.index

    // Check if this looks like a variable (contains dot or is longer than typical HTML tags)
    const isLikelyVariable = varName.includes('.') || varName.length > 3

    if (isLikelyVariable) {
      // Check if it's not part of an HTML tag attribute
      // Look at what comes after the match
      const afterMatch = html.substring(
        matchIndex + match[0].length,
        matchIndex + match[0].length + 5
      )
      const isInHtmlTag = /^\s*[>=]/.test(afterMatch)

      if (!isInHtmlTag) {
        matches.push({ match: match[0], index: matchIndex, varName })
      }
    }
  }

  // Replace matches in reverse order to preserve indices
  for (let i = matches.length - 1; i >= 0; i--) {
    const { match: fullMatch, index } = matches[i]
    const marker = `__VAR_MARKER_${markerIndex++}__`
    variableMarkers.set(marker, fullMatch)
    htmlWithMarkers =
      htmlWithMarkers.substring(0, index) +
      marker +
      htmlWithMarkers.substring(index + fullMatch.length)
  }

  // Extract non-mention anchor tags before parsing to preserve them
  // We'll replace them with markers and restore them later
  const anchorMarkers = new Map<string, string>()
  let anchorMarkerIndex = 0

  // Pattern to match complete anchor tags
  // Match <a followed by attributes, then content, then closing </a>
  // The .*? is non-greedy to match the first closing tag
  const anchorTagRegex = /<a\s+[^>]*>.*?<\/a>/gi
  const anchorMatches: Array<{ fullMatch: string; marker: string; startIndex: number }> = []

  // Reset regex
  anchorTagRegex.lastIndex = 0
  let anchorMatch: RegExpExecArray | null

  // Find all anchor tags and filter out mentions
  while ((anchorMatch = anchorTagRegex.exec(htmlWithMarkers)) !== null) {
    const fullMatch = anchorMatch[0]
    const startIndex = anchorMatch.index

    // Check if this anchor is a mention by looking for class="mention" or class='mention'
    const isMention = /class\s*=\s*["']mention["']/i.test(fullMatch)

    if (!isMention) {
      const marker = `__ANCHOR_MARKER_${anchorMarkerIndex++}__`
      anchorMatches.push({ fullMatch, marker, startIndex })
      anchorMarkers.set(marker, fullMatch)
    }
  }

  // Replace anchor tags with markers in reverse order to preserve indices
  let htmlWithAnchorMarkers = htmlWithMarkers
  for (let i = anchorMatches.length - 1; i >= 0; i--) {
    const { fullMatch, marker, startIndex } = anchorMatches[i]
    // Replace at the specific index to avoid replacing wrong occurrences
    htmlWithAnchorMarkers =
      htmlWithAnchorMarkers.substring(0, startIndex) +
      marker +
      htmlWithAnchorMarkers.substring(startIndex + fullMatch.length)
  }

  // Create a temporary DOM element to parse HTML
  const temp = document.createElement('div')
  temp.innerHTML = htmlWithAnchorMarkers

  // Replace mention links with just the user name
  const mentions = temp.querySelectorAll('a.mention')
  mentions.forEach((mention) => {
    const textNode = document.createTextNode(mention.textContent || '')
    mention.parentNode?.replaceChild(textNode, mention)
  })

  // Convert <p> tags to newlines
  const paragraphs = temp.querySelectorAll('p')
  paragraphs.forEach((p, index) => {
    if (index > 0) {
      const br = document.createTextNode('\n')
      p.parentNode?.insertBefore(br, p)
    }
  })

  // Get the text content (which now contains our markers)
  let result = temp.textContent || temp.innerText || ''

  // Restore anchor tags first (before restoring variables, in case variables are in anchor text)
  anchorMarkers.forEach((originalAnchor, marker) => {
    result = result.replace(
      new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'),
      originalAnchor
    )
  })

  // Restore variable markers
  variableMarkers.forEach((original, marker) => {
    result = result.replace(
      new RegExp(marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'),
      original
    )
  })

  return result
}

/**
 * Escapes HTML special characters
 */
function escapeHtml(text: string): string {
  const div = document.createElement('div')
  div.textContent = text
  return div.innerHTML
}

/**
 * Converts plain text to HTML while preserving dynamic values like <function1.result.comment>
 * Wraps each line in <p> tags but doesn't escape dynamic variable references
 */
function textToHtmlPreservingVariables(text: string): string {
  if (!text) return ''

  // Split by lines and wrap in <p> tags
  const lines = text.split('\n')
  return lines
    .map((line) => {
      if (!line) return '<p>&nbsp;</p>'

      // Pattern to match dynamic variables (like <function1.result.comment>)
      // Must contain a dot or be longer than 3 chars to distinguish from HTML tags
      const variablePattern = /<([a-zA-Z_][a-zA-Z0-9_.]*[a-zA-Z0-9_])>/g

      // Find all matches first
      const matches: Array<{ match: string; index: number }> = []
      let match: RegExpExecArray | null
      variablePattern.lastIndex = 0 // Reset regex

      while ((match = variablePattern.exec(line)) !== null) {
        const varName = match[1]
        // Check if this looks like a variable (contains dot or is longer than typical HTML tags)
        const isLikelyVariable = varName.includes('.') || varName.length > 3

        if (isLikelyVariable) {
          // Check if it's not part of an HTML tag attribute
          const afterMatch = line.substring(
            match.index + match[0].length,
            match.index + match[0].length + 5
          )
          const isInHtmlTag = /^\s*[>=]/.test(afterMatch)

          if (!isInHtmlTag) {
            matches.push({ match: match[0], index: match.index })
          }
        }
      }

      if (matches.length > 0) {
        // Has dynamic variables, preserve them by only escaping non-variable parts
        let result = ''
        let lastIndex = 0

        for (const { match: varMatch, index } of matches) {
          // Escape text before the variable
          if (index > lastIndex) {
            const textBefore = line.substring(lastIndex, index)
            result += escapeHtml(textBefore)
          }
          // Add the variable as-is (don't escape)
          result += varMatch
          lastIndex = index + varMatch.length
        }

        // Escape remaining text after last variable
        if (lastIndex < line.length) {
          result += escapeHtml(line.substring(lastIndex))
        }

        return `<p>${result}</p>`
      }

      // No variables, escape normally
      return `<p>${escapeHtml(line)}</p>`
    })
    .join('')
}

/**
 * Converts plain text with @mentions to HTML format
 * Handles user names with spaces by matching against the full user names
 * Only converts @mentions to HTML tags, preserves the rest of the text as-is
 * (including agent variables like <agent1.content>)
 */
function textToHtml(text: string, mentions: Map<string, ArenaUser>): string {
  if (!text) return ''

  // Get all user names sorted by length (longest first) to match full names before partial matches
  const users = Array.from(mentions.values()).sort((a, b) => b.name.length - a.name.length)

  // Split by lines and wrap in <p> tags
  const lines = text.split('\n')
  const htmlLines = lines.map((line) => {
    const parts: string[] = []
    let lastIndex = 0

    // Find all @ mentions in the line
    let searchIndex = 0
    while (searchIndex < line.length) {
      const atIndex = line.indexOf('@', searchIndex)
      if (atIndex === -1) {
        // No more @ symbols, add remaining text as-is (don't escape to preserve agent variables)
        if (lastIndex < line.length) {
          parts.push(line.substring(lastIndex))
        }
        break
      }

      // Add text before the @ as-is (don't escape to preserve agent variables)
      if (atIndex > lastIndex) {
        parts.push(line.substring(lastIndex, atIndex))
      }

      // Try to match user names starting from this @ position
      let matched = false
      for (const user of users) {
        const mentionText = `@${user.name}`
        const endIndex = atIndex + mentionText.length

        // Check if this matches exactly
        if (endIndex <= line.length && line.substring(atIndex, endIndex) === mentionText) {
          // Check if it's followed by space, newline, punctuation, or end of string
          const nextChar = endIndex < line.length ? line[endIndex] : ''
          const isEndOfMention =
            endIndex === line.length || /\s/.test(nextChar) || /[.,;:!?]/.test(nextChar)

          if (isEndOfMention) {
            // Found a match! Convert only the mention to HTML tag
            // Escape the user name for safety in HTML attributes and content
            parts.push(
              `<a class="mention" data-mention="@${escapeHtml(user.name)}" data-user-id="${user.sysId}">@${escapeHtml(user.name)}</a>`
            )
            lastIndex = endIndex
            searchIndex = endIndex
            matched = true
            break
          }
        }
      }

      if (!matched) {
        // No match found, keep the @ and following text as-is (don't escape)
        const nextAt = line.indexOf('@', atIndex + 1)
        const endIndex = nextAt === -1 ? line.length : nextAt
        parts.push(line.substring(atIndex, endIndex))
        lastIndex = endIndex
        searchIndex = endIndex
      }
    }

    return parts.join('')
  })

  // Wrap each line in <p> tags, but preserve empty lines as &nbsp;
  return htmlLines.map((line) => `<p>${line || '&nbsp;'}</p>`).join('')
}

// Note: extractMentionedUserIds is exported from @/tools/arena/utils for server-side use

export function ArenaCommentInput({
  placeholder,
  blockId,
  subBlockId,
  config,
  rows,
  isPreview = false,
  previewValue,
  value: propValue,
  onChange,
  disabled,
  wandControlRef,
  hideInternalWand = false,
}: ArenaCommentInputProps) {
  const [, setLocalContent] = React.useState<string>('')
  const [displayText, setDisplayText] = React.useState<string>('')
  const [htmlContent, setHtmlContent] = React.useState<string>('')
  const persistSubBlockValueRef = React.useRef<(value: string) => void>(() => {})

  // Mention state
  const [showMentionMenu, setShowMentionMenu] = React.useState(false)
  const [mentionQuery, setMentionQuery] = React.useState('')
  const [mentionPosition, setMentionPosition] = React.useState(0)
  const [selectedMentionIndex, setSelectedMentionIndex] = React.useState(0)
  const [users, setUsers] = React.useState<ArenaUser[]>([])
  const [loadingUsers, setLoadingUsers] = React.useState(false)
  const mentionMenuRef = React.useRef<HTMLDivElement>(null)
  const textareaRef = React.useRef<HTMLTextAreaElement>(null)
  const commandInputRef = React.useRef<HTMLInputElement>(null)
  const mentionsMap = React.useRef<Map<string, ArenaUser>>(new Map())

  // Get project and client from store
  const activeWorkflowId = useWorkflowRegistry((state) => state.activeWorkflowId)
  const values = useSubBlockStore((state) => state.workflowValues)
  const clientKey = arenaSiblingSubBlockStoreKey(subBlockId, 'comment-client')
  const projectKey = arenaSiblingSubBlockStoreKey(subBlockId, 'comment-project')
  const clientRef = values?.[activeWorkflowId ?? '']?.[blockId]?.[clientKey] as
    | { clientId?: string }
    | undefined
  const clientId = clientRef?.clientId
  const projectValue = values?.[activeWorkflowId ?? '']?.[blockId]?.[projectKey]
  const projectId =
    typeof projectValue === 'string' ? projectValue : (projectValue as { sysId?: string })?.sysId

  // Wand functionality
  const wandHook = useWand({
    wandConfig: config.wandConfig,
    currentValue: htmlContent,
    onStreamStart: () => {
      setLocalContent('')
      setHtmlContent('')
      setDisplayText('')
    },
    onStreamChunk: (chunk) => {
      const newHtml = htmlContent + chunk
      setHtmlContent(newHtml)
      setLocalContent(newHtml)
      setDisplayText(htmlToDisplayText(newHtml))
    },
    onGeneratedContent: (content) => {
      setHtmlContent(content)
      setLocalContent(content)
      setDisplayText(htmlToDisplayText(content))
      if (!isPreview && !disabled) {
        persistSubBlockValueRef.current(content)
      }
    },
  })

  const [, setSubBlockValue] = useSubBlockValue<string>(blockId, subBlockId, false, {
    isStreaming: wandHook.isStreaming,
  })

  React.useEffect(() => {
    persistSubBlockValueRef.current = (value: string) => {
      setSubBlockValue(value)
    }
  }, [setSubBlockValue])

  const isWandEnabled = config.wandConfig?.enabled ?? false

  const ctrl = useSubBlockInput({
    blockId,
    subBlockId,
    config,
    value: propValue,
    onChange,
    isPreview,
    disabled,
    isStreaming: wandHook.isStreaming,
    onStreamingEnd: () => {
      logger.debug('Wand streaming ended, value persisted', { blockId, subBlockId })
    },
    previewValue,
  })

  const [height, setHeight] = React.useState(() => {
    const rowCount = rows || DEFAULT_ROWS
    return Math.max(rowCount * ROW_HEIGHT_PX, MIN_HEIGHT_PX)
  })

  const overlayRef = React.useRef<HTMLDivElement>(null)
  const containerRef = React.useRef<HTMLDivElement>(null)
  const isResizing = React.useRef(false)

  const accessiblePrefixes = useAccessibleReferencePrefixes(blockId)

  // Initialize from prop value
  React.useEffect(() => {
    if (!wandHook.isStreaming) {
      const baseValue = isPreview
        ? previewValue
        : propValue !== undefined
          ? propValue
          : ctrl.valueString

      const baseValueString = baseValue?.toString() ?? ''

      // Only update if the value has actually changed
      if (baseValueString !== htmlContent && baseValueString !== '') {
        // Check if it's HTML (contains HTML tags like <p>, <a>, etc.)
        // Check for anchor tags (with or without mention class), paragraph tags, or other HTML tags
        const isHtml =
          baseValueString.includes('<a class="mention"') ||
          baseValueString.includes("class='mention'") ||
          (baseValueString.includes('<a') && baseValueString.includes('</a>')) ||
          (baseValueString.includes('<p>') && baseValueString.includes('</p>'))

        if (isHtml) {
          // It's HTML, store it as-is and convert to display text
          setHtmlContent(baseValueString)
          setLocalContent(baseValueString)
          setDisplayText(htmlToDisplayText(baseValueString))
        } else {
          // It's plain text, convert to HTML if we have users loaded
          if (mentionsMap.current.size > 0 && baseValueString.includes('@')) {
            const convertedHtml = textToHtml(baseValueString, mentionsMap.current)
            setHtmlContent(convertedHtml)
            setLocalContent(convertedHtml)
            setDisplayText(baseValueString)
            // Persist the converted HTML
            if (!isPreview && !disabled) {
              persistSubBlockValueRef.current(convertedHtml)
            }
          } else {
            // No users loaded yet or no mentions, store as plain text wrapped in <p> tags
            // Preserve dynamic variables when converting
            const plainHtml = textToHtmlPreservingVariables(baseValueString)
            setHtmlContent(plainHtml)
            setLocalContent(plainHtml)
            setDisplayText(baseValueString)
          }
        }
      }
    }
  }, [isPreview, previewValue, propValue, ctrl.valueString, wandHook.isStreaming])

  // Fetch users when project is selected
  React.useEffect(() => {
    if (!clientId || !projectId) {
      setUsers([])
      mentionsMap.current.clear()
      return
    }

    const fetchUsers = async () => {
      setLoadingUsers(true)
      try {
        const v2Token = await getArenaToken()
        const arenaBackendBaseUrl = getEnv('NEXT_PUBLIC_ARENA_BACKEND_BASE_URL')
        const url = `${arenaBackendBaseUrl}/sol/v1/users/list?cId=${clientId}&pId=${projectId}`

        const response = await axios.get(url, {
          headers: {
            Authorisation: v2Token || '',
          },
        })

        const userList = response.data?.userList || []
        const formattedUsers: ArenaUser[] = userList.map((user: any) => ({
          sysId: user.sysId,
          name: user.name,
        }))

        setUsers(formattedUsers)

        // Update mentions map
        mentionsMap.current.clear()
        formattedUsers.forEach((user) => {
          mentionsMap.current.set(user.sysId, user)
        })
      } catch (error) {
        logger.error('Error fetching users:', error)
        setUsers([])
        mentionsMap.current.clear()
      } finally {
        setLoadingUsers(false)
      }
    }

    fetchUsers()
  }, [clientId, projectId])

  // Re-convert display text to HTML when users are loaded (if we have plain text mentions)
  React.useEffect(() => {
    if (mentionsMap.current.size > 0 && displayText && displayText.includes('@')) {
      const newHtml = textToHtml(displayText, mentionsMap.current)
      // Only update if the HTML actually contains mention tags (meaning conversion worked)
      if (newHtml !== htmlContent && newHtml.includes('class="mention"')) {
        setHtmlContent(newHtml)
        setLocalContent(newHtml)
        // Update the stored value with the new HTML
        if (!isPreview && !disabled) {
          persistSubBlockValueRef.current(newHtml)
        }
      }
    }
  }, [users.length, displayText]) // Re-run when users are loaded or display text changes

  // Handle text change and detect @ mentions
  const handleTextChange = React.useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const newDisplayText = e.target.value
      setDisplayText(newDisplayText)

      // Convert display text to HTML (only if we have users loaded)
      const newHtml =
        mentionsMap.current.size > 0
          ? textToHtml(newDisplayText, mentionsMap.current)
          : textToHtmlPreservingVariables(newDisplayText)
      setHtmlContent(newHtml)
      setLocalContent(newHtml)

      // Update the actual value (HTML)
      if (!isPreview && !disabled) {
        persistSubBlockValueRef.current(newHtml)
      }

      // Check for @ mention, but only if we're not in a tag reference context
      const cursorPos = e.target.selectionStart ?? newDisplayText.length
      const textBeforeCursor = newDisplayText.substring(0, cursorPos)

      // Check if we're in a tag reference context (unclosed < before cursor)
      // If so, don't show mention menu to allow tag dropdown to work
      const lastOpenBracket = textBeforeCursor.lastIndexOf('<')
      const lastCloseBracket = textBeforeCursor.lastIndexOf('>')
      const isInTagContext =
        lastOpenBracket !== -1 && (lastCloseBracket === -1 || lastCloseBracket < lastOpenBracket)

      // Only check for @ mentions if we're not in a tag context
      if (!isInTagContext) {
        const lastAtIndex = textBeforeCursor.lastIndexOf('@')

        if (lastAtIndex !== -1) {
          const textAfterAt = textBeforeCursor.substring(lastAtIndex + 1)

          // Check if we're in a mention (no space after @ and not already a complete mention)
          const isInMention =
            !textAfterAt.includes(' ') && !textAfterAt.includes('\n') && textAfterAt.length >= 0

          if (isInMention) {
            setMentionQuery(textAfterAt)
            setMentionPosition(lastAtIndex)
            setShowMentionMenu(true)
            setSelectedMentionIndex(0)
            return
          }
        }
      }

      setShowMentionMenu(false)
    },
    [isPreview, disabled]
  )

  // Filter users based on mention query
  const filteredUsers = React.useMemo(() => {
    if (!mentionQuery) return users
    return users.filter((user) => user.name.toLowerCase().includes(mentionQuery.toLowerCase()))
  }, [users, mentionQuery])

  // Handle user selection
  const handleUserSelect = React.useCallback(
    (user: ArenaUser) => {
      const textarea = textareaRef.current
      if (!textarea) return

      const beforeMention = displayText.substring(0, mentionPosition)
      const afterMention = displayText.substring(textarea.selectionStart ?? displayText.length)

      const newDisplayText = `${beforeMention}@${user.name} ${afterMention}`
      setDisplayText(newDisplayText)

      // Convert to HTML (users should be loaded at this point)
      const newHtml = textToHtml(newDisplayText, mentionsMap.current)
      setHtmlContent(newHtml)
      setLocalContent(newHtml)

      // Update value - ensure HTML is persisted immediately
      if (!isPreview && !disabled) {
        // Use setTimeout to ensure state updates are complete before persisting
        setTimeout(() => {
          persistSubBlockValueRef.current(newHtml)
        }, 0)
      }

      setShowMentionMenu(false)
      setMentionQuery('')

      // Focus back to textarea
      setTimeout(() => {
        textarea.focus()
        const newCursorPosition = beforeMention.length + `@${user.name} `.length
        textarea.setSelectionRange(newCursorPosition, newCursorPosition)
      }, 0)
    },
    [displayText, mentionPosition, isPreview, disabled]
  )

  // Handle keyboard navigation in mention menu
  const handleKeyDown = React.useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (showMentionMenu && filteredUsers.length > 0) {
        if (e.key === 'ArrowDown') {
          e.preventDefault()
          setSelectedMentionIndex((prev) => (prev < filteredUsers.length - 1 ? prev + 1 : prev))
          return
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault()
          setSelectedMentionIndex((prev) => (prev > 0 ? prev - 1 : 0))
          return
        }
        if (e.key === 'Enter' || e.key === 'Tab') {
          e.preventDefault()
          const selectedUser = filteredUsers[selectedMentionIndex]
          if (selectedUser) {
            handleUserSelect(selectedUser)
          }
          return
        }
        if (e.key === 'Escape') {
          e.preventDefault()
          setShowMentionMenu(false)
          return
        }
      }
    },
    [showMentionMenu, filteredUsers, selectedMentionIndex, handleUserSelect]
  )

  // Position mention menu
  const [mentionMenuPosition, setMentionMenuPosition] = React.useState<{
    top: number
    left: number
  } | null>(null)

  React.useEffect(() => {
    if (showMentionMenu && textareaRef.current) {
      const textarea = textareaRef.current
      const rect = textarea.getBoundingClientRect()
      const scrollTop = textarea.scrollTop

      // Calculate position based on cursor
      const textBeforeCursor = displayText.substring(0, mentionPosition)
      const lines = textBeforeCursor.split('\n')
      const lineNumber = lines.length - 1
      const lineHeight = ROW_HEIGHT_PX
      const topOffset = lineNumber * lineHeight - scrollTop

      setMentionMenuPosition({
        top: rect.top + topOffset + lineHeight + 4 + window.scrollY,
        left: rect.left + window.scrollX,
      })

      // Focus the search input when menu opens
      setTimeout(() => {
        commandInputRef.current?.focus()
      }, 0)
    } else {
      setMentionMenuPosition(null)
    }
  }, [showMentionMenu, mentionPosition, displayText])

  // Close mention menu when clicking outside
  React.useEffect(() => {
    if (!showMentionMenu) return

    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node

      // Check if click is outside the mention menu
      if (mentionMenuRef.current && !mentionMenuRef.current.contains(target)) {
        // Close the menu when clicking outside
        setShowMentionMenu(false)
        setMentionQuery('')
      }
    }

    // Use capture phase to catch the event early
    // Add a small delay to avoid closing immediately when menu opens
    const timeoutId = setTimeout(() => {
      document.addEventListener('mousedown', handleClickOutside, true)
    }, 50)

    return () => {
      clearTimeout(timeoutId)
      document.removeEventListener('mousedown', handleClickOutside, true)
    }
  }, [showMentionMenu])

  const value = React.useMemo(() => {
    if (wandHook.isStreaming) return displayText
    return displayText
  }, [wandHook.isStreaming, displayText])

  React.useLayoutEffect(() => {
    const rowCount = rows || DEFAULT_ROWS
    const newHeight = Math.max(rowCount * ROW_HEIGHT_PX, MIN_HEIGHT_PX)
    setHeight(newHeight)

    if (textareaRef.current && overlayRef.current) {
      textareaRef.current.style.height = `${newHeight}px`
      overlayRef.current.style.height = `${newHeight}px`
    }
  }, [rows])

  const handleScroll = React.useCallback((e: React.UIEvent<HTMLTextAreaElement>) => {
    if (overlayRef.current) {
      overlayRef.current.scrollTop = e.currentTarget.scrollTop
      overlayRef.current.scrollLeft = e.currentTarget.scrollLeft
    }
  }, [])

  React.useEffect(() => {
    if (textareaRef.current && overlayRef.current) {
      overlayRef.current.scrollTop = textareaRef.current.scrollTop
      overlayRef.current.scrollLeft = textareaRef.current.scrollLeft
    }
  }, [value])

  const startResize = React.useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault()
      e.stopPropagation()
      isResizing.current = true

      const startY = e.clientY
      const startHeight = height

      const handleMouseMove = (moveEvent: MouseEvent) => {
        if (!isResizing.current) return

        const deltaY = moveEvent.clientY - startY
        const newHeight = Math.max(MIN_HEIGHT_PX, startHeight + deltaY)

        if (textareaRef.current && overlayRef.current) {
          textareaRef.current.style.height = `${newHeight}px`
          overlayRef.current.style.height = `${newHeight}px`
        }
        if (containerRef.current) {
          containerRef.current.style.height = `${newHeight}px`
        }
        setHeight(newHeight)
      }

      const handleMouseUp = () => {
        if (textareaRef.current) {
          const finalHeight = Number.parseInt(textareaRef.current.style.height, 10) || height
          setHeight(finalHeight)
        }

        isResizing.current = false
        document.removeEventListener('mousemove', handleMouseMove)
        document.removeEventListener('mouseup', handleMouseUp)
      }

      document.addEventListener('mousemove', handleMouseMove)
      document.addEventListener('mouseup', handleMouseUp)
    },
    [height]
  )

  React.useImperativeHandle(
    wandControlRef,
    () => ({
      onWandTrigger: (prompt: string) => {
        wandHook.generateStream({ prompt })
      },
      isWandActive: wandHook.isPromptVisible,
      isWandStreaming: wandHook.isStreaming,
    }),
    [wandHook]
  )

  return (
    <>
      {isWandEnabled && !hideInternalWand && (
        <WandPromptBar
          isVisible={wandHook.isPromptVisible}
          isLoading={wandHook.isLoading}
          isStreaming={wandHook.isStreaming}
          promptValue={wandHook.promptInputValue}
          onSubmit={(prompt: string) => wandHook.generateStream({ prompt })}
          onCancel={wandHook.isStreaming ? wandHook.cancelGeneration : wandHook.hidePromptInline}
          onChange={wandHook.updatePromptValue}
          placeholder={config.wandConfig?.placeholder || 'Describe what you want to generate...'}
        />
      )}

      <SubBlockInputController
        blockId={blockId}
        subBlockId={subBlockId}
        config={config}
        value={displayText}
        onChange={(newDisplayText: string) => {
          // Update displayText when tag is selected or value changes
          setDisplayText(newDisplayText)

          // Convert display text to HTML (only if we have users loaded)
          const newHtml =
            mentionsMap.current.size > 0
              ? textToHtml(newDisplayText, mentionsMap.current)
              : textToHtmlPreservingVariables(newDisplayText)
          setHtmlContent(newHtml)
          setLocalContent(newHtml)

          // Update the actual value (HTML)
          if (!isPreview && !disabled) {
            persistSubBlockValueRef.current(newHtml)
          }

          // Call prop onChange if provided
          if (onChange) {
            onChange(newDisplayText)
          }
        }}
        isPreview={isPreview}
        disabled={disabled}
        isStreaming={wandHook.isStreaming}
        previewValue={previewValue}
      >
        {({ ref, onChange: handleChange, onKeyDown, onDrop, onDragOver, onFocus }) => {
          const setRefs = (el: HTMLTextAreaElement | null) => {
            textareaRef.current = el
            ;(ref as React.MutableRefObject<HTMLTextAreaElement | null>).current = el
          }

          const combinedKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
            handleKeyDown(e)
            onKeyDown?.(e as any)
          }

          const combinedOnChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
            // Call controller's onChange first so it can detect tag triggers with the correct value
            // The controller needs to see the displayText to detect < triggers
            handleChange?.(e as any)
            // Then handle our mention logic
            handleTextChange(e)
          }

          return (
            <div
              ref={containerRef}
              className={cn('group relative w-full', wandHook.isStreaming && 'streaming-effect')}
              style={{ height: `${height}px` }}
            >
              <Textarea
                ref={setRefs}
                className={cn(
                  'allow-scroll box-border min-h-full w-full resize-none text-transparent caret-foreground placeholder:text-muted-foreground/50',
                  wandHook.isStreaming && 'pointer-events-none cursor-not-allowed opacity-50'
                )}
                rows={rows ?? DEFAULT_ROWS}
                placeholder={placeholder ?? ''}
                value={value}
                onChange={combinedOnChange}
                onDrop={onDrop as (e: React.DragEvent<HTMLTextAreaElement>) => void}
                onDragOver={onDragOver as (e: React.DragEvent<HTMLTextAreaElement>) => void}
                onScroll={handleScroll}
                onKeyDown={combinedKeyDown}
                onFocus={onFocus}
                disabled={isPreview || disabled}
                style={{
                  fontFamily: 'inherit',
                  lineHeight: 'inherit',
                  height: `${height}px`,
                  wordBreak: 'break-word',
                  whiteSpace: 'pre-wrap',
                }}
              />
              <div
                ref={overlayRef}
                className='pointer-events-none absolute inset-0 box-border overflow-auto whitespace-pre-wrap break-words border border-transparent bg-transparent px-[8px] py-[8px] font-sans text-sm'
                style={{
                  fontFamily: 'inherit',
                  lineHeight: 'inherit',
                  width: '100%',
                  height: `${height}px`,
                }}
              >
                {formatDisplayText(value, {
                  accessiblePrefixes,
                  highlightAll: !accessiblePrefixes,
                })}
              </div>

              {/* Mention Menu */}
              {showMentionMenu &&
                !loadingUsers &&
                filteredUsers.length > 0 &&
                mentionMenuPosition &&
                createPortal(
                  <div
                    ref={mentionMenuRef}
                    className='fixed z-[1000] w-[300px] rounded-md border bg-popover p-1 text-popover-foreground shadow-md'
                    style={{
                      top: `${mentionMenuPosition.top}px`,
                      left: `${mentionMenuPosition.left}px`,
                    }}
                  >
                    <Command
                      key={`mention-${mentionPosition}`}
                      filter={(value, search) => {
                        // `value` is from CommandItem's "value" prop (user.sysId here)
                        // We want to match by user name
                        const user = users.find((u) => u.sysId === value)
                        if (!user) return 0
                        // Custom matching: case-insensitive substring
                        return user.name.toLowerCase().includes(search.toLowerCase()) ? 1 : 0
                      }}
                    >
                      <CommandInput
                        ref={commandInputRef}
                        placeholder='Search users...'
                        defaultValue={mentionQuery}
                        autoFocus
                      />
                      <CommandList>
                        <CommandEmpty>No users found.</CommandEmpty>
                        <CommandGroup>
                          {users.map((user, index) => (
                            <CommandItem
                              key={user.sysId}
                              value={user.sysId}
                              onSelect={() => handleUserSelect(user)}
                              style={{ pointerEvents: 'auto', cursor: 'pointer' }}
                              className={cn(index === selectedMentionIndex && 'bg-accent')}
                            >
                              {user.name}
                            </CommandItem>
                          ))}
                        </CommandGroup>
                      </CommandList>
                    </Command>
                  </div>,
                  document.body
                )}

              {isWandEnabled && !isPreview && !wandHook.isStreaming && !hideInternalWand && (
                <div className='absolute top-2 right-3 z-10 flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100'>
                  <Button
                    variant='ghost'
                    size='icon'
                    onClick={
                      wandHook.isPromptVisible
                        ? wandHook.hidePromptInline
                        : wandHook.showPromptInline
                    }
                    disabled={wandHook.isLoading || wandHook.isStreaming || disabled}
                    aria-label='Generate content with AI'
                    className='h-8 w-8 rounded-full border border-transparent bg-muted/80 text-muted-foreground shadow-sm transition-all duration-200 hover:border-primary/20 hover:bg-muted hover:text-foreground hover:shadow'
                  >
                    <Wand2 className='h-4 w-4' />
                  </Button>
                </div>
              )}

              {!wandHook.isStreaming && (
                <div
                  className='absolute right-1 bottom-1 flex h-4 w-4 cursor-ns-resize items-center justify-center rounded-[4px] border border-[var(--border-1)] bg-[var(--surface-5)] dark:bg-[var(--surface-5)]'
                  onMouseDown={startResize}
                  onDragStart={(e) => {
                    e.preventDefault()
                  }}
                >
                  <ChevronsUpDown className='h-3 w-3 text-[var(--text-muted)]' />
                </div>
              )}
            </div>
          )
        }}
      </SubBlockInputController>
    </>
  )
}
