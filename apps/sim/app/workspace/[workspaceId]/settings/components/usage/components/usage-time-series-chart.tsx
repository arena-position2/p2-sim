'use client'

import { useMemo } from 'react'
import { LineChart } from '@sim/emcn'

interface UsageChartPoint {
  timestamp: string
  value: number
}

interface UsageChartSeries {
  id: string
  label: string
  color: string
  data: UsageChartPoint[]
  dashed?: boolean
}

import { dollarsToCredits } from '@/lib/billing/credits/conversion'

interface UsageTimeSeriesPoint {
  bucketStart: string
  billableCost: number
  executionCount: number
  activeUserCount: number
}

interface UsageTimeSeriesChartProps {
  timeSeries: UsageTimeSeriesPoint[]
  /** Distinct human actors across the full selected period (not a sum of daily counts). */
  periodActiveUserCount?: number
  /** When false, hides the active-users chart (e.g. user-scoped usage). Defaults to true. */
  showActiveUsers?: boolean
  /**
   * When false, shows credits-only on the cost chart (admin Usage mock).
   * Defaults to true for the denser analytics overlays.
   */
  showExecutionsOverlay?: boolean
  /** Override the cost chart header title. */
  costChartTitle?: string
}

/**
 * Cost / execution volume and active-user trends for the usage dashboard.
 *
 * LineChart uses `data` for the x-axis / hover timeline and early-returns
 * "No data" when it is empty — so billable cost is the primary series, with
 * executions overlaid via `series`. Active users sit on a separate chart
 * because LineChart shares a single Y-axis across series.
 */
export function UsageTimeSeriesChart({
  timeSeries,
  periodActiveUserCount,
  showActiveUsers = true,
  showExecutionsOverlay = true,
  costChartTitle,
}: UsageTimeSeriesChartProps) {
  const billableData = useMemo((): UsageChartPoint[] => {
    return timeSeries.map((bucket) => ({
      timestamp: bucket.bucketStart,
      value: dollarsToCredits(bucket.billableCost),
    }))
  }, [timeSeries])

  const series = useMemo((): UsageChartSeries[] => {
    if (!showExecutionsOverlay || timeSeries.length === 0) return []

    return [
      {
        id: 'executions',
        label: 'Executions',
        color: 'var(--brand-secondary)',
        data: timeSeries.map((bucket) => ({
          timestamp: bucket.bucketStart,
          value: bucket.executionCount,
        })),
        dashed: true,
      },
    ]
  }, [showExecutionsOverlay, timeSeries])

  const activeUserData = useMemo((): UsageChartPoint[] => {
    if (!showActiveUsers) return []
    return timeSeries.map((bucket) => ({
      timestamp: bucket.bucketStart,
      value: bucket.activeUserCount,
    }))
  }, [showActiveUsers, timeSeries])

  if (timeSeries.length === 0) {
    return (
      <p className='py-6 text-center text-[var(--text-muted)] text-small'>
        No time-series data for this period.
      </p>
    )
  }

  const activeUserTotalLabel =
    periodActiveUserCount === undefined
      ? null
      : `${periodActiveUserCount.toLocaleString()} ${periodActiveUserCount === 1 ? 'user' : 'users'}`

  const resolvedCostTitle =
    costChartTitle ?? (showExecutionsOverlay ? 'Cost & activity over time' : 'Cost over time')

  return (
    <div className='flex flex-col gap-4'>
      <div className='overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--bg)]'>
        <div className='flex flex-wrap items-center justify-between gap-2 border-[var(--border)] border-b px-4 py-3'>
          <p className='font-medium text-[var(--text-primary)] text-small'>{resolvedCostTitle}</p>
          <div className='flex items-center gap-3 text-[var(--text-muted)] text-micro'>
            <span className='inline-flex items-center gap-1.5'>
              <span
                aria-hidden='true'
                className='inline-block h-[2px] w-3 rounded-full bg-[var(--success)]'
              />
              Credits
            </span>
            {showExecutionsOverlay ? (
              <span className='inline-flex items-center gap-1.5'>
                <span
                  aria-hidden='true'
                  className='inline-block h-[2px] w-3 border-[var(--brand-secondary)] border-t border-dashed'
                />
                Executions
              </span>
            ) : null}
          </div>
        </div>
        <div className='px-3.5 py-2.5'>
          <LineChart
            data={billableData}
            label=''
            color='var(--success)'
            unit=' credits'
            series={series}
          />
        </div>
      </div>

      {showActiveUsers && (
        <div className='overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--bg)]'>
          <div className='flex flex-wrap items-center justify-between gap-2 border-[var(--border)] border-b px-4 py-3'>
            <p className='font-medium text-[var(--text-primary)] text-small'>
              Active users over time
            </p>
            {activeUserTotalLabel && (
              <span className='text-[var(--text-muted)] text-micro'>{activeUserTotalLabel}</span>
            )}
          </div>
          <div className='px-3.5 py-2.5'>
            <LineChart
              data={activeUserData}
              label=''
              color='var(--brand-primary-hex, var(--brand-400))'
            />
          </div>
        </div>
      )}
    </div>
  )
}
