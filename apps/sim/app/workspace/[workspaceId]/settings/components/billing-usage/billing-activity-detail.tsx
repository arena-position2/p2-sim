'use client'

import { useState } from 'react'
import {
  Calendar,
  Chip,
  ChipButtonGroup,
  ChipButtonGroupItem,
  ChipSelect,
  chipVariants,
  cn,
  Popover,
  PopoverAnchor,
  PopoverContent,
  toast,
} from '@sim/emcn'
import { Download, RefreshCw } from '@sim/emcn/icons'
import { formatDateTime } from '@sim/utils/formatting'
import { useQueryClient } from '@tanstack/react-query'
import { useParams } from 'next/navigation'
import type { UsageLogEntry, UsageLogPeriod, UsageLogSourceGroup } from '@/lib/api/contracts/user'
import { formatApportionedCreditCost } from '@/lib/billing/credits/conversion'
import { formatDateShort } from '@/lib/core/utils/date-display'
import { BillingUsageSection } from '@/app/workspace/[workspaceId]/settings/components/billing-usage/billing-usage-section'
import { SettingsEmptyState } from '@/app/workspace/[workspaceId]/settings/components/settings-empty-state'
import { useUsageLogs } from '@/hooks/queries/usage-logs'
import { usageLogKeys } from '@/hooks/queries/utils/usage-log-keys'
import { useWorkspacesQuery } from '@/hooks/queries/workspace'

const SOURCE_TABS = [
  { id: 'all', label: 'All sources' },
  { id: 'workflow', label: 'Workflows' },
  { id: 'mothership', label: 'Mothership' },
] as const

const PERIOD_TABS = [
  { id: '1d', label: '24 hours' },
  { id: '7d', label: '7 days' },
  { id: '30d', label: '30 days' },
  { id: '90d', label: '90 days' },
  { id: 'all', label: 'All time' },
  { id: 'custom', label: 'Custom' },
] as const

type SourceTab = (typeof SOURCE_TABS)[number]['id']

/** Workflow-sourced rows name the specific workflow; everything else uses the plain source label. */
function rowLabel(log: UsageLogEntry): string {
  if (log.source === 'workflow' && log.workflowName) return `Workflow: ${log.workflowName}`
  return log.sourceLabel
}

interface UsageLogRowProps {
  log: UsageLogEntry
}

function UsageLogRow({ log }: UsageLogRowProps) {
  return (
    <div className='flex items-center gap-2.5 rounded-lg px-1 py-2 text-left'>
      <span className='w-[150px] flex-shrink-0 text-[var(--text-muted)] text-caption'>
        {formatDateTime(new Date(log.createdAt))}
      </span>
      <span className='min-w-0 flex-1 truncate text-[var(--text-body)] text-sm'>
        {rowLabel(log)}
      </span>
      <span className='flex-shrink-0 text-[var(--text-muted)] text-caption tabular-nums'>
        {formatApportionedCreditCost(log.creditCost, log.hasCost)}
      </span>
    </div>
  )
}

interface BillingActivityDetailProps {
  /** Invoked after a successful manual refresh so parent summaries can refetch too. */
  onRefresh?: () => void
}

/**
 * Filterable activity log for personal credit usage — source / period /
 * workspace controls plus infinite-scroll rows and CSV export.
 */
