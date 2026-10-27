'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Badge,
  Calendar,
  ChipButtonGroup,
  ChipButtonGroupItem,
  ChipLink,
  ChipSelect,
  cn,
  Info,
  Loader,
  Popover,
  PopoverAnchor,
  PopoverContent,
  RefreshCw,
  Skeleton,
} from '@sim/emcn'
import { useQueryClient } from '@tanstack/react-query'
import { useParams } from 'next/navigation'
import { useQueryStates } from 'nuqs'
import type { WorkspaceUsageAnalytics } from '@/lib/api/contracts/workspace-usage'
import { formatDateShort } from '@/lib/core/utils/date-display'
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
import { LineagePanel } from '@/app/workspace/[workspaceId]/settings/components/usage/components/lineage-panel'
import { OrganizationAdminUsageContent } from '@/app/workspace/[workspaceId]/settings/components/usage/components/organization-admin-usage-content'
import { UsageBillingStats } from '@/app/workspace/[workspaceId]/settings/components/usage/components/usage-billing-stats'
import {
  UsageCollapsibleGroup,
  useUsageCollapsibleGroups,
} from '@/app/workspace/[workspaceId]/settings/components/usage/components/usage-collapsible-group'
import { UsageTimeSeriesChart } from '@/app/workspace/[workspaceId]/settings/components/usage/components/usage-time-series-chart'
import { UserMemberUsageContent } from '@/app/workspace/[workspaceId]/settings/components/usage/components/user-member-usage-content'
import {
  COPILOT_USAGE_TOOL_BUCKET_ID,
  formatAdminPeriodChipLabel,
  formatBillableWithCredits,
  formatPeriodLabel,
  formatTokenCount,
  formatToolLabel,
  hasBillableCredits,
  MOTHERSHIP_USAGE_SOURCES,
  resolveUsageSourceLabel,
} from '@/app/workspace/[workspaceId]/settings/components/usage/format'
import {
  isLegacyUnattributedChatId,
  LEGACY_UNATTRIBUTED_CHAT_ID,
  LEGACY_UNATTRIBUTED_CHAT_TITLE,
  withLegacyUnattributedChatRow,
} from '@/app/workspace/[workspaceId]/settings/components/usage/legacy-unattributed-chat'
import {
  USAGE_PERIODS,
  USAGE_TABS,
  USER_WORKSPACE_FILTER_ALL,
  type UsagePeriod,
  type UsageScope,
  type UsageTab,
  usageParsers,
  usageUrlKeys,
} from '@/app/workspace/[workspaceId]/settings/components/usage/search-params'
import {
  buildWorkflowAverageCostChartRows,
  buildWorkflowTotalCostChartRows,
} from '@/app/workspace/[workspaceId]/settings/components/usage/workflow-chart-rows'
import { billingCreditUsageKeys } from '@/hooks/queries/billing-credit-usage'
import {
  organizationKeys,
  useAdminOrganizations,
  useOrganizationRoster,
} from '@/hooks/queries/organization'
import { useOrganizationUsageAnalytics } from '@/hooks/queries/organization-usage'
import { useUserUsageAnalytics } from '@/hooks/queries/user-usage'
import { useWorkspacePermissionsQuery, useWorkspaceSettings } from '@/hooks/queries/workspace'
import { useWorkspaceUsageAnalytics } from '@/hooks/queries/workspace-usage'

const TAB_LABELS: Record<UsageTab, string> = {
  all: 'All sources',
  workflow: 'Workflows',
  mothership: 'Mothership',
}

const SCOPE_LABELS: Record<UsageScope, string> = {
  user: 'User',
  workspace: 'Workspace',
  organization: 'Organization',
}

const USER_WORKSPACE_FILTER_CURRENT = 'current' as const

const SUMMARY_METRIC_TOOLTIPS = {
  tokens: 'Total input and output tokens from billing ledger rows in the selected period.',
  invocations: 'Number of billed model or provider invocations recorded in the billing ledger.',
  ledgerEntries:
    'Rows in the billing ledger (usage_log) that contribute to cost totals in this view.',
  executions: 'Distinct workflow runs in the selected period, including runs without ledger cost.',
  chats: 'Distinct Mothership and copilot chat sessions in the selected period.',
  runs: 'Distinct copilot or Mothership assistant runs within chats in the selected period.',
} as const

interface SummaryCardProps {
  label: string
  value: string
  hint?: string
  infoTooltip?: string
  isLoading?: boolean
}

