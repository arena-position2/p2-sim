'use client'

import { useMemo, useState } from 'react'
import {
  ArrowUpDown,
  Avatar,
  AvatarFallback,
  Chip,
  ChipInput,
  CircleInfo,
  Credit,
  chipVariants,
  cn,
  Download,
  Info,
  Search,
  Server,
  Users,
  Workflow,
} from '@sim/emcn'
import type {
  CreditUsageSummary,
  MemberCreditUsageRow,
} from '@/lib/api/contracts/billing-credit-usage'
import { BillingUsageMetricCard } from '@/app/workspace/[workspaceId]/settings/components/billing-usage/billing-usage-metric-card'
import { BillingUsageSection } from '@/app/workspace/[workspaceId]/settings/components/billing-usage/billing-usage-section'
import {
  exportMemberUsageCsv,
  formatCreditCount,
  getMemberInitials,
} from '@/app/workspace/[workspaceId]/settings/components/billing-usage/billing-usage-utils'

const USAGE_SOURCE_DESCRIPTION = 'Credits include combined usage from Mothership and Workflow Runs.'

const PAGE_SIZE = 10

type SortColumn = 'userName' | 'mothershipCredits' | 'workflowCredits' | 'totalCredits'
type SortDirection = 'asc' | 'desc'

interface BillingOrgUsageViewProps {
  data: CreditUsageSummary
}

function formatCreditsValue(value: number | 'unlimited'): string {
  return value === 'unlimited' ? 'Unlimited' : `${formatCreditCount(value)} credits`
}

function sortMembers(
  members: MemberCreditUsageRow[],
  column: SortColumn,
  direction: SortDirection
): MemberCreditUsageRow[] {
  const sorted = [...members]
  sorted.sort((a, b) => {
    if (column === 'userName') {
      const comparison = a.userName.localeCompare(b.userName)
      return direction === 'asc' ? comparison : -comparison
    }

    const comparison = a[column] - b[column]
    return direction === 'asc' ? comparison : -comparison
  })
  return sorted
}

/**
 * Organization-admin billing usage layout: summary metrics and searchable member
 * table with export.
 */
