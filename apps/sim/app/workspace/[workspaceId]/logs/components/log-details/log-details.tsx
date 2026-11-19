'use client'

import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import {
  Badge,
  Button,
  Chip,
  ChipInput,
  ChipModalTabs,
  Code,
  cn,
  DetailsPanel,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Duplicate,
  Eye,
  handleKeyboardActivation,
  Redo,
  Search as SearchIcon,
  Tooltip,
  useCopyToClipboard,
} from '@sim/emcn'
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronUp,
  Clipboard,
  Search,
  SquareArrowUpRight,
  Workflow,
  Wrench,
  X,
} from '@sim/emcn/icons'
import { getErrorMessage } from '@sim/utils/errors'
import { formatDuration } from '@sim/utils/formatting'
import Link from 'next/link'
import { useParams, useRouter } from 'next/navigation'
import { useQueryState } from 'nuqs'
import { createPortal } from 'react-dom'
import type { VerifyExecutionCostsResponse, WorkflowLogRow } from '@/lib/api/contracts/logs'
import {
  apportionCredits,
  formatApportionedCreditCost,
  formatCreditCost,
} from '@/lib/billing/credits/conversion'
import { isChatEnabled } from '@/lib/core/config/env-flags'
import { MothershipHandoffStorage } from '@/lib/core/utils/browser-storage'
import { filterHiddenOutputKeys } from '@/lib/logs/execution/trace-spans/trace-spans'
import type { TraceSpan } from '@/lib/logs/types'
import { sendMothershipMessage } from '@/lib/mothership/events'
import {
  ExecutionSnapshot,
  FileCards,
  TraceView,
} from '@/app/workspace/[workspaceId]/logs/components'
import { useLogDetailsResize } from '@/app/workspace/[workspaceId]/logs/hooks'
import {
  logDetailsTabParam,
  logDetailsTabUrlKeys,
} from '@/app/workspace/[workspaceId]/logs/search-params'
import {
  DELETED_WORKFLOW_LABEL,
  formatDate,
  getDisplayStatus,
  resolveLogWorkflowId,
  StatusBadge,
  TriggerBadge,
  workflowEditorPath,
} from '@/app/workspace/[workspaceId]/logs/utils'
import { useTimezone } from '@/hooks/queries/general-settings'
import { useVerifyExecutionCosts } from '@/hooks/queries/logs'
import { useCodeViewerFeatures } from '@/hooks/use-code-viewer'
import { usePermissionConfig } from '@/hooks/use-permission-config'
import { formatCost } from '@/providers/utils'
import { useLogDetailsUIStore } from '@/stores/logs/store'
import { MAX_LOG_DETAILS_WIDTH_RATIO, MIN_LOG_DETAILS_WIDTH } from '@/stores/logs/utils'
import type { ChatContext } from '@/stores/panel'

const ADDITIVE_COST_SECTIONS = [
  { group: 'base' as const, label: 'Base cost' },
  { group: 'model' as const, label: 'Model costs' },
  { group: 'tool' as const, label: 'Tool costs' },
  { group: 'other' as const, label: 'Other costs' },
]

