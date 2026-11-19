'use client'

import { useMemo, useState } from 'react'
import { Checkbox, Chip, ChipButtonGroup, ChipButtonGroupItem, ChipTag, cn, toast } from '@sim/emcn'
import { ArrowLeft } from '@sim/emcn/icons'
import { getErrorMessage } from '@sim/utils/errors'
import Link from 'next/link'
import { useParams, useRouter } from 'next/navigation'
import type {
  AgentAccessRequestDecisionStatus,
  AgentAccessRequestRow,
} from '@/lib/api/contracts/agent-access-requests'
import { useSession } from '@/lib/auth/auth-client'
import { APP_ENTRY_PATH } from '@/lib/navigation/paths'
import {
  SettingsEmptyState,
  SettingsQueryErrorState,
} from '@/app/workspace/[workspaceId]/settings/components/settings-empty-state'
import { SettingsPanel } from '@/app/workspace/[workspaceId]/settings/components/settings-panel'
import { useBrandConfig } from '@/ee/whitelabeling/branding'
import {
  useAgentAccessRequests,
  useApproveAgentAccessRequests,
} from '@/hooks/queries/agent-access-requests'

const COLUMNS = [
  { key: 'agent_name', label: 'Agent' },
  { key: 'status', label: 'Status' },
  { key: 'requested_user_email', label: 'Requested by' },
  { key: 'workflow_id', label: 'Workflow ID' },
  { key: 'workspace_id', label: 'Workspace ID' },
  { key: 'approved_by', label: 'Approved by / Rejected by' },
  { key: 'created_at', label: 'Created' },
  { key: 'updated_at', label: 'Updated' },
] as const satisfies ReadonlyArray<{
  key: keyof AgentAccessRequestRow
  label: string
}>

const STATUS_FILTERS = [
  { value: 'all', label: 'All' },
  { value: 'open', label: 'Open' },
  { value: 'done', label: 'Done' },
  { value: 'cancelled', label: 'Cancelled' },
] as const

type StatusFilter = (typeof STATUS_FILTERS)[number]['value']

interface AgentAccessRequestProps {
  /**
   * Full-page inbox at `/agent-access-request` — no settings chrome / left nav.
   * Lists across workspaces when no workspace id is in the route.
   */
  standalone?: boolean
}

/** Collapses API aliases (`approved` → `done`, `declined` → `cancelled`). */
function normalizeStatus(status: string): string {
  const normalized = status.trim().toLowerCase()
  if (normalized === 'approved') return 'done'
  if (normalized === 'declined') return 'cancelled'
  return normalized
}

function isSelectableRow(row: AgentAccessRequestRow): boolean {
  const status = normalizeStatus(row.status)
  return status === 'open' || status === 'cancelled'
}

function matchesStatusFilter(row: AgentAccessRequestRow, filter: StatusFilter): boolean {
  if (filter === 'all') return true
  return normalizeStatus(row.status) === filter
}

