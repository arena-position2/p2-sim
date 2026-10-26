'use client'

import { useMemo } from 'react'
import { ChipLink } from '@sim/emcn'
import type { OrganizationUsageAnalytics } from '@/lib/api/contracts/organization-usage'
import { averageBillableCostPerRun } from '@/lib/workspaces/usage/ledger-utils'
import { getMothershipChatPath } from '@/app/workspace/[workspaceId]/home/mothership-chat-path'
import { SettingsSection } from '@/app/workspace/[workspaceId]/settings/components/settings-section/settings-section'
import { ChargeTypePanel } from '@/app/workspace/[workspaceId]/settings/components/usage/components/charge-type-panel'
import {
  CostBreakdownTable,
  CostCell,
} from '@/app/workspace/[workspaceId]/settings/components/usage/components/cost-breakdown-table'
import { CostShareBars } from '@/app/workspace/[workspaceId]/settings/components/usage/components/cost-share-bars'
import { DataHealthPanel } from '@/app/workspace/[workspaceId]/settings/components/usage/components/data-health-panel'
import {
  UsageCollapsibleGroup,
  useUsageCollapsibleGroups,
} from '@/app/workspace/[workspaceId]/settings/components/usage/components/usage-collapsible-group'
import { UsageTimeSeriesChart } from '@/app/workspace/[workspaceId]/settings/components/usage/components/usage-time-series-chart'
import {
  COPILOT_USAGE_TOOL_BUCKET_ID,
  formatBillableWithCredits,
  formatTokenCount,
  formatToolLabel,
  hasBillableCredits,
  resolveUsageSourceLabel,
} from '@/app/workspace/[workspaceId]/settings/components/usage/format'
import {
  isLegacyUnattributedChatId,
  LEGACY_UNATTRIBUTED_CHAT_ID,
  LEGACY_UNATTRIBUTED_CHAT_TITLE,
  withLegacyUnattributedChatRow,
} from '@/app/workspace/[workspaceId]/settings/components/usage/legacy-unattributed-chat'
import type { UsageTab } from '@/app/workspace/[workspaceId]/settings/components/usage/search-params'
import {
  buildWorkflowAverageCostChartRows,
  buildWorkflowTotalCostChartRows,
} from '@/app/workspace/[workspaceId]/settings/components/usage/workflow-chart-rows'

interface OrganizationUsageContentProps {
  data: OrganizationUsageAnalytics
  tab: UsageTab
  userNameById: Map<string, string>
}

function workspaceUsageHref(workspaceId: string): string {
  return `/workspace/${workspaceId}/settings/usage`
}

function workflowLogsHref(workspaceId: string, workflowId: string): string {
  return `/workspace/${workspaceId}/logs?workflowIds=${workflowId}`
}

/** Deep-link into workspace Usage lineage drill-down (do not merge trees in org view). */
function lineageUsageHref(workspaceId: string, rootExecutionId: string): string {
  const params = new URLSearchParams({
    scope: 'workspace',
    tab: 'workflow',
    rootExecutionId,
  })
  return `/workspace/${workspaceId}/settings/usage?${params.toString()}`
}

/**
 * Organization usage panels — Phase 2 parity with workspace breakdowns, plus
 * by-workspace rollup and workspace-aware deep-links for leaders / lineage.
 */