export const WorkflowOutputSection = memo(
  function WorkflowOutputSection({ output }: { output: Record<string, unknown> }) {
    const contentRef = useRef<HTMLDivElement>(null)
    const { copied, copy } = useCopyToClipboard({ resetMs: 1500 })

    const [isContextMenuOpen, setIsContextMenuOpen] = useState(false)
    const [contextMenuPosition, setContextMenuPosition] = useState({ x: 0, y: 0 })

    const {
      isSearchActive,
      searchQuery,
      setSearchQuery,
      matchCount,
      currentMatchIndex,
      activateSearch,
      closeSearch,
      goToNextMatch,
      goToPreviousMatch,
      handleMatchCountChange,
      searchInputRef,
    } = useCodeViewerFeatures({ contentRef })

    const jsonString = useMemo(() => JSON.stringify(output, null, 2), [output])

    function handleContextMenu(e: React.MouseEvent) {
      e.preventDefault()
      e.stopPropagation()
      setContextMenuPosition({ x: e.clientX, y: e.clientY })
      setIsContextMenuOpen(true)
    }

    function handleCopy() {
      copy(jsonString)
      setIsContextMenuOpen(false)
    }

    function handleSearch() {
      activateSearch()
      setIsContextMenuOpen(false)
    }

    return (
      <div className='relative flex min-w-0 flex-col overflow-hidden'>
        <div ref={contentRef} onContextMenu={handleContextMenu} className='relative'>
          <Code.Viewer
            code={jsonString}
            language='json'
            className='!bg-[var(--surface-4)] dark:!bg-[var(--surface-3)] max-h-[300px] min-h-0 max-w-full rounded-md border-0 [word-break:break-all]'
            wrapText
            searchQuery={isSearchActive ? searchQuery : undefined}
            currentMatchIndex={currentMatchIndex}
            onMatchCountChange={handleMatchCountChange}
          />
          {/* Glass action buttons overlay */}
          {!isSearchActive && (
            <div className='absolute top-[7px] right-[6px] z-10 flex gap-1'>
              <Tooltip.Root>
                <Tooltip.Trigger asChild>
                  <Button
                    aria-label={copied ? 'Copied' : 'Copy'}
                    type='button'
                    variant='default'
                    onClick={(e) => {
                      e.stopPropagation()
                      handleCopy()
                    }}
                    className='size-[20px] cursor-pointer border-[var(--border-1)] bg-transparent p-0 backdrop-blur-xs hover-hover:bg-[var(--surface-3)]'
                  >
                    {copied ? (
                      <Check className='size-[10px] text-[var(--text-success)]' />
                    ) : (
                      <Clipboard className='size-[10px]' />
                    )}
                  </Button>
                </Tooltip.Trigger>
                <Tooltip.Content side='top'>{copied ? 'Copied' : 'Copy'}</Tooltip.Content>
              </Tooltip.Root>
              <Tooltip.Root>
                <Tooltip.Trigger asChild>
                  <Button
                    aria-label='Search'
                    type='button'
                    variant='default'
                    onClick={(e) => {
                      e.stopPropagation()
                      activateSearch()
                    }}
                    className='size-[20px] cursor-pointer border-[var(--border-1)] bg-transparent p-0 backdrop-blur-xs hover-hover:bg-[var(--surface-3)]'
                  >
                    <Search className='size-[10px]' />
                  </Button>
                </Tooltip.Trigger>
                <Tooltip.Content side='top'>Search</Tooltip.Content>
              </Tooltip.Root>
            </div>
          )}
        </div>

        {/* Search Overlay */}
        {isSearchActive && (
          <div
            role='presentation'
            className='absolute top-0 right-0 z-30 flex h-[34px] items-center gap-1.5 rounded-sm border border-[var(--border)] bg-[var(--surface-1)] px-1.5 shadow-sm'
            onClick={(e) => e.stopPropagation()}
          >
            <ChipInput
              ref={searchInputRef}
              type='text'
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder='Search...'
              className='mr-0.5 w-[94px]'
            />
            <span
              className={cn(
                'min-w-[45px] text-center text-xs',
                matchCount > 0 ? 'text-[var(--text-secondary)]' : 'text-[var(--text-tertiary)]'
              )}
            >
              {matchCount > 0 ? `${currentMatchIndex + 1}/${matchCount}` : '0/0'}
            </span>
            <Button
              variant='ghost'
              iconPadding='sm'
              onClick={goToPreviousMatch}
              disabled={matchCount === 0}
              aria-label='Previous match'
            >
              <ArrowUp className='size-[12px]' />
            </Button>
            <Button
              variant='ghost'
              iconPadding='sm'
              onClick={goToNextMatch}
              disabled={matchCount === 0}
              aria-label='Next match'
            >
              <ArrowDown className='size-[12px]' />
            </Button>
            <Button
              variant='ghost'
              iconPadding='sm'
              onClick={closeSearch}
              aria-label='Close search'
            >
              <X className='size-[12px]' />
            </Button>
          </div>
        )}

        {/* Context Menu - rendered in portal to avoid transform/overflow clipping */}
        {typeof document !== 'undefined' &&
          createPortal(
            <DropdownMenu
              open={isContextMenuOpen}
              onOpenChange={() => setIsContextMenuOpen(false)}
              modal={false}
            >
              <DropdownMenuTrigger asChild>
                <div
                  style={{
                    position: 'fixed',
                    left: `${contextMenuPosition.x}px`,
                    top: `${contextMenuPosition.y}px`,
                    width: '1px',
                    height: '1px',
                    pointerEvents: 'none',
                  }}
                  tabIndex={-1}
                  aria-hidden
                />
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align='start'
                side='bottom'
                sideOffset={4}
                onCloseAutoFocus={(e) => e.preventDefault()}
              >
                <DropdownMenuItem onSelect={handleCopy}>
                  <Duplicate />
                  Copy
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={handleSearch}>
                  <SearchIcon />
                  Search
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>,
            document.body
          )}
      </div>
    )
  },
  (prev, next) => prev.output === next.output
)

export type LogDetailsTab = 'overview' | 'trace'