function formatDate(value: string | null | undefined): string {
  if (!value) return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

function formatCellValue(key: keyof AgentAccessRequestRow, value: unknown): string {
  if (value === null || value === undefined || value === '') return '—'
  if (key === 'created_at' || key === 'updated_at') {
    return formatDate(typeof value === 'string' ? value : String(value))
  }
  return String(value)
}

function statusTagProps(status: string): {
  variant: 'workflow' | 'gray'
  tone?: 'blue' | 'green' | 'orange' | 'neutral'
} {
  switch (normalizeStatus(status)) {
    case 'open':
      return { variant: 'workflow', tone: 'blue' }
    case 'done':
      return { variant: 'workflow', tone: 'green' }
    case 'cancelled':
      return { variant: 'workflow', tone: 'orange' }
    default:
      return { variant: 'gray' }
  }
}

/** Platform-admin surface for reviewing agent access requests. */
export function AgentAccessRequest({ standalone = false }: AgentAccessRequestProps) {
  const router = useRouter()
  const params = useParams()
  const routeWorkspaceId = typeof params?.workspaceId === 'string' ? params.workspaceId : undefined
  /** Standalone inbox lists globally; settings section stays scoped to the workspace. */
  const workspaceId = standalone ? undefined : routeWorkspaceId
  const brand = useBrandConfig()
  /** Same asset as the expanded left-nav brand header (`wordmark` → logo fallbacks). */
  const brandLogoSrc = brand.wordmarkUrl || brand.logoUrl || brand.logoUrlBlacktext || ''
  const { data: session } = useSession()
  const approvedByEmail = session?.user?.email?.trim() ?? ''
  const {
    data: rows,
    isPending,
    isError,
    error,
    refetch,
    isFetching,
  } = useAgentAccessRequests(workspaceId)
  const approveMutation = useApproveAgentAccessRequests()
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set())
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')

  const filteredRows = useMemo(
    () => (rows ?? []).filter((row) => matchesStatusFilter(row, statusFilter)),
    [rows, statusFilter]
  )
  const selectableRows = useMemo(() => filteredRows.filter(isSelectableRow), [filteredRows])
  const selectedCount = selectedIds.size
  const allSelectableSelected =
    selectableRows.length > 0 && selectableRows.every((row) => selectedIds.has(row.id))
  const canDecide = selectedCount > 0 && Boolean(approvedByEmail) && !approveMutation.isPending

  const changeStatusFilter = (value: string) => {
    const next = STATUS_FILTERS.some((filter) => filter.value === value)
      ? (value as StatusFilter)
      : 'all'
    setStatusFilter(next)
    setSelectedIds(new Set())
  }

  const toggleRow = (rowId: string, checked: boolean) => {
    setSelectedIds((previous) => {
      const next = new Set(previous)
      if (checked) next.add(rowId)
      else next.delete(rowId)
      return next
    })
  }

  const toggleAllSelectable = (checked: boolean) => {
    setSelectedIds(() => {
      if (!checked) return new Set()
      return new Set(selectableRows.map((row) => row.id))
    })
  }

  const applyDecision = (status: AgentAccessRequestDecisionStatus) => {
    const accessIds = Array.from(selectedIds)
    if (accessIds.length === 0 || approveMutation.isPending || !approvedByEmail) return

    approveMutation.mutate(
      { accessIds, status, approvedBy: approvedByEmail },
      {
        onSuccess: async () => {
          setSelectedIds(new Set())
          toast.success(status === 'done' ? 'Access approved' : 'Access cancelled', {
            description: `Updated ${accessIds.length} request${accessIds.length === 1 ? '' : 's'}.`,
          })
          await refetch()
        },
        onError: (mutationError) => {
          toast.error('Unable to update requests', {
            description: getErrorMessage(mutationError, 'Please try again.'),
          })
        },
      }
    )
  }

  const statusFilterControls = (
    <ChipButtonGroup value={statusFilter} onValueChange={changeStatusFilter}>
      {STATUS_FILTERS.map((filter) => (
        <ChipButtonGroupItem key={filter.value} value={filter.value}>
          {filter.label}
        </ChipButtonGroupItem>
      ))}
    </ChipButtonGroup>
  )

  const body = isPending ? (
    <SettingsEmptyState>Loading agent access requests...</SettingsEmptyState>
  ) : isError ? (
    <SettingsQueryErrorState
      error={error}
      fallback='Unable to load agent access requests'
      isRetrying={isFetching}
      onRetry={() => void refetch()}
    />
  ) : !rows || rows.length === 0 ? (
    <SettingsEmptyState>No agent access requests.</SettingsEmptyState>
  ) : (
    <div className='flex flex-col gap-3'>
      <div className='flex flex-wrap items-center justify-between gap-3'>
        {statusFilterControls}
        <p className='text-[var(--text-muted)] text-sm'>
          {selectedCount > 0
            ? `${selectedCount} selected — choose Approve or Cancel.`
            : 'Select open or cancelled requests, then Approve or Cancel. Done rows are view-only.'}
        </p>
      </div>
      {filteredRows.length === 0 ? (
        <SettingsEmptyState>
          No {statusFilter === 'all' ? '' : `${statusFilter} `}agent access requests.
        </SettingsEmptyState>
      ) : (
        <div className='overflow-hidden rounded-xl border border-[var(--border-1)] bg-[var(--bg)]'>
          <div className='overflow-x-auto'>
            <table className='w-full min-w-[56rem] border-collapse text-left text-small'>
              <thead>
                <tr className='border-[var(--border-1)] border-b bg-[var(--surface-2)]'>
                  <th className='w-10 px-4 py-3'>
                    <Checkbox
                      checked={allSelectableSelected}
                      disabled={selectableRows.length === 0 || approveMutation.isPending}
                      onCheckedChange={(checked) => toggleAllSelectable(checked === true)}
                      aria-label='Select all open or cancelled requests in this filter'
                    />
                  </th>
                  {COLUMNS.map((column) => (
                    <th
                      key={column.key}
                      className='whitespace-nowrap px-4 py-3 font-normal text-[var(--text-muted)]'
                    >
                      {column.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filteredRows.map((row) => {
                  const selectable = isSelectableRow(row)
                  const checked = selectedIds.has(row.id)
                  const displayStatus = normalizeStatus(row.status)
                  return (
                    <tr
                      key={row.id}
                      className={cn(
                        'border-[var(--border-1)] border-b last:border-b-0',
                        selectable && 'hover:bg-[var(--surface-hover)]',
                        checked && 'bg-[var(--surface-2)]'
                      )}
                    >
                      <td className='px-4 py-3 align-middle'>
                        <Checkbox
                          checked={checked}
                          disabled={!selectable || approveMutation.isPending}
                          onCheckedChange={(next) => toggleRow(row.id, next === true)}
                          aria-label={`Select ${row.agent_name}`}
                        />
                      </td>
                      {COLUMNS.map((column) => {
                        if (column.key === 'status') {
                          return (
                            <td key={column.key} className='whitespace-nowrap px-4 py-3'>
                              <ChipTag {...statusTagProps(row.status)}>{displayStatus}</ChipTag>
                            </td>
                          )
                        }

                        if (column.key === 'requested_user_email') {
                          const name = row.requested_user_name?.trim()
                          return (
                            <td key={column.key} className='max-w-[240px] px-4 py-3'>
                              <div className='min-w-0'>
                                <p className='truncate text-[var(--text-body)]'>
                                  {name || row.requested_user_email || '—'}
                                </p>
                                {name ? (
                                  <p className='truncate text-[12px] text-[var(--text-muted)]'>
                                    {row.requested_user_email}
                                  </p>
                                ) : null}
                              </div>
                            </td>
                          )
                        }

                        const value = formatCellValue(column.key, row[column.key])
                        return (
                          <td
                            key={column.key}
                            className={cn(
                              'px-4 py-3 text-[var(--text-body)]',
                              column.key === 'agent_name' && 'max-w-[200px] font-medium',
                              (column.key === 'workflow_id' ||
                                column.key === 'workspace_id' ||
                                column.key === 'approved_by') &&
                                'max-w-[180px] font-mono text-[12px] text-[var(--text-secondary)]',
                              (column.key === 'created_at' || column.key === 'updated_at') &&
                                'whitespace-nowrap text-[var(--text-secondary)]'
                            )}
                            title={value}
                          >
                            <span className='block truncate'>{value}</span>
                          </td>
                        )
                      })}
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )

  if (standalone) {
    return (
      <div className='flex h-full flex-col bg-[var(--bg)]'>
        <div className='flex items-center justify-between gap-4 border-[var(--border-1)] border-b px-6 py-4'>
          <Link
            href={APP_ENTRY_PATH}
            aria-label={brand.name || 'Home'}
            className='inline-flex h-[44px] items-center rounded-[8px] hover-hover:bg-[var(--surface-hover)]'
          >
            {brandLogoSrc ? (
              <img
                src={brandLogoSrc}
                alt={brand.name || ''}
                className='h-[44px] w-auto max-w-[220px] object-contain object-left'
              />
            ) : null}
          </Link>
          <Chip leftIcon={ArrowLeft} onClick={() => router.push(APP_ENTRY_PATH)}>
            Back
          </Chip>
        </div>
        <div className='flex items-start justify-between gap-4 border-[var(--border-1)] border-b px-6 py-5'>
          <div className='flex min-w-0 flex-col gap-1'>
            <h1 className='text-[var(--text-body)] text-lg'>Agent access requests</h1>
            <p className='text-[var(--text-muted)] text-md'>
              Review and approve agent access requests.
            </p>
          </div>
          <div className='flex shrink-0 items-center gap-2'>
            <Chip onClick={() => void refetch()} disabled={isFetching || approveMutation.isPending}>
              {isFetching ? 'Refreshing...' : 'Refresh'}
            </Chip>
            <Chip variant='primary' onClick={() => applyDecision('done')} disabled={!canDecide}>
              {approveMutation.isPending ? 'Updating...' : 'Approve'}
            </Chip>
            <Chip
              variant='destructive'
              onClick={() => applyDecision('cancelled')}
              disabled={!canDecide}
            >
              Cancel
            </Chip>
          </div>
        </div>
        <div className='min-h-0 flex-1 overflow-y-auto px-6 py-6 [scrollbar-gutter:stable]'>
          <div className='mx-auto w-full max-w-[90rem]'>{body}</div>
        </div>
      </div>
    )
  }

  return (
    <SettingsPanel
      actions={[
        {
          id: 'refresh',
          text: isFetching ? 'Refreshing...' : 'Refresh',
          onSelect: () => void refetch(),
          disabled: isFetching || approveMutation.isPending,
        },
        {
          id: 'approve',
          text: approveMutation.isPending ? 'Updating...' : 'Approve',
          variant: 'primary',
          onSelect: () => applyDecision('done'),
          disabled: !canDecide,
        },
        {
          id: 'cancel',
          text: 'Cancel',
          variant: 'destructive',
          onSelect: () => applyDecision('cancelled'),
          disabled: !canDecide,
        },
      ]}
    >
      {body}
    </SettingsPanel>
  )
}
