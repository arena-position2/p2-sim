'use client'

import type { ReactNode } from 'react'
import { useMemo } from 'react'
import type { OrganizationUsageAnalytics } from '@/lib/api/contracts/organization-usage'
import { averageBillableCostPerRun } from '@/lib/workspaces/usage/ledger-utils'
import {
  UsageRankCreditsCell,
  UsageRankTable,
} from '@/app/workspace/[workspaceId]/settings/components/usage/components/usage-rank-table'
import { UsageTimeSeriesChart } from '@/app/workspace/[workspaceId]/settings/components/usage/components/usage-time-series-chart'
import {
  aggregateUsageToolsByFamily,
  formatBillableWithCredits,
  formatUsageToolFamilyLabel,
} from '@/app/workspace/[workspaceId]/settings/components/usage/format'

interface OrganizationAdminUsageContentProps {
  data: OrganizationUsageAnalytics
  /** Prefer email (screenshot); fall back to name/id. */
  userLabelById: Map<string, string>
  workspaceFilterLabel: string
  periodStatusLabel: string
  /** Period + workspace filter controls rendered under Activity detail. */
  filters: ReactNode
}

/**
 * Org admin/owner Usage activity detail:
 * filters, status line, By Workflow / By User / By Tools / models, then charts.
 */
export function OrganizationAdminUsageContent({
  data,
  userLabelById,
  workspaceFilterLabel,
  periodStatusLabel,
  filters,
}: OrganizationAdminUsageContentProps) {
  const workflowRows = useMemo(() => data.workflow.byWorkflow, [data.workflow.byWorkflow])
  const apiRows = useMemo(() => data.byApi, [data.byApi])
  const userRows = useMemo(() => data.byUser, [data.byUser])
  const toolRows = useMemo(() => aggregateUsageToolsByFamily(data.byTool), [data.byTool])
  const modelSpend = data.copilot.modelSpend
  const mothershipCopilotModelRows =
    modelSpend.billableCost > 0 || modelSpend.count > 0 ? [modelSpend] : []

  return (
    <div className='flex flex-col gap-6'>
      <div className='flex flex-col gap-3'>
        <h2 className='font-medium text-[var(--text-primary)] text-base'>Activity detail</h2>

        <div className='flex flex-wrap items-center gap-3 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2.5'>
          {filters}
        </div>

        <p className='text-[var(--text-muted)] text-small'>
          Showing <span className='font-medium text-[var(--text-secondary)]'>all sources</span> for
          the <span className='font-medium text-[var(--text-secondary)]'>{periodStatusLabel}</span>{' '}
          in{' '}
          <span className='font-medium text-[var(--text-secondary)]'>{workspaceFilterLabel}</span>.
        </p>
      </div>

      <UsageRankTable
        rows={workflowRows}
        getRowKey={(row, index) => row.workflowId ?? `workflow-${index}`}
        getBillableCost={(row) => row.billableCost}
        emptyMessage='No workflow usage in this period.'
        columns={[
          {
            key: 'name',
            header: 'By Workflow',
            render: (row) => (
              <span className='font-medium'>
                {row.workflowName?.trim() || row.workflowId || 'Untitled workflow'}
              </span>
            ),
          },
          {
            key: 'runs',
            header: 'Runs',
            align: 'right',
            render: (row) => row.executionCount.toLocaleString(),
          },
          {
            key: 'avg',
            header: 'Avg credits/run',
            align: 'right',
            render: (row) =>
              formatBillableWithCredits(
                averageBillableCostPerRun(row.billableCost, row.executionCount)
              ),
          },
          {
            key: 'credits',
            header: 'Credits',
            align: 'right',
            render: (row) => <UsageRankCreditsCell billableCost={row.billableCost} />,
          },
        ]}
      />

      {apiRows.length > 0 && (
        <UsageRankTable
          rows={apiRows}
          getRowKey={(row) =>
            `${row.organizationId}:${row.workspaceId}:${row.workflowId}:${row.actorUserId ?? ''}`
          }
          getBillableCost={(row) => row.billableCost}
          emptyMessage='No external API usage in this period.'
          columns={[
            {
              key: 'name',
              header: 'By API',
              render: (row) => (
                <div className='flex flex-col'>
                  <span className='font-medium'>{row.workflowName?.trim() || row.workflowId}</span>
                  <span className='text-[var(--text-muted)] text-caption'>
                    {row.organizationName} · {row.workspaceName}
                  </span>
                </div>
              ),
            },
            {
              key: 'actor',
              header: 'Run by',
              render: (row) =>
                row.actorUserId ? (userLabelById.get(row.actorUserId) ?? row.actorUserId) : '—',
            },
            {
              key: 'runs',
              header: 'Runs',
              align: 'right',
              render: (row) => row.executionCount.toLocaleString(),
            },
            {
              key: 'credits',
              header: 'Credits',
              align: 'right',
              render: (row) => <UsageRankCreditsCell billableCost={row.billableCost} />,
            },
          ]}
        />
      )}

      <UsageRankTable
        rows={userRows}
        getRowKey={(row) => row.userId}
        getBillableCost={(row) => row.billableCost}
        emptyMessage='No user usage in this period.'
        columns={[
          {
            key: 'user',
            header: 'By User',
            render: (row) => (
              <span className='font-medium'>{userLabelById.get(row.userId) ?? row.userId}</span>
            ),
          },
          {
            key: 'runs',
            header: 'Runs',
            align: 'right',
            render: (row) => row.count.toLocaleString(),
          },
          {
            key: 'credits',
            header: 'Credits',
            align: 'right',
            render: (row) => <UsageRankCreditsCell billableCost={row.billableCost} />,
          },
        ]}
      />

      <UsageRankTable
        rows={toolRows}
        getRowKey={(row) => row.toolId}
        getBillableCost={(row) => row.billableCost}
        emptyMessage='No hosted tool usage in this period.'
        columns={[
          {
            key: 'tool',
            header: 'By Tools',
            render: (row) => (
              <span className='font-medium'>{formatUsageToolFamilyLabel(row.toolId)}</span>
            ),
          },
          {
            key: 'runs',
            header: 'Runs',
            align: 'right',
            render: (row) => row.count.toLocaleString(),
          },
          {
            key: 'credits',
            header: 'Credits',
            align: 'right',
            render: (row) => <UsageRankCreditsCell billableCost={row.billableCost} />,
          },
        ]}
      />

      <UsageRankTable
        rows={mothershipCopilotModelRows}
        getRowKey={() => 'mothership_copilot_models'}
        getBillableCost={(row) => row.billableCost}
        emptyMessage='No Copilot usage in this period.'
        columns={[
          {
            key: 'name',
            header: 'By Resources',
            render: () => <span className='font-medium'>Copilot</span>,
          },
          {
            key: 'runs',
            header: 'Runs',
            align: 'right',
            render: (row) => row.count.toLocaleString(),
          },
          {
            key: 'credits',
            header: 'Credits',
            align: 'right',
            render: (row) => <UsageRankCreditsCell billableCost={row.billableCost} />,
          },
        ]}
      />

      <UsageTimeSeriesChart
        key={`${data.period.startTime}:${data.period.endTime}`}
        timeSeries={data.timeSeries}
        periodActiveUserCount={data.summary.activeUserCount}
        showActiveUsers
        showExecutionsOverlay={false}
        costChartTitle='Cost & activity over time'
      />
    </div>
  )
}