export function BillingOrgUsageView({ data }: BillingOrgUsageViewProps) {
  const members = data.members ?? []
  const [searchQuery, setSearchQuery] = useState('')
  const [sortColumn, setSortColumn] = useState<SortColumn>('totalCredits')
  const [sortDirection, setSortDirection] = useState<SortDirection>('desc')
  const [page, setPage] = useState(1)

  const filteredMembers = useMemo(() => {
    const query = searchQuery.trim().toLowerCase()
    if (!query) return members
    return members.filter(
      (member) =>
        member.userName.toLowerCase().includes(query) ||
        member.userEmail.toLowerCase().includes(query)
    )
  }, [members, searchQuery])

  const sortedMembers = useMemo(
    () => sortMembers(filteredMembers, sortColumn, sortDirection),
    [filteredMembers, sortColumn, sortDirection]
  )

  const totalPages = Math.max(1, Math.ceil(sortedMembers.length / PAGE_SIZE))
  const currentPage = Math.min(page, totalPages)
  const pageStart = (currentPage - 1) * PAGE_SIZE
  const pageMembers = sortedMembers.slice(pageStart, pageStart + PAGE_SIZE)

  const toggleSort = (column: SortColumn) => {
    if (sortColumn === column) {
      setSortDirection((prev) => (prev === 'asc' ? 'desc' : 'asc'))
      return
    }
    setSortColumn(column)
    setSortDirection(column === 'userName' ? 'asc' : 'desc')
  }

  const activeUsers = members.length
  const totalCreditsDisplay: number | 'unlimited' | null = data.orgPool?.isUnlimited
    ? 'unlimited'
    : data.orgPool != null
      ? data.orgPool.totalCredits
      : null

  return (
    <div className='flex flex-col gap-7'>
      <BillingUsageSection
        label='Usage summary'
        description={USAGE_SOURCE_DESCRIPTION}
        headerAccessory={
          <Info side='top' align='start' className='flex-shrink-0 text-[var(--text-icon)]'>
            {USAGE_SOURCE_DESCRIPTION}
          </Info>
        }
      >
        <div className='grid gap-3 sm:grid-cols-2 xl:grid-cols-5'>
          {totalCreditsDisplay != null ? (
            <BillingUsageMetricCard
              label='Total credits'
              value={formatCreditsValue(totalCreditsDisplay)}
              hint='Organization credit pool'
              icon={<Credit className='size-[14px] text-emerald-700' />}
              iconClassName='bg-emerald-500/10'
            />
          ) : null}
          <BillingUsageMetricCard
            label='Total credits consumed'
            value={`${formatCreditCount(data.summary.totalCredits)} credits`}
            icon={<Credit className='size-[14px] text-emerald-700' />}
            iconClassName='bg-emerald-500/10'
          />
          <BillingUsageMetricCard
            label='Mothership usage'
            value={`${formatCreditCount(data.summary.mothershipCredits)} credits`}
            icon={<Server className='size-[14px] text-sky-700' />}
            iconClassName='bg-sky-500/10'
          />
          <BillingUsageMetricCard
            label='Workflow run usage'
            value={`${formatCreditCount(data.summary.workflowCredits)} credits`}
            icon={<Workflow className='size-[14px] text-violet-700' />}
            iconClassName='bg-violet-500/10'
          />
          <BillingUsageMetricCard
            label='Active users'
            value={String(activeUsers)}
            icon={<Users className='size-[14px] text-amber-700' />}
            iconClassName='bg-amber-500/10'
          />
        </div>
      </BillingUsageSection>

      <BillingUsageSection label='User usage breakdown' description={USAGE_SOURCE_DESCRIPTION}>
        <div className='flex flex-col gap-4'>
          <div className='flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between'>
            <ChipInput
              icon={Search}
              placeholder='Search users...'
              value={searchQuery}
              onChange={(event) => {
                setSearchQuery(event.target.value)
                setPage(1)
              }}
              className='w-full sm:max-w-xs'
            />
            <Chip
              leftIcon={Download}
              disabled={sortedMembers.length === 0}
              onClick={() => exportMemberUsageCsv(sortedMembers)}
            >
              Export
            </Chip>
          </div>

          <div className='overflow-x-auto rounded-xl border border-[var(--border-1)]'>
            <table className='min-w-full border-collapse'>
              <thead>
                <tr className='border-[var(--border-1)] border-b bg-[var(--surface-2)] text-left text-[var(--text-muted)] text-small'>
                  <th className='px-4 py-3 font-normal'>
                    <button
                      type='button'
                      className='inline-flex items-center gap-1'
                      onClick={() => toggleSort('userName')}
                    >
                      User
                      <ArrowUpDown className='size-[14px]' />
                    </button>
                  </th>
                  <th className='px-4 py-3 font-normal'>
                    <button
                      type='button'
                      className='inline-flex items-center gap-1'
                      onClick={() => toggleSort('mothershipCredits')}
                    >
                      Mothership credits
                      <ArrowUpDown className='size-[14px]' />
                    </button>
                  </th>
                  <th className='px-4 py-3 font-normal'>
                    <button
                      type='button'
                      className='inline-flex items-center gap-1'
                      onClick={() => toggleSort('workflowCredits')}
                    >
                      Workflow run credits
                      <ArrowUpDown className='size-[14px]' />
                    </button>
                  </th>
                  <th className='px-4 py-3 font-normal'>
                    <button
                      type='button'
                      className='inline-flex items-center gap-1'
                      onClick={() => toggleSort('totalCredits')}
                    >
                      Total credits
                      <ArrowUpDown className='size-[14px]' />
                    </button>
                  </th>
                </tr>
              </thead>
              <tbody>
                {pageMembers.length === 0 ? (
                  <tr>
                    <td colSpan={4} className='px-4 py-6 text-[var(--text-muted)] text-small'>
                      No users match your search.
                    </td>
                  </tr>
                ) : (
                  pageMembers.map((member) => (
                    <tr
                      key={member.userId}
                      className='border-[var(--border-1)] border-b last:border-b-0'
                    >
                      <td className='px-4 py-3'>
                        <div className='flex min-w-[220px] items-center gap-3'>
                          <Avatar className='size-8 shrink-0'>
                            <AvatarFallback className='bg-[var(--surface-3)] text-[var(--text-body)] text-small'>
                              {getMemberInitials(member.userName)}
                            </AvatarFallback>
                          </Avatar>
                          <div className='min-w-0'>
                            <p className='truncate text-[14px] text-[var(--text-body)]'>
                              {member.userName}
                            </p>
                            <p className='truncate text-[12px] text-[var(--text-muted)]'>
                              {member.userEmail}
                            </p>
                          </div>
                        </div>
                      </td>
                      <td className='px-4 py-3 text-[14px] text-[var(--text-body)] tabular-nums'>
                        {formatCreditCount(member.mothershipCredits)}
                      </td>
                      <td className='px-4 py-3 text-[14px] text-[var(--text-body)] tabular-nums'>
                        {formatCreditCount(member.workflowCredits)}
                      </td>
                      <td className='px-4 py-3 text-[14px] text-[var(--text-body)] tabular-nums'>
                        {formatCreditCount(member.totalCredits)}
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          {sortedMembers.length > 0 ? (
            <div className='flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between'>
              <p className='text-[var(--text-muted)] text-small'>
                Showing {pageStart + 1} to {Math.min(pageStart + PAGE_SIZE, sortedMembers.length)}{' '}
                of {sortedMembers.length} users
              </p>
              <div className='flex items-center gap-1'>
                <button
                  type='button'
                  aria-label='Previous page'
                  disabled={currentPage <= 1}
                  onClick={() => setPage((prev) => Math.max(1, prev - 1))}
                  className={cn(chipVariants(), 'min-w-[32px] text-[var(--text-muted)]')}
                >
                  ‹
                </button>
                {Array.from({ length: totalPages }, (_, index) => index + 1)
                  .slice(0, 5)
                  .map((pageNumber) => (
                    <button
                      key={pageNumber}
                      type='button'
                      aria-label={`Page ${pageNumber}`}
                      onClick={() => setPage(pageNumber)}
                      className={cn(
                        chipVariants(),
                        'min-w-[32px]',
                        pageNumber === currentPage
                          ? 'text-[var(--text-body)]'
                          : 'text-[var(--text-muted)]'
                      )}
                    >
                      {pageNumber}
                    </button>
                  ))}
                <button
                  type='button'
                  aria-label='Next page'
                  disabled={currentPage >= totalPages}
                  onClick={() => setPage((prev) => Math.min(totalPages, prev + 1))}
                  className={cn(chipVariants(), 'min-w-[32px] text-[var(--text-muted)]')}
                >
                  ›
                </button>
              </div>
            </div>
          ) : null}
        </div>
      </BillingUsageSection>

      <div className='flex items-start gap-2 rounded-lg border border-sky-500/20 bg-sky-500/5 px-3 py-2.5'>
        <CircleInfo className='mt-0.5 size-[14px] flex-shrink-0 text-sky-700' />
        <p className='text-[var(--text-body)] text-small'>Usage is updated in near real-time.</p>
      </div>
    </div>
  )
}