interface LogDetailsContentProps {
  log: WorkflowLogRow
  onActiveTabChange?: (tab: LogDetailsTab) => void
}

export function LogDetailsContent({ log, onActiveTabChange }: LogDetailsContentProps) {
  const [isExecutionSnapshotOpen, setIsExecutionSnapshotOpen] = useState(false)
  const [verifyResult, setVerifyResult] = useState<VerifyExecutionCostsResponse | null>(null)
  const [verifyError, setVerifyError] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useQueryState(logDetailsTabParam.key, {
    ...logDetailsTabParam.parser,
    ...logDetailsTabUrlKeys,
  })
  const { copied: copiedRunId, copy: copyRunId } = useCopyToClipboard({ resetMs: 1500 })
  const verifyCosts = useVerifyExecutionCosts()
  /**
   * Same zone as the logs list so the details "Timestamp" field matches the
   * row the user clicked (account preference via `useTimezone()`).
   */
  const timezone = useTimezone()

  const scrollAreaRef = useRef<HTMLDivElement>(null)

  const router = useRouter()
  const { workspaceId } = useParams<{ workspaceId: string }>()

  const { config: permissionConfig } = usePermissionConfig()

  const isInitialTabMountRef = useRef(true)
  /**
   * Honors a deep-linked tab on first mount; resets to overview only when
   * switching to a different log.
   */
  useEffect(() => {
    if (isInitialTabMountRef.current) {
      isInitialTabMountRef.current = false
    } else {
      setActiveTab('overview')
    }
    setVerifyResult(null)
    setVerifyError(null)
    if (scrollAreaRef.current) {
      scrollAreaRef.current.scrollTop = 0
    }
    // stable nuqs setter; reset tab when switching logs
  }, [log.id])

  const isLikelyExecution = !!log.executionId && log.trigger !== 'mothership'
  const isWorkflowExecutionLog =
    (log.trigger === 'manual' && !!log.duration) || !!log.executionData?.traceSpans

  /**
   * The workflow this run belongs to, when it is still reachable. Null for Sim
   * agent jobs and deleted workflows, which render their label as static text.
   */
  const openableWorkflowId = resolveLogWorkflowId(log)

  const workflowLabel =
    log.trigger === 'mothership'
      ? log.jobTitle || 'Untitled Job'
      : openableWorkflowId
        ? log.workflow?.name || 'Unknown'
        : DELETED_WORKFLOW_LABEL

  const hasCostInfo = !!(isWorkflowExecutionLog && log.cost)
  const showWorkflowState =
    isWorkflowExecutionLog &&
    !!log.executionId &&
    log.trigger !== 'mothership' &&
    !permissionConfig.hideTraceSpans

  const showTraceTab = !permissionConfig.hideTraceSpans && isLikelyExecution
  // double-cast-allowed: contract schema makes duration/startTime optional for legacy persisted JSON; runtime data always supplies them.
  const traceSpans = log.executionData?.traceSpans as unknown as TraceSpan[] | undefined

  const resolvedTab: LogDetailsTab = activeTab === 'trace' && !showTraceTab ? 'overview' : activeTab

  useLayoutEffect(() => {
    onActiveTabChange?.(resolvedTab)
  }, [resolvedTab, onActiveTabChange])

  const workflowOutput = useMemo(() => {
    const executionData = log.executionData as { finalOutput?: Record<string, unknown> } | undefined
    if (!executionData?.finalOutput) return null
    return filterHiddenOutputKeys(executionData.finalOutput) as Record<string, unknown>
  }, [log.executionData])

  const workflowInput = useMemo(() => {
    const executionData = log.executionData as { workflowInput?: unknown } | undefined
    const raw = executionData?.workflowInput
    if (raw === undefined || raw === null) return null
    if (typeof raw === 'object' && !Array.isArray(raw)) {
      return raw as Record<string, unknown>
    }
    return { input: raw } as Record<string, unknown>
  }, [log.executionData])

  // Cost breakdown, sourced solely from the usage_log ledger (single source of
  // truth). Line items (Base Run / per-model / per-integration) get integer
  // credits apportioned with a single round at the total so rows always
  // reconcile (never round-then-sum, which drifts). Pre-ledger runs that only
  // have the cost_total projection show the total alone — no itemization, no
  // parallel jsonb reconstruction.
  const costBreakdown = useMemo((): {
    sections: Array<{
      label: string
      rows: Array<{ key: string; label: string; credits: number; dollars: number }>
    }>
    totalDollars: number
    tokens: { input: number; output: number }
  } | null => {
    const ledger = log.costLedger
    if (ledger && ledger.leaves.length > 0) {
      const credits = apportionCredits(
        ledger.leaves.map((leaf) => ({ key: leaf.key, dollars: leaf.dollars }))
      )
      const sections = ADDITIVE_COST_SECTIONS.map((section) => ({
        label: section.label,
        rows: ledger.leaves
          .filter((leaf) => leaf.group === section.group)
          .map((leaf) => ({
            key: leaf.key,
            label: leaf.label,
            credits: credits[leaf.key] ?? 0,
            dollars: leaf.dollars,
          })),
      })).filter((section) => section.rows.length > 0)

      return {
        sections,
        totalDollars: ledger.total,
        tokens: {
          input: ledger.items.reduce((sum, item) => sum + (item.inputTokens ?? 0), 0),
          output: ledger.items.reduce((sum, item) => sum + (item.outputTokens ?? 0), 0),
        },
      }
    }

    // Total-only (pre-ledger runs with just the cost_total projection).
    const total = log.cost?.total
    if (total == null) return null
    return {
      sections: [],
      totalDollars: total,
      tokens: { input: 0, output: 0 },
    }
  }, [log.costLedger, log.cost])

  const formattedTimestamp = formatDate(log.createdAt, timezone)
  const logStatus = getDisplayStatus(log.status)

  /**
   * Troubleshooting hands the failed run off to Chat, tagging it by
   * `executionId`. A real Chat run can't be debugged from inside itself, so
   * mothership-triggered logs are excluded — `isLikelyExecution` already encodes
   * "has an executionId and isn't a mothership run".
   */
  const canTroubleshoot = isChatEnabled && log.status === 'failed' && isLikelyExecution

  /**
   * Hands the failed run to Chat. When a chat is already mounted (e.g. the run
   * is being viewed inside Chat's resource panel) it consumes the tagged
   * message directly; otherwise a one-shot handoff is persisted and we navigate
   * to a fresh chat that picks it up on mount. Navigation is gated on a
   * successful store, so a failed write never strands the user on an empty chat.
   */
  const handleTroubleshoot = useCallback(() => {
    if (!log.executionId) return
    const workflowName = log.workflow?.name?.trim() || null
    const context: ChatContext = {
      kind: 'logs',
      executionId: log.executionId,
      label: workflowName ?? 'this run',
    }
    const message = workflowName
      ? `The "${workflowName}" workflow run failed. Investigate the error in this run and help me fix it.`
      : 'This workflow run failed. Investigate the error in this run and help me fix it.'
    if (sendMothershipMessage({ content: message, contexts: [context] })) return
    if (MothershipHandoffStorage.store({ message, contexts: [context] }, workspaceId)) {
      router.push(`/workspace/${workspaceId}/home`)
    }
  }, [log.executionId, log.workflow?.name, workspaceId, router])

  return (
    <>
      <div className='mt-4 flex min-h-0 flex-1 flex-col'>
        <ChipModalTabs
          tabs={[
            { value: 'overview', label: 'Overview' },
            ...(showTraceTab ? [{ value: 'trace', label: 'Trace' }] : []),
          ]}
          value={resolvedTab}
          onChange={(v) => setActiveTab(v as LogDetailsTab)}
        />

        {/* Overview Tab */}
        {resolvedTab === 'overview' && (
          <div ref={scrollAreaRef} className='mt-4 min-h-0 flex-1 overflow-y-auto'>
            <div className='flex flex-col gap-2.5 pb-4'>
              {/* Timestamp + Workflow header */}
              <div className='grid grid-cols-2 gap-x-3 pb-0.5'>
                <div className='flex min-w-0 flex-col gap-0.5'>
                  <span className='text-[var(--text-tertiary)] text-caption'>Timestamp</span>
                  <span className='text-[var(--text-secondary)] text-sm tabular-nums'>
                    {formattedTimestamp
                      ? `${formattedTimestamp.compactDate} ${formattedTimestamp.compactTime}`
                      : '—'}
                  </span>
                </div>
                <div className='flex min-w-0 flex-col gap-0.5'>
                  <span className='text-[var(--text-tertiary)] text-caption'>
                    {log.trigger === 'mothership' ? 'Job' : 'Workflow'}
                  </span>
                  {openableWorkflowId ? (
                    <Link
                      href={workflowEditorPath(workspaceId, openableWorkflowId)}
                      target='_blank'
                      rel='noopener noreferrer'
                      prefetch={false}
                      className='-mx-1.5 -my-0.5 group flex w-fit min-w-0 max-w-[calc(100%+0.75rem)] items-center gap-1.5 rounded-[5px] px-1.5 py-0.5 transition-colors hover-hover:bg-[var(--surface-active)] focus-visible:bg-[var(--surface-active)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[color-mix(in_srgb,var(--text-muted)_30%,transparent)]'
                    >
                      <span className='inline-grid size-[14px] shrink-0 place-items-center'>
                        <Workflow className='col-start-1 row-start-1 size-[14px] text-[var(--text-icon)] opacity-100 blur-0 transition-[opacity,filter,transform] duration-200 ease-in-out group-hover:scale-[0.25] group-hover:opacity-0 group-hover:blur-[2px] group-focus-visible:scale-[0.25] group-focus-visible:opacity-0 group-focus-visible:blur-[2px] motion-reduce:transition-none' />
                        <SquareArrowUpRight className='col-start-1 row-start-1 size-[14px] scale-[0.25] text-[var(--text-icon)] opacity-0 blur-[2px] transition-[opacity,filter,transform] duration-200 ease-in-out group-hover:scale-100 group-hover:opacity-100 group-hover:blur-0 group-focus-visible:scale-100 group-focus-visible:opacity-100 group-focus-visible:blur-0 motion-reduce:transition-none' />
                      </span>
                      <span className='min-w-0 truncate text-[var(--text-secondary)] text-sm transition-colors group-hover:text-[var(--text-primary)] group-focus-visible:text-[var(--text-primary)]'>
                        {workflowLabel}
                      </span>
                      <span className='sr-only'>(opens in a new tab)</span>
                    </Link>
                  ) : (
                    <div className='flex min-w-0 items-center gap-1.5'>
                      <Workflow className='size-[14px] flex-shrink-0 text-[var(--text-icon)]' />
                      <span className='min-w-0 truncate text-[var(--text-secondary)] text-sm'>
                        {workflowLabel}
                      </span>
                    </div>
                  )}
                </div>
              </div>

              {/* Details Section */}
              <div className='divide-y divide-[var(--border)] overflow-hidden rounded-md border border-[var(--border)] bg-[var(--surface-2)] dark:bg-transparent'>
                {/* Run ID — click to copy */}
                {log.executionId && (
                  <div
                    role='button'
                    tabIndex={0}
                    aria-label='Copy run ID'
                    className='flex h-10 min-w-0 cursor-pointer items-center justify-between gap-4 px-3 transition-colors hover-hover:bg-[var(--surface-active)]'
                    onClick={() => copyRunId(log.executionId!)}
                    onKeyDown={(event) =>
                      handleKeyboardActivation(event, () => copyRunId(log.executionId!))
                    }
                  >
                    <span className='flex-shrink-0 text-[var(--text-tertiary)] text-caption'>
                      Run ID
                    </span>
                    <span className='min-w-0 truncate text-[var(--text-secondary)] text-caption tabular-nums'>
                      {copiedRunId ? 'Copied!' : log.executionId}
                    </span>
                  </div>
                )}

                {/* Level */}
                <div className='flex h-10 items-center justify-between px-3'>
                  <span className='text-[var(--text-tertiary)] text-caption'>Level</span>
                  <StatusBadge status={logStatus} />
                </div>

                {/* Trigger */}
                <div className='flex h-10 items-center justify-between px-3'>
                  <span className='text-[var(--text-tertiary)] text-caption'>Trigger</span>
                  {log.trigger ? (
                    <TriggerBadge trigger={log.trigger} />
                  ) : (
                    <span className='text-[var(--text-secondary)] text-caption'>None</span>
                  )}
                </div>

                {/* Duration */}
                <div className='flex h-10 items-center justify-between px-3'>
                  <span className='text-[var(--text-tertiary)] text-caption'>Duration</span>
                  <span className='text-[var(--text-secondary)] text-caption tabular-nums'>
                    {formatDuration(log.duration, { precision: 2 }) || '—'}
                  </span>
                </div>

                {/* Version */}
                {log.deploymentVersion && (
                  <div className='flex h-10 items-center gap-2 px-3'>
                    <span className='flex-shrink-0 text-[var(--text-tertiary)] text-caption'>
                      Version
                    </span>
                    <div className='flex w-0 flex-1 justify-end'>
                      <Badge variant='green' size='sm' className='max-w-full truncate'>
                        {log.deploymentVersionName || `v${log.deploymentVersion}`}
                      </Badge>
                    </div>
                  </div>
                )}

                {/* Snapshot */}
                {showWorkflowState && (
                  <div className='flex h-10 items-center justify-between px-3'>
                    <span className='text-[var(--text-tertiary)] text-caption'>Snapshot</span>
                    <Chip leftIcon={Eye} onClick={() => setIsExecutionSnapshotOpen(true)}>
                      View Snapshot
                    </Chip>
                  </div>
                )}

                {/* Troubleshoot */}
                {canTroubleshoot && (
                  <div className='flex h-10 items-center justify-between px-3'>
                    <span className='text-[var(--text-tertiary)] text-caption'>Troubleshoot</span>
                    <Chip leftIcon={Wrench} onClick={handleTroubleshoot}>
                      Troubleshoot in Chat
                    </Chip>
                  </div>
                )}
              </div>

              {/* Workflow Input */}
              {isWorkflowExecutionLog && workflowInput && !permissionConfig.hideTraceSpans && (
                <div className='flex flex-col gap-1.5 rounded-md border border-[var(--border)] bg-[var(--surface-2)] px-2.5 py-2 dark:bg-transparent'>
                  <span className='text-[var(--text-tertiary)] text-caption'>Workflow Input</span>
                  <WorkflowOutputSection output={workflowInput} />
                </div>
              )}

              {/* Workflow Output */}
              {isWorkflowExecutionLog && workflowOutput && !permissionConfig.hideTraceSpans && (
                <div className='flex flex-col gap-1.5 rounded-md border border-[var(--border)] bg-[var(--surface-2)] px-2.5 py-2 dark:bg-transparent'>
                  <span
                    className={cn(
                      'text-caption',
                      workflowOutput.error
                        ? 'text-[var(--text-error)]'
                        : 'text-[var(--text-tertiary)]'
                    )}
                  >
                    Workflow Output
                  </span>
                  <WorkflowOutputSection output={workflowOutput} />
                </div>
              )}

              {/* Files */}
              {log.files && log.files.length > 0 && <FileCards files={log.files} isExecutionFile />}

              {/* Cost Breakdown */}
              {hasCostInfo && costBreakdown && (
                <div className='divide-y divide-[var(--border)] overflow-hidden rounded-md border border-[var(--border)] bg-[var(--surface-2)] dark:bg-transparent'>
                  {costBreakdown.sections.map((section) => (
                    <div key={section.label}>
                      <div className='flex h-8 items-center bg-[var(--surface-3)] px-3 dark:bg-[var(--surface-2)]'>
                        <span className='font-medium text-[var(--text-secondary)] text-caption'>
                          {section.label}
                        </span>
                      </div>
                      {section.rows.map((row) => (
                        <div
                          key={row.key}
                          className='flex h-10 items-center justify-between px-3 transition-colors hover-hover:bg-[var(--surface-2)]'
                        >
                          <span className='min-w-0 truncate pl-2 font-medium text-[var(--text-tertiary)] text-caption'>
                            {row.label}
                          </span>
                          <span className='flex-shrink-0 font-medium text-[var(--text-secondary)] text-caption tabular-nums'>
                            {formatApportionedCreditCost(row.credits, row.dollars > 0)}
                          </span>
                        </div>
                      ))}
                    </div>
                  ))}
                  <div className='flex h-10 items-center justify-between px-3'>
                    <span className='font-medium text-[var(--text-secondary)] text-caption'>
                      Total
                    </span>
                    <span className='font-semibold text-[var(--text-primary)] text-caption tabular-nums'>
                      {formatCreditCost(costBreakdown.totalDollars) ?? '0 credits'}
                    </span>
                  </div>
                  {(costBreakdown.tokens.input > 0 || costBreakdown.tokens.output > 0) && (
                    <div className='flex h-10 items-center justify-between px-3'>
                      <span className='text-[var(--text-tertiary)] text-caption'>Tokens</span>
                      <span className='text-[var(--text-secondary)] text-caption tabular-nums'>
                        {costBreakdown.tokens.input} in · {costBreakdown.tokens.output} out
                      </span>
                    </div>
                  )}
                  <div className='flex flex-col gap-2 px-3 py-2'>
                    <p className='font-medium text-[var(--text-tertiary)] text-xs'>
                      Total includes the base run charge plus model and tool usage (billable
                      credits).
                    </p>
                    {log.executionId && (
                      <div className='flex items-center gap-2'>
                        <Button
                          variant='ghost'
                          className='h-7 gap-1 px-2'
                          disabled={verifyCosts.isPending}
                          onClick={() => {
                            setVerifyError(null)
                            verifyCosts.mutate(log.executionId as string, {
                              onSuccess: (data) => {
                                setVerifyResult(data)
                              },
                              onError: (error) => {
                                setVerifyResult(null)
                                setVerifyError(getErrorMessage(error, 'Failed to verify pricing'))
                              },
                            })
                          }}
                        >
                          {verifyCosts.isPending ? 'Verifying…' : 'Verify pricing'}
                        </Button>
                      </div>
                    )}
                  </div>
                </div>
              )}

              {verifyError && (
                <div className='rounded-md border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 dark:bg-transparent'>
                  <p className='font-medium text-[var(--text-error)] text-caption'>{verifyError}</p>
                </div>
              )}

              {verifyResult && (
                <div className='divide-y divide-[var(--border)] overflow-hidden rounded-md border border-[var(--border)] bg-[var(--surface-2)] dark:bg-transparent'>
                  <div className='flex flex-col gap-1 bg-[var(--surface-3)] px-3 py-2 dark:bg-[var(--surface-2)]'>
                    <span className='font-medium text-[var(--text-secondary)] text-caption'>
                      Pricing verification
                    </span>
                    <span className='font-medium text-[var(--text-tertiary)] text-xs'>
                      class={verifyResult.primaryClass} · confidence={verifyResult.confidence} ·
                      read-only
                    </span>
                  </div>
                  <div className='flex h-9 items-center justify-between px-3'>
                    <span className='font-medium text-[var(--text-tertiary)] text-caption'>
                      Billed total
                    </span>
                    <span className='font-medium text-[var(--text-secondary)] text-caption tabular-nums'>
                      {formatCost(verifyResult.billed.total)}
                    </span>
                  </div>
                  <div className='flex h-9 items-center justify-between px-3'>
                    <span className='font-medium text-[var(--text-tertiary)] text-caption'>
                      Expected total
                    </span>
                    <span className='font-medium text-[var(--text-secondary)] text-caption tabular-nums'>
                      {formatCost(verifyResult.expected.total)}
                    </span>
                  </div>
                  <div className='flex h-9 items-center justify-between px-3'>
                    <span className='font-medium text-[var(--text-tertiary)] text-caption'>
                      Positive delta
                    </span>
                    <span
                      className={cn(
                        'font-medium text-caption tabular-nums',
                        verifyResult.deltas.positive > 0
                          ? 'text-[var(--text-error)]'
                          : 'text-[var(--text-secondary)]'
                      )}
                    >
                      {formatCost(verifyResult.deltas.positive)}
                    </span>
                  </div>
                  <div className='flex h-9 items-center justify-between px-3'>
                    <span className='font-medium text-[var(--text-tertiary)] text-caption'>
                      Negative delta
                    </span>
                    <span
                      className={cn(
                        'font-medium text-caption tabular-nums',
                        verifyResult.deltas.negative > 0
                          ? 'text-[var(--text-warning)]'
                          : 'text-[var(--text-secondary)]'
                      )}
                    >
                      {formatCost(verifyResult.deltas.negative)}
                    </span>
                  </div>
                  {verifyResult.blockers.length > 0 && (
                    <div className='px-3 py-2'>
                      <p className='mb-1 font-medium text-[var(--text-secondary)] text-caption'>
                        Blockers
                      </p>
                      <ul className='flex flex-col gap-0.5'>
                        {verifyResult.blockers.map((blocker) => (
                          <li
                            key={blocker}
                            className='font-medium text-[var(--text-error)] text-xs'
                          >
                            {blocker}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {verifyResult.warnings.length > 0 && (
                    <div className='px-3 py-2'>
                      <p className='mb-1 font-medium text-[var(--text-secondary)] text-caption'>
                        Warnings
                      </p>
                      <ul className='flex flex-col gap-0.5'>
                        {verifyResult.warnings.map((warning) => (
                          <li
                            key={warning}
                            className='font-medium text-[var(--text-tertiary)] text-xs'
                          >
                            {warning}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                  {verifyResult.expected.lines.length > 0 && (
                    <div className='px-3 py-2'>
                      <p className='mb-1 font-medium text-[var(--text-secondary)] text-caption'>
                        Expected lines
                      </p>
                      <ul className='flex flex-col gap-1'>
                        {verifyResult.expected.lines.map((line) => (
                          <li
                            key={`${line.category}:${line.description}`}
                            className='flex items-center justify-between gap-2'
                          >
                            <span className='min-w-0 truncate font-medium text-[var(--text-tertiary)] text-xs'>
                              {line.description}
                            </span>
                            <span className='flex-shrink-0 font-medium text-[var(--text-secondary)] text-xs tabular-nums'>
                              {formatCost(line.target)}
                            </span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        )}

        {/* Trace Tab */}
        {showTraceTab && resolvedTab === 'trace' && (
          <div className='mt-3 min-h-0 flex-1 overflow-hidden focus-visible:outline-none'>
            {traceSpans?.length ? (
              <TraceView traceSpans={traceSpans} runCostDollars={log.cost?.total} />
            ) : log.executionData ? (
              <div className='flex h-full items-center justify-center px-4 text-center'>
                <span className='text-[var(--text-tertiary)] text-sm'>
                  No trace data available for this run
                </span>
              </div>
            ) : (
              <div className='flex h-full items-center justify-center px-4 text-center'>
                <span className='text-[var(--text-tertiary)] text-sm'>Loading trace…</span>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Frozen Canvas Modal */}
      {log.executionId && (
        <ExecutionSnapshot
          executionId={log.executionId}
          traceSpans={traceSpans}
          isModal
          isOpen={isExecutionSnapshotOpen}
          onClose={() => setIsExecutionSnapshotOpen(false)}
        />
      )}
    </>
  )
}

interface LogDetailsProps {
  log: WorkflowLogRow | null
  isOpen: boolean
  onClose: () => void
  onNavigateNext?: () => void
  onNavigatePrev?: () => void
  hasNext?: boolean
  hasPrev?: boolean
  onRetryExecution?: () => void
  isRetryPending?: boolean
  onActiveTabChange?: (tab: LogDetailsTab) => void
}

export const LogDetails = memo(function LogDetails({
  log,
  isOpen,
  onClose,
  onNavigateNext,
  onNavigatePrev,
  hasNext = false,
  hasPrev = false,
  onRetryExecution,
  isRetryPending = false,
  onActiveTabChange,
}: LogDetailsProps) {
  const activeTabRef = useRef<LogDetailsTab>('overview')

  const handleActiveTabChange = useCallback(
    (tab: LogDetailsTab) => {
      activeTabRef.current = tab
      onActiveTabChange?.(tab)
    },
    [onActiveTabChange]
  )

  const panelWidth = useLogDetailsUIStore((state) => state.panelWidth)
  const { handleMouseDown } = useLogDetailsResize()

  const maxVw = `${MAX_LOG_DETAILS_WIDTH_RATIO * 100}vw`
  const effectiveWidth = `clamp(min(${MIN_LOG_DETAILS_WIDTH}px, ${maxVw}), ${panelWidth}px, ${maxVw})`

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) {
        onClose()
      }

      if (!isOpen) return

      // Trace tab owns arrow keys for span navigation.
      if (activeTabRef.current === 'trace') return

      if (e.key === 'ArrowUp' && hasPrev && onNavigatePrev) {
        e.preventDefault()
        onNavigatePrev()
      }

      if (e.key === 'ArrowDown' && hasNext && onNavigateNext) {
        e.preventDefault()
        onNavigateNext()
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isOpen, onClose, hasPrev, hasNext, onNavigatePrev, onNavigateNext])

  return (
    <DetailsPanel
      open={isOpen}
      width={effectiveWidth}
      onResizeStart={handleMouseDown}
      resizeLabel='Resize log details panel'
      aria-label='Log details sidebar'
    >
      {log && (
        <div className='flex h-full flex-col px-3.5 pt-3'>
          {/* Header */}
          <div className='flex items-center justify-between'>
            <h2 className='text-[var(--text-primary)] text-sm'>Log Details</h2>
            <div className='flex items-center gap-[1px]'>
              {log.status === 'failed' &&
                (log.workflow?.id || log.workflowId) &&
                log.trigger !== 'mothership' && (
                  <Tooltip.Root>
                    <Tooltip.Trigger asChild>
                      <Button
                        variant='ghost'
                        iconPadding='sm'
                        onClick={() => onRetryExecution?.()}
                        disabled={isRetryPending}
                        aria-label='Retry execution'
                      >
                        <Redo className='size-[14px]' />
                      </Button>
                    </Tooltip.Trigger>
                    <Tooltip.Content side='bottom'>Retry</Tooltip.Content>
                  </Tooltip.Root>
                )}
              <Button
                variant='ghost'
                iconPadding='sm'
                onClick={() => hasPrev && onNavigatePrev?.()}
                disabled={!hasPrev}
                aria-label='Previous log'
              >
                <ChevronUp className='size-[14px]' />
              </Button>
              <Button
                variant='ghost'
                iconPadding='sm'
                onClick={() => hasNext && onNavigateNext?.()}
                disabled={!hasNext}
                aria-label='Next log'
              >
                <ChevronUp className='size-[14px] rotate-180' />
              </Button>
              <Button variant='ghost' iconPadding='sm' onClick={onClose} aria-label='Close'>
                <X className='size-[14px]' />
              </Button>
            </div>
          </div>

          <LogDetailsContent log={log} onActiveTabChange={handleActiveTabChange} />
        </div>
      )}
    </DetailsPanel>
  )
})