function SummaryCard({ label, value, hint, infoTooltip, isLoading }: SummaryCardProps) {
  return (
    <div className='flex min-w-0 flex-1 flex-col gap-1 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-4 py-3'>
      <div className='flex items-center gap-1'>
        <span className='text-[var(--text-muted)] text-small'>{label}</span>
        {infoTooltip && (
          <Info side='top' align='start' className='flex-shrink-0 text-[var(--text-icon)]'>
            {infoTooltip}
          </Info>
        )}
      </div>
      {isLoading ? (
        <Skeleton className='h-7 w-24' />
      ) : (
        <span className='font-medium text-[var(--text-primary)] text-lg tabular-nums'>{value}</span>
      )}
      {hint && !isLoading && <span className='text-[var(--text-muted)] text-xs'>{hint}</span>}
    </div>
  )
}

interface UsageDashboardContentProps {
  workspaceId: string
  data: WorkspaceUsageAnalytics
  tab: UsageTab
  userNameById: Map<string, string>
  rootExecutionId: string | null
  onSelectRoot: (rootExecutionId: string) => void
  onClearDrillDown: () => void
}

function UsageDashboardContent({
  workspaceId,
  data,
  tab,
  userNameById,
  rootExecutionId,
  onSelectRoot,
  onClearDrillDown,
}: UsageDashboardContentProps) {
  const showWorkflow = tab === 'all' || tab === 'workflow'
  const showMothership = tab === 'all' || tab === 'mothership'
  const { openGroups, setGroupOpen } = useUsageCollapsibleGroups(tab)
  const toolRows = data.byTool.filter(
    (row) => hasBillableCredits(row.billableCost) && row.toolId !== COPILOT_USAGE_TOOL_BUCKET_ID
  )

  const workflowChartRows = useMemo(
    () =>
      buildWorkflowTotalCostChartRows(
        data.workflow.byWorkflow,
        (workflowId) => `/workspace/${workspaceId}/logs?workflowIds=${workflowId}`
      ),
    [data.workflow.byWorkflow, workspaceId]
  )

  const workflowAverageChartRows = useMemo(
    () =>
      buildWorkflowAverageCostChartRows(
        data.workflow.byWorkflow,
        (workflowId) => `/workspace/${workspaceId}/logs?workflowIds=${workflowId}`
      ),
    [data.workflow.byWorkflow, workspaceId]
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
              <ChipLink
                href={`/workspace/${workspaceId}/logs`}
                target='_blank'
                rel='noopener noreferrer'
              >
                View execution logs
              </ChipLink>
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
                getRowKey={(row) => row.workflowId ?? `unknown-${row.workflowName}`}
                emptyMessage='No workflow executions in this period.'
                columns={[
                  {
                    key: 'workflow',
                    header: 'Workflow',
                    render: (row) => {
                      const label = row.workflowName ?? row.workflowId ?? 'Unknown workflow'
                      if (row.workflowId) {
                        return (
                          <ChipLink
                            href={`/workspace/${workspaceId}/logs?workflowIds=${row.workflowId}`}
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

          <LineagePanel
            workspaceId={workspaceId}
            lineage={data.lineage}
            rootExecutionId={rootExecutionId}
            userNameById={userNameById}
            onSelectRoot={onSelectRoot}
            onClearDrillDown={onClearDrillDown}
          />
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
              <ChipLink
                href={`/workspace/${workspaceId}/home`}
                target='_blank'
                rel='noopener noreferrer'
              >
                Open mothership
              </ChipLink>
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
                      getRowKey={(row) => row.triggeringChatId}
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
                  getRowKey={(row) => row.chatId}
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
                              href={getMothershipChatPath(workspaceId, row.chatId)}
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

export function Usage() {
  const { workspaceId } = useParams<{ workspaceId: string }>()
  const queryClient = useQueryClient()
  const [
    {
      scope,
      tab,
      period,
      allTime,
      startTime,
      endTime,
      rootExecutionId,
      orgWorkspaceId,
      userWorkspaceId,
    },
    setUsageParams,
  ] = useQueryStates(usageParsers, usageUrlKeys)
  const [datePickerOpen, setDatePickerOpen] = useState(false)

  const isCustomRange = Boolean(startTime && endTime) && !allTime

  const { data: permissions, isPending: permissionsLoading } =
    useWorkspacePermissionsQuery(workspaceId)
  const { data: workspaceSettings, isPending: workspaceSettingsLoading } =
    useWorkspaceSettings(workspaceId)
  const { data: adminOrganizations, isPending: adminOrganizationsLoading } = useAdminOrganizations()

  const isWorkspaceAdmin = permissions?.viewer?.isAdmin ?? false
  const organizationId = workspaceSettings?.settings?.workspace?.organizationId ?? null

  /**
   * Gate matches the usage API (`isOrganizationAdminOrOwner` by userId), not
   * Better Auth `getFullOrganization` + email matching — that path can hide the
   * toggle when organizationId is set but the client org payload is incomplete.
   */
  const canViewOrganizationUsage = Boolean(
    organizationId &&
      adminOrganizations?.organizations.some((organization) => organization.id === organizationId)
  )

  const availableScopes = useMemo(() => {
    // Screenshots only cover User + Organization dashboards (no Workspace / source tabs).
    const scopes: UsageScope[] = ['user']
    if (canViewOrganizationUsage) scopes.push('organization')
    return scopes
  }, [canViewOrganizationUsage])

  const didAutoSelectOrganizationScope = useRef(false)

  /**
   * Org admins land on the Organization dashboard once. Do not re-run after the
   * viewer picks User — `scope=user` is the nuqs default and is stripped from
   * the URL, which would otherwise look like "no explicit choice".
   */
  useEffect(() => {
    if (didAutoSelectOrganizationScope.current) return
    if (permissionsLoading || workspaceSettingsLoading || adminOrganizationsLoading) return
    if (!canViewOrganizationUsage) return
    if (scope !== 'user') return
    const params = new URLSearchParams(window.location.search)
    if (params.has('scope')) return
    didAutoSelectOrganizationScope.current = true
    void setUsageParams({ scope: 'organization' })
  }, [
    adminOrganizationsLoading,
    canViewOrganizationUsage,
    permissionsLoading,
    scope,
    setUsageParams,
    workspaceSettingsLoading,
  ])

  const effectiveScope: UsageScope = availableScopes.includes(scope) ? scope : 'user'
  const isUserScope = effectiveScope === 'user'
  const isWorkspaceScope = effectiveScope === 'workspace'
  const isOrganizationScope = effectiveScope === 'organization'
  const showScopeToggle = availableScopes.length > 1

  const isUserAllWorkspaces = isUserScope && userWorkspaceId === USER_WORKSPACE_FILTER_ALL
  const resolvedUserWorkspaceId = isUserAllWorkspaces ? undefined : (userWorkspaceId ?? workspaceId)
  const userLineageWorkspaceId = isUserAllWorkspaces ? null : (resolvedUserWorkspaceId ?? null)

  const analyticsQuery = useMemo(() => {
    const base = allTime
      ? { allTime: 'true' as const }
      : isCustomRange && startTime && endTime
        ? { startTime, endTime }
        : { period: period as UsagePeriod }

    // Simplified dashboards (admin + member) always include all billable sources.
    if (isOrganizationScope || isUserScope) return base
    if (tab === 'workflow') return { ...base, sources: 'workflow' }
    if (tab === 'mothership') return { ...base, sources: MOTHERSHIP_USAGE_SOURCES }
    return base
  }, [allTime, endTime, isCustomRange, isOrganizationScope, isUserScope, period, startTime, tab])

  const handlePeriodChange = (value: string) => {
    if (value === 'custom') {
      setDatePickerOpen(true)
      return
    }
    if (value === 'all') {
      void setUsageParams({ allTime: true, startTime: null, endTime: null })
      return
    }
    void setUsageParams({
      allTime: false,
      period: value as UsagePeriod,
      startTime: null,
      endTime: null,
    })
  }

  const handleDateRangeApply = (nextStart: string, nextEnd: string) => {
    void setUsageParams({
      allTime: false,
      startTime: nextStart,
      endTime: nextEnd,
    })
    setDatePickerOpen(false)
  }

  const handleDatePickerCancel = () => {
    setDatePickerOpen(false)
  }

  const workspaceAnalyticsQuery = useMemo(() => {
    const withLineage =
      isWorkspaceScope && rootExecutionId && (tab === 'workflow' || tab === 'all')
        ? { rootExecutionId }
        : {}

    return { ...analyticsQuery, ...withLineage }
  }, [analyticsQuery, isWorkspaceScope, rootExecutionId, tab])

  const organizationAnalyticsQuery = useMemo(
    () => ({
      ...analyticsQuery,
      ...(orgWorkspaceId ? { workspaceId: orgWorkspaceId } : {}),
    }),
    [analyticsQuery, orgWorkspaceId]
  )

  const userAnalyticsQuery = useMemo(() => {
    const withWorkspace = resolvedUserWorkspaceId ? { workspaceId: resolvedUserWorkspaceId } : {}
    const withLineage =
      userLineageWorkspaceId && rootExecutionId && (tab === 'workflow' || tab === 'all')
        ? { rootExecutionId }
        : {}

    return { ...analyticsQuery, ...withWorkspace, ...withLineage }
  }, [analyticsQuery, resolvedUserWorkspaceId, rootExecutionId, tab, userLineageWorkspaceId])

  const {
    data: userData,
    isLoading: userLoading,
    isFetching: userFetching,
    error: userError,
    refetch: refetchUser,
  } = useUserUsageAnalytics(userAnalyticsQuery, isUserScope)

  const {
    data: workspaceData,
    isLoading: workspaceLoading,
    isFetching: workspaceFetching,
    error: workspaceError,
    refetch: refetchWorkspace,
  } = useWorkspaceUsageAnalytics(
    isWorkspaceAdmin && isWorkspaceScope ? workspaceId : undefined,
    workspaceAnalyticsQuery
  )

  const {
    data: organizationData,
    isLoading: organizationAnalyticsLoading,
    isFetching: organizationFetching,
    error: organizationError,
    refetch: refetchOrganization,
  } = useOrganizationUsageAnalytics(
    canViewOrganizationUsage ? (organizationId ?? undefined) : undefined,
    organizationAnalyticsQuery,
    isOrganizationScope
  )

  const orgWorkspaceFilterOptions = useMemo(() => {
    const options = [{ label: 'All Workspaces', value: 'all' }]
    for (const ws of organizationData?.workspaces ?? []) {
      options.push({ label: ws.name, value: ws.id })
    }
    return options
  }, [organizationData?.workspaces])

  const userWorkspaceFilterOptions = useMemo(() => {
    const options: Array<{ label: string; value: string }> = [
      { label: 'Current workspace', value: USER_WORKSPACE_FILTER_CURRENT },
      { label: 'All workspaces', value: USER_WORKSPACE_FILTER_ALL },
    ]
    for (const ws of userData?.workspaces ?? []) {
      if (ws.id === workspaceId) continue
      options.push({ label: ws.name, value: ws.id })
    }
    return options
  }, [userData?.workspaces, workspaceId])

  const userWorkspaceSelectValue =
    userWorkspaceId === USER_WORKSPACE_FILTER_ALL
      ? USER_WORKSPACE_FILTER_ALL
      : userWorkspaceId
        ? userWorkspaceId
        : USER_WORKSPACE_FILTER_CURRENT

  const { data: organizationRoster } = useOrganizationRoster(
    isOrganizationScope && canViewOrganizationUsage ? organizationId : undefined
  )

  const data = isUserScope ? userData : isOrganizationScope ? organizationData : workspaceData
  const isLoading = isUserScope
    ? userLoading
    : isOrganizationScope
      ? organizationAnalyticsLoading
      : workspaceLoading
  const isFetching = isUserScope
    ? userFetching
    : isOrganizationScope
      ? organizationFetching
      : workspaceFetching
  const error = isUserScope ? userError : isOrganizationScope ? organizationError : workspaceError
  const refetchAnalytics = isUserScope
    ? refetchUser
    : isOrganizationScope
      ? refetchOrganization
      : refetchWorkspace

  const refetch = () => {
    void refetchAnalytics()
    // Remaining credits live in a separate React Query cache — activity refresh
    // alone left the hero number stuck until a full remount.
    void queryClient.invalidateQueries({ queryKey: billingCreditUsageKeys.all })
    void queryClient.invalidateQueries({
      queryKey: organizationKeys.myMemberCredits(workspaceId),
    })
  }

  const workspaceUserNameById = useMemo(() => {
    const map = new Map<string, string>()
    for (const user of permissions?.users ?? []) {
      map.set(user.userId, user.name ?? user.email)
    }
    return map
  }, [permissions?.users])

  const organizationUserLabelById = useMemo(() => {
    const map = new Map<string, string>()
    for (const member of organizationRoster?.members ?? []) {
      // Admin screenshot shows emails in By User.
      map.set(member.userId, member.email || member.name || member.userId)
    }
    return map
  }, [organizationRoster?.members])

  const userNameById = isOrganizationScope ? organizationUserLabelById : workspaceUserNameById

  const orgWorkspaceFilterLabel = useMemo(() => {
    if (!orgWorkspaceId) return 'All Workspaces'
    return (
      organizationData?.workspaces.find((workspace) => workspace.id === orgWorkspaceId)?.name ??
      'Selected workspace'
    )
  }, [orgWorkspaceId, organizationData?.workspaces])

  const userWorkspaceFilterLabel = useMemo(() => {
    if (userWorkspaceId === USER_WORKSPACE_FILTER_ALL) return 'all workspaces'
    if (userWorkspaceId) {
      return (
        userData?.workspaces.find((workspace) => workspace.id === userWorkspaceId)?.name ??
        'selected workspace'
      )
    }
    return 'current workspace'
  }, [userData?.workspaces, userWorkspaceId])

  const handleSelectRoot = (nextRootExecutionId: string) => {
    void setUsageParams({ rootExecutionId: nextRootExecutionId, tab: 'workflow' })
  }

  const handleClearDrillDown = () => {
    void setUsageParams({ rootExecutionId: null })
  }

  if (
    permissionsLoading ||
    workspaceSettingsLoading ||
    (organizationId && adminOrganizationsLoading)
  ) {
    return (
      <div className='flex items-center justify-center py-16'>
        <Loader className='size-5 text-[var(--text-muted)]' />
      </div>
    )
  }

  const periodLabel = allTime
    ? 'All time'
    : isCustomRange && startTime && endTime
      ? `${formatDateShort(startTime)} – ${formatDateShort(endTime)}`
      : data
        ? `${formatPeriodLabel(period)} · ${new Date(data.period.startTime).toLocaleDateString()} – ${new Date(data.period.endTime).toLocaleDateString()}`
        : formatPeriodLabel(period)

  const periodSelectorValue = allTime ? 'all' : isCustomRange ? 'custom' : period

  const periodStatusLabel = allTime
    ? 'all-time period'
    : isCustomRange && startTime && endTime
      ? `custom range (${formatDateShort(startTime)} – ${formatDateShort(endTime)})`
      : `past ${formatAdminPeriodChipLabel(period).toLowerCase()}`

  const emptyCopy = isUserScope
    ? isUserAllWorkspaces
      ? 'No billing ledger entries were found for your activity across membership workspaces in the selected period. Workflow and mothership activity may still exist without cost rows.'
      : 'No billing ledger entries were found for your activity in this workspace in the selected period. Workflow and mothership activity may still exist without cost rows.'
    : isOrganizationScope
      ? 'No billing ledger entries were found across organization workspaces in the selected period. Workflow and mothership activity may still exist without cost rows.'
      : 'No billing ledger entries were found for this workspace in the selected period. Workflow and mothership activity may still exist without cost rows.'

  const adminPeriodFilters = (
    <>
      <div className='relative flex flex-wrap items-center gap-2'>
        <ChipButtonGroup value={periodSelectorValue} onValueChange={handlePeriodChange}>
          {USAGE_PERIODS.map((periodId) => (
            <ChipButtonGroupItem key={periodId} value={periodId}>
              {formatAdminPeriodChipLabel(periodId)}
            </ChipButtonGroupItem>
          ))}
          <ChipButtonGroupItem value='all'>All time</ChipButtonGroupItem>
          <ChipButtonGroupItem value='custom'>Custom</ChipButtonGroupItem>
        </ChipButtonGroup>
        <Popover
          open={datePickerOpen}
          onOpenChange={(isOpen) => {
            if (!isOpen) handleDatePickerCancel()
          }}
        >
          <PopoverAnchor className='pointer-events-none absolute inset-0' />
          <PopoverContent align='end' sideOffset={4} className='w-auto p-0'>
            <Calendar
              mode='range'
              showTime
              startDate={startTime ?? undefined}
              endDate={endTime ?? undefined}
              onRangeChange={handleDateRangeApply}
              onCancel={handleDatePickerCancel}
            />
          </PopoverContent>
        </Popover>
      </div>
      <ChipSelect
        align='end'
        value={orgWorkspaceId ?? 'all'}
        onChange={(value) => {
          void setUsageParams({
            orgWorkspaceId: value === 'all' ? null : value,
          })
        }}
        options={orgWorkspaceFilterOptions}
      />
    </>
  )

  const userPeriodFilters = (
    <>
      <div className='relative flex flex-wrap items-center gap-2'>
        <ChipButtonGroup value={periodSelectorValue} onValueChange={handlePeriodChange}>
          {USAGE_PERIODS.map((periodId) => (
            <ChipButtonGroupItem key={periodId} value={periodId}>
              {formatAdminPeriodChipLabel(periodId)}
            </ChipButtonGroupItem>
          ))}
          <ChipButtonGroupItem value='all'>All time</ChipButtonGroupItem>
          <ChipButtonGroupItem value='custom'>Custom</ChipButtonGroupItem>
        </ChipButtonGroup>
        <Popover
          open={datePickerOpen}
          onOpenChange={(isOpen) => {
            if (!isOpen) handleDatePickerCancel()
          }}
        >
          <PopoverAnchor className='pointer-events-none absolute inset-0' />
          <PopoverContent align='end' sideOffset={4} className='w-auto p-0'>
            <Calendar
              mode='range'
              showTime
              startDate={startTime ?? undefined}
              endDate={endTime ?? undefined}
              onRangeChange={handleDateRangeApply}
              onCancel={handleDatePickerCancel}
            />
          </PopoverContent>
        </Popover>
      </div>
      <ChipSelect
        align='end'
        value={userWorkspaceSelectValue}
        onChange={(value) => {
          const nextFilter =
            value === USER_WORKSPACE_FILTER_CURRENT
              ? null
              : value === USER_WORKSPACE_FILTER_ALL
                ? USER_WORKSPACE_FILTER_ALL
                : value
          void setUsageParams({
            userWorkspaceId: nextFilter,
            rootExecutionId: nextFilter === USER_WORKSPACE_FILTER_ALL ? null : rootExecutionId,
          })
        }}
        options={userWorkspaceFilterOptions}
      />
    </>
  )

  const scopeToggle = showScopeToggle ? (
    <ChipButtonGroup
      value={effectiveScope}
      onValueChange={(value) => {
        const nextScope = value as UsageScope
        void setUsageParams({
          scope: nextScope,
          rootExecutionId:
            nextScope === 'organization' ||
            (nextScope === 'user' && userWorkspaceId === USER_WORKSPACE_FILTER_ALL)
              ? null
              : rootExecutionId,
          orgWorkspaceId: nextScope === 'organization' ? orgWorkspaceId : null,
          userWorkspaceId: nextScope === 'user' ? userWorkspaceId : null,
        })
      }}
    >
      {availableScopes.map((scopeId) => (
        <ChipButtonGroupItem key={scopeId} value={scopeId}>
          {SCOPE_LABELS[scopeId]}
        </ChipButtonGroupItem>
      ))}
    </ChipButtonGroup>
  ) : null

  if (isOrganizationScope) {
    return (
      <div className='flex h-full flex-col bg-[var(--bg)]'>
        <div className='min-h-0 flex-1 overflow-y-auto px-6 [scrollbar-gutter:stable_both-edges]'>
          <div className='mx-auto flex max-w-[56rem] flex-col gap-6 pt-6 pb-8'>
            <div className='flex flex-wrap items-start justify-between gap-3'>
              <div className='flex flex-col gap-1'>
                <span className='font-medium text-[var(--brand-secondary)] text-caption uppercase tracking-wide'>
                  For admins & owners
                </span>
                <h1 className='font-medium text-[var(--text-primary)] text-lg'>Usage</h1>
                <p className='text-[var(--text-muted)] text-small'>
                  Near real-time. Credits reset with your organization&apos;s billing cycle.
                </p>
              </div>
              <div className='flex flex-wrap items-center gap-2'>
                {scopeToggle}
                <button
                  type='button'
                  onClick={() => void refetch()}
                  disabled={isFetching}
                  className='flex items-center gap-1.5 rounded-md px-2 py-1 text-[var(--text-secondary)] text-small transition-colors hover-hover:bg-[var(--surface-2)] hover-hover:text-[var(--text-primary)] disabled:opacity-50'
                >
                  <RefreshCw className={cn('size-[14px]', isFetching && 'animate-spin')} />
                  Refresh
                </button>
              </div>
            </div>

            <UsageBillingStats view='organization' />

            {error && (
              <div className='rounded-lg border border-[var(--border)] bg-[var(--surface-3)] px-4 py-3'>
                <p className='text-[var(--text-primary)] text-small'>
                  Failed to load usage analytics.
                </p>
                <p className='mt-1 text-[var(--text-muted)] text-small'>{error.message}</p>
              </div>
            )}

            {isLoading && !data && (
              <div className='flex items-center justify-center py-12'>
                <Loader className='size-5 text-[var(--text-muted)]' />
              </div>
            )}

            {data && organizationData && (
              <OrganizationAdminUsageContent
                data={organizationData}
                userLabelById={userNameById}
                workspaceFilterLabel={orgWorkspaceFilterLabel}
                periodStatusLabel={periodStatusLabel}
                filters={adminPeriodFilters}
              />
            )}
          </div>
        </div>
      </div>
    )
  }

  if (isUserScope) {
    const isOrgAdminOrOwner = canViewOrganizationUsage

    return (
      <div className='flex h-full flex-col bg-[var(--bg)]'>
        <div className='min-h-0 flex-1 overflow-y-auto px-6 [scrollbar-gutter:stable_both-edges]'>
          <div className='mx-auto flex max-w-[56rem] flex-col gap-6 pt-6 pb-8'>
            <div className='flex flex-wrap items-start justify-between gap-3'>
              <div className='flex flex-col gap-1'>
                <span
                  className={cn(
                    'font-medium text-caption uppercase tracking-wide',
                    isOrgAdminOrOwner ? 'text-[var(--brand-secondary)]' : 'text-[var(--text-muted)]'
                  )}
                >
                  {isOrgAdminOrOwner ? 'For admins & owners' : 'For users'}
                </span>
                <h1 className='font-medium text-[var(--text-primary)] text-lg'>Usage</h1>
                <p className='text-[var(--text-muted)] text-small'>
                  Near real-time. Credits reset with your organization&apos;s billing cycle.
                </p>
              </div>
              <div className='flex flex-wrap items-center gap-2'>
                {scopeToggle}
                <button
                  type='button'
                  onClick={() => void refetch()}
                  disabled={isFetching}
                  className='flex items-center gap-1.5 rounded-md px-2 py-1 text-[var(--text-secondary)] text-small transition-colors hover-hover:bg-[var(--surface-2)] hover-hover:text-[var(--text-primary)] disabled:opacity-50'
                >
                  <RefreshCw className={cn('size-[14px]', isFetching && 'animate-spin')} />
                  Refresh
                </button>
              </div>
            </div>

            <UsageBillingStats view='user' />

            {error && (
              <div className='rounded-lg border border-[var(--border)] bg-[var(--surface-3)] px-4 py-3'>
                <p className='text-[var(--text-primary)] text-small'>
                  Failed to load usage analytics.
                </p>
                <p className='mt-1 text-[var(--text-muted)] text-small'>{error.message}</p>
              </div>
            )}

            {isLoading && !data && (
              <div className='flex items-center justify-center py-12'>
                <Loader className='size-5 text-[var(--text-muted)]' />
              </div>
            )}

            {data && userData && (
              <UserMemberUsageContent
                data={userData}
                workspaceFilterLabel={userWorkspaceFilterLabel}
                periodStatusLabel={periodStatusLabel}
                filters={userPeriodFilters}
              />
            )}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className='flex h-full flex-col bg-[var(--bg)]'>
      <div className='min-h-0 flex-1 overflow-y-auto px-6 [scrollbar-gutter:stable_both-edges]'>
        <div className='mx-auto flex max-w-[56rem] flex-col gap-6 pt-6 pb-8'>
          <div className='flex flex-col gap-4'>
            <div className='flex flex-wrap items-center justify-between gap-3'>
              <div>
                <h1 className='font-medium text-[var(--text-primary)] text-lg'>Usage</h1>
                <p className='mt-0.5 text-[var(--text-secondary)] text-small'>{periodLabel}</p>
              </div>
              <button
                type='button'
                onClick={() => void refetch()}
                disabled={isFetching}
                className='flex items-center gap-1.5 rounded-md px-2 py-1 text-[var(--text-secondary)] text-small transition-colors hover-hover:bg-[var(--surface-2)] hover-hover:text-[var(--text-primary)] disabled:opacity-50'
              >
                <RefreshCw className={cn('size-[14px]', isFetching && 'animate-spin')} />
                Refresh
              </button>
            </div>

            <UsageBillingStats view='user' />

            <div className='flex flex-wrap items-center gap-3'>
              {scopeToggle}

              <ChipButtonGroup
                value={tab}
                onValueChange={(value) =>
                  void setUsageParams({
                    tab: value as UsageTab,
                    rootExecutionId: value === 'mothership' ? null : rootExecutionId,
                  })
                }
              >
                {USAGE_TABS.map((tabId) => (
                  <ChipButtonGroupItem key={tabId} value={tabId}>
                    {TAB_LABELS[tabId]}
                  </ChipButtonGroupItem>
                ))}
              </ChipButtonGroup>

              <div className='relative flex flex-wrap items-center gap-2'>
                <ChipButtonGroup value={periodSelectorValue} onValueChange={handlePeriodChange}>
                  {USAGE_PERIODS.map((periodId) => (
                    <ChipButtonGroupItem key={periodId} value={periodId}>
                      {formatPeriodLabel(periodId)}
                    </ChipButtonGroupItem>
                  ))}
                  <ChipButtonGroupItem value='all'>All time</ChipButtonGroupItem>
                  <ChipButtonGroupItem value='custom'>Custom</ChipButtonGroupItem>
                </ChipButtonGroup>
                <Popover
                  open={datePickerOpen}
                  onOpenChange={(isOpen) => {
                    if (!isOpen) handleDatePickerCancel()
                  }}
                >
                  <PopoverAnchor className='pointer-events-none absolute inset-0' />
                  <PopoverContent align='end' sideOffset={4} className='w-auto p-0'>
                    <Calendar
                      mode='range'
                      showTime
                      startDate={startTime ?? undefined}
                      endDate={endTime ?? undefined}
                      onRangeChange={handleDateRangeApply}
                      onCancel={handleDatePickerCancel}
                    />
                  </PopoverContent>
                </Popover>
              </div>
            </div>
          </div>

          <div className='flex flex-wrap gap-3'>
            <SummaryCard
              label='Tokens'
              value={data ? formatTokenCount(data.summary.usage.totalTokens) : '—'}
              infoTooltip={SUMMARY_METRIC_TOOLTIPS.tokens}
              isLoading={isLoading}
            />
            <SummaryCard
              label='Invocations'
              value={data ? data.summary.usage.invocationCount.toLocaleString() : '—'}
              infoTooltip={SUMMARY_METRIC_TOOLTIPS.invocations}
              isLoading={isLoading}
            />
            <SummaryCard
              label='Ledger entries'
              value={data ? data.summary.ledgerEntryCount.toLocaleString() : '—'}
              infoTooltip={SUMMARY_METRIC_TOOLTIPS.ledgerEntries}
              isLoading={isLoading}
            />
            {(tab === 'all' || tab === 'workflow') && (
              <SummaryCard
                label='Executions'
                value={data ? data.summary.executionCount.toLocaleString() : '—'}
                infoTooltip={SUMMARY_METRIC_TOOLTIPS.executions}
                isLoading={isLoading}
              />
            )}
            {(tab === 'all' || tab === 'mothership') && (
              <>
                <SummaryCard
                  label='Chats'
                  value={data ? data.summary.chatCount.toLocaleString() : '—'}
                  infoTooltip={SUMMARY_METRIC_TOOLTIPS.chats}
                  isLoading={isLoading}
                />
                <SummaryCard
                  label='Runs'
                  value={data ? data.summary.runCount.toLocaleString() : '—'}
                  infoTooltip={SUMMARY_METRIC_TOOLTIPS.runs}
                  isLoading={isLoading}
                />
              </>
            )}
          </div>

          {error && (
            <div className='rounded-lg border border-[var(--border)] bg-[var(--surface-3)] px-4 py-3'>
              <p className='text-[var(--text-primary)] text-small'>
                Failed to load usage analytics.
              </p>
              <p className='mt-1 text-[var(--text-muted)] text-small'>{error.message}</p>
            </div>
          )}

          {isLoading && !data && (
            <div className='flex items-center justify-center py-12'>
              <Loader className='size-5 text-[var(--text-muted)]' />
            </div>
          )}

          {data && isWorkspaceScope && workspaceData && (
            <UsageDashboardContent
              workspaceId={workspaceId}
              data={workspaceData}
              tab={tab}
              userNameById={userNameById}
              rootExecutionId={rootExecutionId}
              onSelectRoot={handleSelectRoot}
              onClearDrillDown={handleClearDrillDown}
            />
          )}

          {data &&
            !isLoading &&
            data.summary.ledgerEntryCount === 0 &&
            data.summary.executionCount === 0 &&
            data.summary.chatCount === 0 && (
              <div className='flex flex-col items-center gap-2 py-8 text-center'>
                <Badge variant='gray-secondary' size='sm'>
                  No usage recorded
                </Badge>
                <p className='max-w-md text-[var(--text-muted)] text-small'>{emptyCopy}</p>
              </div>
            )}
        </div>
      </div>
    </div>
  )
}