export function BillingActivityDetail({ onRefresh }: BillingActivityDetailProps) {
  const { workspaceId } = useParams<{ workspaceId: string }>()
  const queryClient = useQueryClient()
  const { data: workspaces = [] } = useWorkspacesQuery()

  const [sourceTab, setSourceTab] = useState<SourceTab>('all')
  const [period, setPeriod] = useState<UsageLogPeriod>('30d')
  const [startDate, setStartDate] = useState<string | null>(null)
  const [endDate, setEndDate] = useState<string | null>(null)
  const [workspaceFilter, setWorkspaceFilter] = useState<string>('current')
  const [datePickerOpen, setDatePickerOpen] = useState(false)
  const [isRefreshing, setIsRefreshing] = useState(false)

  const sourceGroup: UsageLogSourceGroup | undefined = sourceTab === 'all' ? undefined : sourceTab
  const resolvedWorkspaceId =
    workspaceFilter === 'current'
      ? workspaceId
      : workspaceFilter === 'all'
        ? undefined
        : workspaceFilter

  const {
    data,
    isLoading,
    isError,
    isPlaceholderData,
    isFetching,
    hasNextPage,
    isFetchingNextPage,
    fetchNextPage,
    refetch,
  } = useUsageLogs({
    period,
    startDate: period === 'custom' ? startDate || undefined : undefined,
    endDate: period === 'custom' ? endDate || undefined : undefined,
    sourceGroup,
    workspaceId: resolvedWorkspaceId,
  })

  const logs = data?.pages.flatMap((page) => page.logs) ?? []

  const workspaceOptions = [
    { value: 'current', label: 'Current workspace' },
    { value: 'all', label: 'All workspaces' },
    ...workspaces
      .filter((workspace) => workspace.id !== workspaceId)
      .map((workspace) => ({ value: workspace.id, label: workspace.name })),
  ]

  const handlePeriodChange = (value: string) => {
    if (value === 'custom') {
      setDatePickerOpen(true)
      return
    }
    setPeriod(value as UsageLogPeriod)
    setStartDate(null)
    setEndDate(null)
  }

  const handleDateRangeApply = (nextStart: string, nextEnd: string) => {
    setPeriod('custom')
    setStartDate(nextStart)
    setEndDate(nextEnd)
    setDatePickerOpen(false)
  }

  const handleRefresh = async () => {
    setIsRefreshing(true)
    try {
      await Promise.all([refetch(), queryClient.invalidateQueries({ queryKey: usageLogKeys.all })])
      onRefresh?.()
    } finally {
      setIsRefreshing(false)
    }
  }

  const handleExport = async () => {
    const params = new URLSearchParams({ period })
    if (sourceGroup) params.set('sourceGroup', sourceGroup)
    if (resolvedWorkspaceId) params.set('workspaceId', resolvedWorkspaceId)
    if (period === 'custom') {
      if (startDate) params.set('startDate', startDate)
      if (endDate) params.set('endDate', endDate)
    }

    // boundary-raw-fetch: downloads a CSV blob and reads a response header before saving — a plain anchor navigation can't do either
    const response = await fetch(`/api/users/me/usage-logs/export?${params.toString()}`)
    if (!response.ok) {
      toast.error('Failed to export usage logs')
      return
    }
    if (response.headers.get('X-Export-Truncated') === '1') {
      toast.info('Export truncated — narrow the date range to see everything')
    }

    const blob = await response.blob()
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `credit-usage-${period}-${new Date().toISOString().slice(0, 10)}.csv`
    document.body.appendChild(link)
    link.click()
    link.remove()
    URL.revokeObjectURL(url)
  }

  const customRangeLabel =
    period === 'custom' && startDate && endDate
      ? `${formatDateShort(startDate)} – ${formatDateShort(endDate)}`
      : null

  return (
    <BillingUsageSection
      label='Activity detail'
      action={
        <div className='flex items-center gap-2'>
          <Chip
            leftIcon={RefreshCw}
            disabled={isRefreshing || isFetching}
            onClick={() => void handleRefresh()}
          >
            Refresh
          </Chip>
          <Chip
            leftIcon={Download}
            disabled={logs.length === 0 || isPlaceholderData}
            onClick={() => void handleExport()}
          >
            Export CSV
          </Chip>
        </div>
      }
    >
      <div className='flex flex-col gap-4'>
        <div className='flex flex-wrap items-center gap-3'>
          <ChipButtonGroup
            value={sourceTab}
            onValueChange={(value) => setSourceTab(value as SourceTab)}
          >
            {SOURCE_TABS.map((tab) => (
              <ChipButtonGroupItem key={tab.id} value={tab.id}>
                {tab.label}
              </ChipButtonGroupItem>
            ))}
          </ChipButtonGroup>

          <div className='relative'>
            <ChipButtonGroup value={period} onValueChange={handlePeriodChange}>
              {PERIOD_TABS.map((tab) => (
                <ChipButtonGroupItem key={tab.id} value={tab.id}>
                  {tab.id === 'custom' && customRangeLabel ? customRangeLabel : tab.label}
                </ChipButtonGroupItem>
              ))}
            </ChipButtonGroup>
            <Popover
              open={datePickerOpen}
              onOpenChange={(isOpen) => {
                if (!isOpen) setDatePickerOpen(false)
              }}
            >
              <PopoverAnchor className='pointer-events-none absolute inset-0' />
              <PopoverContent align='start' sideOffset={4} className='w-auto p-0'>
                <Calendar
                  mode='range'
                  showTime
                  startDate={startDate ?? undefined}
                  endDate={endDate ?? undefined}
                  onRangeChange={handleDateRangeApply}
                  onCancel={() => setDatePickerOpen(false)}
                />
              </PopoverContent>
            </Popover>
          </div>

          <ChipSelect
            align='end'
            value={workspaceFilter}
            onChange={setWorkspaceFilter}
            options={workspaceOptions}
          />
        </div>

        <div
          className={cn(
            '-mx-1 flex flex-col gap-y-0.5',
            isPlaceholderData && 'opacity-50 transition-opacity'
          )}
        >
          {isLoading ? (
            <SettingsEmptyState variant='inline'>Loading usage…</SettingsEmptyState>
          ) : isError ? (
            <SettingsEmptyState variant='inline'>Couldn't load credit usage.</SettingsEmptyState>
          ) : logs.length === 0 ? (
            <SettingsEmptyState variant='inline'>
              No credit usage in this period.
            </SettingsEmptyState>
          ) : (
            <>
              {logs.map((log) => (
                <UsageLogRow key={log.id} log={log} />
              ))}
              {hasNextPage ? (
                <button
                  type='button'
                  onClick={() => fetchNextPage()}
                  disabled={isFetchingNextPage}
                  aria-label='Load more usage'
                  className={cn(
                    chipVariants({ fullWidth: true }),
                    'text-[var(--text-muted)] text-small'
                  )}
                >
                  {isFetchingNextPage ? 'Loading…' : 'Load more'}
                </button>
              ) : null}
            </>
          )}
        </div>
      </div>
    </BillingUsageSection>
  )
}