export function OrganizationUsageContent({
  data,
  tab,
  userNameById,
}: OrganizationUsageContentProps) {
  const showWorkflow = tab === 'all' || tab === 'workflow'
  const showMothership = tab === 'all' || tab === 'mothership'
  const { openGroups, setGroupOpen } = useUsageCollapsibleGroups(tab)
  const toolRows = data.byTool.filter(
    (row) => hasBillableCredits(row.billableCost) && row.toolId !== COPILOT_USAGE_TOOL_BUCKET_ID
  )

  const workflowChartRows = useMemo(
    () =>
      buildWorkflowTotalCostChartRows(data.workflow.byWorkflow, (workflowId, workspaceId) =>
        workspaceId ? workflowLogsHref(workspaceId, workflowId) : undefined
      ),
    [data.workflow.byWorkflow]
  )

  const workflowAverageChartRows = useMemo(
    () =>
      buildWorkflowAverageCostChartRows(data.workflow.byWorkflow, (workflowId, workspaceId) =>
        workspaceId ? workflowLogsHref(workspaceId, workflowId) : undefined
      ),
    [data.workflow.byWorkflow]
  )

  const mothershipByChatRows = useMemo(
    () =>
      withLegacyUnattributedChatRow(
        data.copilot.byChat ?? [],
        data.attribution.missingChatId,
        (bucket) => ({
          chatId: LEGACY_UNATTRIBUTED_CHAT_ID,
          title: LEGACY_UNATTRIBUTED_CHAT_TITLE,
          chatType: 'copilot' as const,
          userId: '',
          runCount: 0,
          billableCost: bucket.billableCost,
          rawCost: bucket.rawCost,
          count: bucket.count,
          workspaceId: '',
          workspaceName: '—',
        })
      ),
    [data.attribution.missingChatId, data.copilot.byChat]
  )

  return (
    <div className='flex flex-col gap-8'>
      <UsageCollapsibleGroup
        label='Overview'
        open={openGroups.overview}
        onOpenChange={(open) => setGroupOpen('overview', open)}
      >
        <SettingsSection label='Trends'>
          <UsageTimeSeriesChart
            timeSeries={data.timeSeries}
            periodActiveUserCount={data.summary.activeUserCount}
          />
        </SettingsSection>

        {data.byChargeType.length > 0 && (
          <ChargeTypePanel
            byChargeType={data.byChargeType}
            totalBillableCost={data.summary.billableCost}
          />
        )}

        {(tab === 'all' || tab === 'workflow') && data.bySource.length > 0 && (
          <SettingsSection label='By source'>
            <CostBreakdownTable
              rows={data.bySource}
              getRowKey={(row) => row.label}
              columns={[
                {
                  key: 'source',
                  header: 'Source',
                  render: (row) => resolveUsageSourceLabel(row),
                },
                {
                  key: 'count',
                  header: 'Entries',
                  align: 'right',
                  render: (row) => row.count.toLocaleString(),
                },
                {
                  key: 'tokens',
                  header: 'Tokens',
                  align: 'right',
                  render: (row) => formatTokenCount(row.usage.totalTokens),
                },
                {
                  key: 'cost',
                  header: 'Credits',
                  align: 'right',
                  render: (row) => (
                    <CostCell billableCost={row.billableCost} rawCost={row.rawCost} />
                  ),
                },
              ]}
            />
          </SettingsSection>
        )}

        {data.byWorkspace.length > 0 && (
          <SettingsSection label='By workspace'>
            <p className='mb-4 text-[var(--text-secondary)] text-small'>
              Cost across {data.byWorkspace.length.toLocaleString()} workspace
              {data.byWorkspace.length === 1 ? '' : 's'} in this view
              {data.workspaces.length !== data.byWorkspace.length
                ? ` (${data.workspaces.length.toLocaleString()} in the organization)`
                : ''}
              .
            </p>
            <CostBreakdownTable
              rows={data.byWorkspace}
              getRowKey={(row) => row.workspaceId}
              emptyMessage='No workspace cost in this period.'
              columns={[
                {
                  key: 'workspace',
                  header: 'Workspace',
                  render: (row) => (
                    <ChipLink
                      href={workspaceUsageHref(row.workspaceId)}
                      target='_blank'
                      rel='noopener noreferrer'
                    >
                      {row.workspaceName}
                    </ChipLink>
                  ),
                },
                {
                  key: 'count',
                  header: 'Entries',
                  align: 'right',
                  render: (row) => row.count.toLocaleString(),
                },
                {
                  key: 'tokens',
                  header: 'Tokens',
                  align: 'right',
                  render: (row) => formatTokenCount(row.usage.totalTokens),
                },
                {
                  key: 'cost',
                  header: 'Credits',
                  align: 'right',
                  render: (row) => (
                    <CostCell billableCost={row.billableCost} rawCost={row.rawCost} />
                  ),
                },
              ]}
            />
          </SettingsSection>
        )}
      </UsageCollapsibleGroup>

      {showWorkflow && (
        <UsageCollapsibleGroup
          label='Workflows'
          open={openGroups.workflows}
          onOpenChange={(open) => setGroupOpen('workflows', open)}
        >
          <SettingsSection label='Workflow executions'>
            <div className='mb-4 flex flex-wrap items-center justify-between gap-2'>
              <p className='text-[var(--text-secondary)] text-small'>
                {data.workflow.executions.total.toLocaleString()} executions ·{' '}
                {data.workflow.executions.withProjectedCost.toLocaleString()} with projected cost
              </p>
            </div>
            {workflowChartRows.length > 0 && (
              <div className='mb-6 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-4 py-3'>
                <p className='mb-3 font-medium text-[var(--text-primary)] text-small'>
                  Most expensive workflows
                </p>
                <CostShareBars
                  rows={workflowChartRows}
                  emptyMessage='No workflow cost in this period.'
                />
              </div>
            )}
            {workflowAverageChartRows.length > 0 && (
              <div className='mb-6 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-4 py-3'>
                <p className='mb-3 font-medium text-[var(--text-primary)] text-small'>
                  Highest average cost per run
                </p>
                <CostShareBars
                  rows={workflowAverageChartRows}
                  emptyMessage='No workflow cost in this period.'
                />
              </div>
            )}
            {data.workflow.byWorkflow.length > 0 && (
              <CostBreakdownTable
                rows={data.workflow.byWorkflow}
                getRowKey={(row) =>
                  `${row.workspaceId}-${row.workflowId ?? row.workflowName ?? 'unknown'}`
                }
                emptyMessage='No workflow cost in this period.'
                columns={[
                  {
                    key: 'workflow',
                    header: 'Workflow',
                    render: (row) => {
                      const label = row.workflowName ?? row.workflowId ?? 'Unknown workflow'
                      if (row.workflowId) {
                        return (
                          <ChipLink
                            href={workflowLogsHref(row.workspaceId, row.workflowId)}
                            target='_blank'
                            rel='noopener noreferrer'
                          >
                            {label}
                          </ChipLink>
                        )
                      }
                      return label
                    },
                  },
                  {
                    key: 'workspace',
                    header: 'Workspace',
                    render: (row) => (
                      <ChipLink
                        href={workspaceUsageHref(row.workspaceId)}
                        target='_blank'
                        rel='noopener noreferrer'
                      >
                        {row.workspaceName}
                      </ChipLink>
                    ),
                  },
                  {
                    key: 'executions',
                    header: 'Runs',
                    align: 'right',
                    render: (row) => row.executionCount.toLocaleString(),
                  },
                  {
                    key: 'avgCost',
                    header: 'Avg credits/run',
                    align: 'right',
                    render: (row) =>
                      row.executionCount > 0
                        ? formatBillableWithCredits(
                            averageBillableCostPerRun(row.billableCost, row.executionCount)
                          )
                        : '—',
                  },
                  {
                    key: 'cost',
                    header: 'Credits',
                    align: 'right',
                    render: (row) => (
                      <CostCell billableCost={row.billableCost} rawCost={row.rawCost} />
                    ),
                  },
                ]}
              />
            )}
            {data.workflow.byTrigger.length > 0 && (
              <div className='mt-6'>
                <p className='mb-2 text-[var(--text-muted)] text-small'>By trigger</p>
                <CostBreakdownTable
                  rows={data.workflow.byTrigger}
                  getRowKey={(row) => row.trigger}
                  columns={[
                    {
                      key: 'trigger',
                      header: 'Trigger',
                      render: (row) => row.trigger || 'Unknown',
                    },
                    {
                      key: 'executions',
                      header: 'Runs',
                      align: 'right',
                      render: (row) => row.executionCount.toLocaleString(),
                    },
                    {
                      key: 'cost',
                      header: 'Credits',
                      align: 'right',
                      render: (row) => (
                        <CostCell billableCost={row.billableCost} rawCost={row.rawCost} />
                      ),
                    },
                  ]}
                />
              </div>
            )}
          </SettingsSection>

          {data.lineage.roots.length > 0 && (
            <SettingsSection label='Execution lineage'>
              <p className='mb-4 text-[var(--text-secondary)] text-small'>
                Top lineage trees by inclusive workflow cost. Open a root in its workspace Usage
                page to drill into child runs.
              </p>
              <CostBreakdownTable
                rows={data.lineage.roots}
                getRowKey={(row) => `${row.workspaceId}-${row.rootExecutionId}`}
                emptyMessage='No lineage roots in this period.'
                columns={[
                  {
                    key: 'root',
                    header: 'Root execution',
                    render: (row) => (
                      <div className='flex items-center gap-2'>
                        <span className='font-mono text-[var(--text-primary)] text-small'>
                          {row.rootExecutionId.slice(0, 12)}…
                        </span>
                        <ChipLink
                          href={lineageUsageHref(row.workspaceId, row.rootExecutionId)}
                          target='_blank'
                          rel='noopener noreferrer'
                        >
                          Drill down
                        </ChipLink>
                      </div>
                    ),
                  },
                  {
                    key: 'workspace',
                    header: 'Workspace',
                    render: (row) => (
                      <ChipLink
                        href={workspaceUsageHref(row.workspaceId)}
                        target='_blank'
                        rel='noopener noreferrer'
                      >
                        {row.workspaceName}
                      </ChipLink>
                    ),
                  },
                  {
                    key: 'runs',
                    header: 'Runs',
                    align: 'right',
                    render: (row) => row.executionCount.toLocaleString(),
                  },
                  {
                    key: 'cost',
                    header: 'Inclusive billable',
                    align: 'right',
                    render: (row) => (
                      <CostCell
                        billableCost={row.inclusiveBillableCost}
                        rawCost={row.inclusiveRawCost}
                      />
                    ),
                  },
                ]}
              />
            </SettingsSection>
          )}
        </UsageCollapsibleGroup>
      )}

      {showMothership && (
        <UsageCollapsibleGroup
          label='Mothership'
          open={openGroups.mothership}
          onOpenChange={(open) => setGroupOpen('mothership', open)}
        >
          <SettingsSection label='Mothership & copilot'>
            <div className='mb-4 flex flex-wrap items-center justify-between gap-2'>
              <p className='text-[var(--text-secondary)] text-small'>
                {data.copilot.chats.total.toLocaleString()} chats ·{' '}
                {data.copilot.chats.withLedgerCost.toLocaleString()} with ledger cost ·{' '}
                {data.copilot.runs.total.toLocaleString()} runs
              </p>
            </div>
            {data.copilot.triggeredWorkflows.executionCount > 0 && (
              <div className='mb-6 rounded-lg border border-[var(--border)] bg-[var(--surface-3)] px-4 py-3'>
                <p className='font-medium text-[var(--text-primary)] text-small'>
                  Workflows triggered by copilot
                </p>
                <p className='mt-1 text-[var(--text-secondary)] text-small'>
                  {data.copilot.triggeredWorkflows.executionCount.toLocaleString()} child runs ·{' '}
                  {formatBillableWithCredits(data.copilot.triggeredWorkflows.billableCost)}{' '}
                  inclusive
                </p>
                <p className='mt-1 text-[var(--text-muted)] text-xs'>
                  Rolled up via triggering chat — excluded from mothership headline totals to avoid
                  double counting.
                </p>
                {data.copilot.triggeredWorkflows.byChat.length > 0 && (
                  <div className='mt-4'>
                    <CostBreakdownTable
                      rows={data.copilot.triggeredWorkflows.byChat}
                      getRowKey={(row) => `${row.workspaceId}-${row.triggeringChatId}`}
                      columns={[
                        {
                          key: 'chat',
                          header: 'Triggering chat',
                          render: (row) => (
                            <span className='font-mono text-small'>
                              {row.triggeringChatId.slice(0, 12)}…
                            </span>
                          ),
                        },
                        {
                          key: 'workspace',
                          header: 'Workspace',
                          render: (row) => (
                            <ChipLink
                              href={workspaceUsageHref(row.workspaceId)}
                              target='_blank'
                              rel='noopener noreferrer'
                            >
                              {row.workspaceName}
                            </ChipLink>
                          ),
                        },
                        {
                          key: 'runs',
                          header: 'Runs',
                          align: 'right',
                          render: (row) => row.executionCount.toLocaleString(),
                        },
                        {
                          key: 'cost',
                          header: 'Credits',
                          align: 'right',
                          render: (row) => (
                            <CostCell billableCost={row.billableCost} rawCost={row.rawCost} />
                          ),
                        },
                      ]}
                    />
                  </div>
                )}
              </div>
            )}
            {mothershipByChatRows.length > 0 && (
              <div className='mb-6'>
                <p className='mb-2 text-[var(--text-muted)] text-small'>
                  Most expensive chats (top {mothershipByChatRows.length})
                </p>
                <CostBreakdownTable
                  rows={mothershipByChatRows}
                  getRowKey={(row) => `${row.workspaceId}-${row.chatId}`}
                  emptyMessage='No mothership chat cost in this period.'
                  columns={[
                    {
                      key: 'chat',
                      header: 'Chat',
                      render: (row) => {
                        if (isLegacyUnattributedChatId(row.chatId)) {
                          return (
                            <span className='text-[var(--text-secondary)]'>
                              {LEGACY_UNATTRIBUTED_CHAT_TITLE}
                            </span>
                          )
                        }
                        const label = row.title?.trim() || `${row.chatId.slice(0, 8)}…`
                        if (row.chatType === 'mothership') {
                          return (
                            <ChipLink
                              href={getMothershipChatPath(row.workspaceId, row.chatId)}
                              target='_blank'
                              rel='noopener noreferrer'
                            >
                              {label}
                            </ChipLink>
                          )
                        }
                        return label
                      },
                    },
                    {
                      key: 'workspace',
                      header: 'Workspace',
                      render: (row) =>
                        isLegacyUnattributedChatId(row.chatId) ? (
                          '—'
                        ) : (
                          <ChipLink
                            href={workspaceUsageHref(row.workspaceId)}
                            target='_blank'
                            rel='noopener noreferrer'
                          >
                            {row.workspaceName}
                          </ChipLink>
                        ),
                    },
                    {
                      key: 'user',
                      header: 'Owner',
                      render: (row) =>
                        isLegacyUnattributedChatId(row.chatId)
                          ? '—'
                          : (userNameById.get(row.userId) ?? row.userId),
                    },
                    {
                      key: 'type',
                      header: 'Type',
                      render: (row) =>
                        isLegacyUnattributedChatId(row.chatId) ? (
                          <span>Legacy</span>
                        ) : (
                          <span className='capitalize'>{row.chatType}</span>
                        ),
                    },
                    {
                      key: 'runs',
                      header: 'Runs',
                      align: 'right',
                      render: (row) =>
                        isLegacyUnattributedChatId(row.chatId)
                          ? `${row.count.toLocaleString()} rows`
                          : row.runCount.toLocaleString(),
                    },
                    {
                      key: 'cost',
                      header: 'Credits',
                      align: 'right',
                      render: (row) => (
                        <CostCell billableCost={row.billableCost} rawCost={row.rawCost} />
                      ),
                    },
                  ]}
                />
              </div>
            )}
            {data.copilot.byChatType.length > 0 && (
              <CostBreakdownTable
                rows={data.copilot.byChatType}
                getRowKey={(row) => row.chatType}
                columns={[
                  {
                    key: 'type',
                    header: 'Chat type',
                    render: (row) => <span className='capitalize'>{row.chatType}</span>,
                  },
                  {
                    key: 'chats',
                    header: 'Chats',
                    align: 'right',
                    render: (row) => row.chatCount.toLocaleString(),
                  },
                  {
                    key: 'runs',
                    header: 'Runs',
                    align: 'right',
                    render: (row) => row.runCount.toLocaleString(),
                  },
                  {
                    key: 'cost',
                    header: 'Credits',
                    align: 'right',
                    render: (row) => (
                      <CostCell billableCost={row.billableCost} rawCost={row.rawCost} />
                    ),
                  },
                ]}
              />
            )}
            {data.copilot.byModel.length > 0 && (
              <div className='mt-6'>
                <p className='mb-2 text-[var(--text-muted)] text-small'>By model</p>
                <CostBreakdownTable
                  rows={data.copilot.byModel}
                  getRowKey={(row) => row.model}
                  columns={[
                    {
                      key: 'model',
                      header: 'Model',
                      render: (row) => row.model,
                    },
                    {
                      key: 'count',
                      header: 'Entries',
                      align: 'right',
                      render: (row) => row.count.toLocaleString(),
                    },
                    {
                      key: 'cost',
                      header: 'Credits',
                      align: 'right',
                      render: (row) => (
                        <CostCell billableCost={row.billableCost} rawCost={row.rawCost} />
                      ),
                    },
                  ]}
                />
              </div>
            )}
          </SettingsSection>
        </UsageCollapsibleGroup>
      )}

      <UsageCollapsibleGroup
        label='Breakdowns'
        open={openGroups.breakdowns}
        onOpenChange={(open) => setGroupOpen('breakdowns', open)}
      >
        {tab === 'all' && data.byUser.length > 0 && (
          <SettingsSection label='By billing user'>
            <CostBreakdownTable
              rows={data.byUser}
              getRowKey={(row) => row.userId}
              columns={[
                {
                  key: 'user',
                  header: 'User',
                  render: (row) => userNameById.get(row.userId) ?? row.userId,
                },
                {
                  key: 'count',
                  header: 'Entries',
                  align: 'right',
                  render: (row) => row.count.toLocaleString(),
                },
                {
                  key: 'cost',
                  header: 'Credits',
                  align: 'right',
                  render: (row) => (
                    <CostCell billableCost={row.billableCost} rawCost={row.rawCost} />
                  ),
                },
              ]}
            />
          </SettingsSection>
        )}

        {tab === 'all' && data.byVendor.length > 0 && (
          <SettingsSection label='External vendor spend'>
            <p className='mb-4 text-[var(--text-secondary)] text-small'>
              Pass-through third-party API costs tracked via Cost blocks.
            </p>
            <CostBreakdownTable
              rows={data.byVendor}
              getRowKey={(row) => row.vendor}
              columns={[
                {
                  key: 'vendor',
                  header: 'Vendor',
                  render: (row) => row.vendor,
                },
                {
                  key: 'count',
                  header: 'Entries',
                  align: 'right',
                  render: (row) => row.count.toLocaleString(),
                },
                {
                  key: 'cost',
                  header: 'Credits',
                  align: 'right',
                  render: (row) => (
                    <CostCell billableCost={row.billableCost} rawCost={row.rawCost} />
                  ),
                },
              ]}
            />
          </SettingsSection>
        )}

        {tab === 'all' &&
          (data.byModel.length > 0 || data.byProvider.length > 0 || toolRows.length > 0) && (
            <SettingsSection label='Model & tool usage'>
              {data.byModel.length > 0 && (
                <CostBreakdownTable
                  rows={data.byModel}
                  getRowKey={(row) => row.model}
                  columns={[
                    { key: 'model', header: 'Model', render: (row) => row.model },
                    {
                      key: 'count',
                      header: 'Entries',
                      align: 'right',
                      render: (row) => row.count.toLocaleString(),
                    },
                    {
                      key: 'cost',
                      header: 'Credits',
                      align: 'right',
                      render: (row) => (
                        <CostCell billableCost={row.billableCost} rawCost={row.rawCost} />
                      ),
                    },
                  ]}
                />
              )}
              {data.byProvider.length > 0 && (
                <div className='mt-6'>
                  <p className='mb-2 text-[var(--text-muted)] text-small'>By provider</p>
                  <CostBreakdownTable
                    rows={data.byProvider}
                    getRowKey={(row) => row.provider}
                    columns={[
                      { key: 'provider', header: 'Provider', render: (row) => row.provider },
                      {
                        key: 'count',
                        header: 'Entries',
                        align: 'right',
                        render: (row) => row.count.toLocaleString(),
                      },
                      {
                        key: 'cost',
                        header: 'Credits',
                        align: 'right',
                        render: (row) => (
                          <CostCell billableCost={row.billableCost} rawCost={row.rawCost} />
                        ),
                      },
                    ]}
                  />
                </div>
              )}
              {toolRows.length > 0 && (
                <div className='mt-6'>
                  <p className='mb-2 text-[var(--text-muted)] text-small'>By tool</p>
                  <CostBreakdownTable
                    rows={toolRows}
                    getRowKey={(row) => row.toolId}
                    columns={[
                      {
                        key: 'tool',
                        header: 'Tool',
                        render: (row) => formatToolLabel(row.toolId),
                      },
                      {
                        key: 'count',
                        header: 'Entries',
                        align: 'right',
                        render: (row) => row.count.toLocaleString(),
                      },
                      {
                        key: 'cost',
                        header: 'Credits',
                        align: 'right',
                        render: (row) => (
                          <CostCell billableCost={row.billableCost} rawCost={row.rawCost} />
                        ),
                      },
                    ]}
                  />
                </div>
              )}
            </SettingsSection>
          )}

        <DataHealthPanel data={data} />
      </UsageCollapsibleGroup>
    </div>
  )
}
