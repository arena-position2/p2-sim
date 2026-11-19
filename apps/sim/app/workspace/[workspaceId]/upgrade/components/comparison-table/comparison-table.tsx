'use client'
import { chipVariants, cn } from '@sim/emcn'
import { Check } from '@sim/emcn/icons'
import { SlackIcon } from '@/components/icons'
import { BillingPeriodToggle } from '@/app/workspace/[workspaceId]/upgrade/components/billing-period-toggle/billing-period-toggle'
import {
  type CellValue,
  COMPARISON_SECTIONS,
  type ComparisonSection,
  PLAN_COLUMNS,
  type PlanColumn,
  type PlanName,
} from '@/app/workspace/[workspaceId]/upgrade/components/comparison-table/comparison-data'

/** Maps a cell-icon identifier to its brand icon component. */
const CELL_ICONS = { slack: SlackIcon } as const

/**
 * Resolved CTA for a plan column, mirroring the upgrade-page plan cards so the
 * table and cards stay in lockstep (same label, variant, and disabled state).
 */
export interface ComparisonPlanCta {
  label: string
  variant: 'primary' | 'border-shadow'
  onClick: () => void
  disabled?: boolean
}

/**
 * Props for {@link ComparisonTable}.
 */
export interface ComparisonTableProps {
  /**
   * Resolved Pro price string, e.g. `"$29"`.
   * Sourced from the page-level `proPrice` derived from `useUpgradeState`.
   */
  proPrice: string
  /**
   * Resolved Max price string, e.g. `"$79"`.
   * Sourced from the page-level `maxPrice` derived from `useUpgradeState`.
   */
  maxPrice: string
  /**
   * Whether annual billing is currently selected.
   * Shared with the page-level {@link BillingPeriodToggle} via a single state source.
   */
  isAnnual: boolean
  /**
   * Invoked when the in-table billing toggle changes.
   * Should point to the same setter as the page-level toggle.
   */
  onIsAnnualChange: (isAnnual: boolean) => void
  /** Disables the in-table billing-period toggle while a plan action is pending. */
  billingPeriodDisabled?: boolean
  /**
   * Resolved CTA per plan column, mirroring the upgrade-page plan cards. Plans
   * without an entry (e.g. Free / Starter) render no button.
   */
  ctas: Partial<Record<PlanName, ComparisonPlanCta>>
  /** Optional comparison dataset override (Arena swaps Free→Starter, drops daily refresh). */
  sections?: ComparisonSection[]
  /** Optional column metadata override. */
  columns?: PlanColumn[]
}

/**
 * Renders a single cell value: `true` → check icon, `false` → em-dash, string → text.
 */
function Cell({ value }: { value: CellValue }) {
  if (value === true) {
    return (
      <span className='flex justify-center text-[var(--text-primary)]'>
        <Check className='size-[14px] shrink-0' />
      </span>
    )
  }
  if (value === false) {
    return (
      <span className='flex select-none justify-center text-[var(--text-muted)] text-base'>—</span>
    )
  }
  if (typeof value === 'object') {
    const Icon = CELL_ICONS[value.icon]
    return (
      <span className='flex justify-center'>
        <Icon className='size-[14px] shrink-0' />
      </span>
    )
  }
  return (
    <span className='block text-center text-[var(--text-primary)] text-small tabular-nums'>
      {value}
    </span>
  )
}

/**
 * Full plan-comparison table. Renders all sections from {@link COMPARISON_SECTIONS}
 * mapped over generically — no per-cell copy-paste. Prices for Pro and Max are
 * supplied as props so they stay in sync with the billing-period toggle in the
 * parent page.
 *
 * The top-left cell contains a "Compare plans" heading, a subtitle, and a
 * {@link BillingPeriodToggle} that shares state with the page-level toggle via
 * the `isAnnual` / `onIsAnnualChange` props.
 *
 * @example
 * ```tsx
 * <ComparisonTable
 *   proPrice={`$${proPrice}`}
 *   maxPrice={`$${maxPrice}`}
 *   isAnnual={state.isAnnual}
 *   onIsAnnualChange={state.setIsAnnual}
 *   ctas={{ Pro: proCta, Max: maxCta, Enterprise: enterpriseCta }}
 * />
 * ```
 */
export function ComparisonTable({
  proPrice,
  maxPrice,
  isAnnual,
  onIsAnnualChange,
  billingPeriodDisabled = false,
  ctas,
  sections = COMPARISON_SECTIONS,
  columns = PLAN_COLUMNS,
}: ComparisonTableProps) {
  const runtimePrices: Partial<Record<PlanName, string>> = {
    Pro: proPrice,
    Max: maxPrice,
  }
  const planColCount = columns.length

  return (
    <div className='w-full overflow-x-auto rounded-xl border border-[var(--border-1)]'>
      {/* CSS grid: 1 label col + N equal plan cols */}
      <div
        className='grid min-w-[640px]'
        style={{ gridTemplateColumns: `1fr repeat(${planColCount}, minmax(0, 1fr))` }}
      >
        {/* ── Column headers ── */}
        {/* Top-left cell: title, subtitle, and billing toggle */}
        <div className='flex h-full flex-col justify-between gap-3 border-[var(--border)] border-r bg-[var(--surface-1)] px-4 py-4'>
          <div className='flex flex-col gap-0.5'>
            <span className='text-[var(--text-primary)] text-base'>Compare plans</span>
            <span className='text-[var(--text-muted)] text-small'>Find the right plan for you</span>
          </div>
          <BillingPeriodToggle
            isAnnual={isAnnual}
            onChange={onIsAnnualChange}
            disabled={billingPeriodDisabled}
          />
        </div>

        {columns.map((col) => {
          const price = runtimePrices[col.name] ?? col.staticPrice ?? ''
          const cta = ctas[col.name]

          return (
            <div
              key={col.name}
              className='flex flex-col items-center gap-1 bg-[var(--surface-2)] px-3 py-4 text-center'
            >
              <span className='text-[var(--text-primary)] text-base'>{col.name}</span>
              <span className='text-[var(--text-primary)] text-md tabular-nums'>{price}</span>
              {cta && (
                <button
                  type='button'
                  onClick={cta.onClick}
                  disabled={cta.disabled}
                  aria-label={`${cta.label} — ${col.name}`}
                  className={cn(
                    chipVariants({ variant: cta.variant, fullWidth: true }),
                    'mt-2 w-full justify-center'
                  )}
                >
                  {cta.label}
                </button>
              )}
            </div>
          )
        })}

        {/* ── Sections ── */}
        {sections.map((section, sectionIdx) => (
          <div key={section.title} className='contents'>
            {/* Section header row — split so the left-column separator stays continuous */}
            <div
              className={cn(
                'border-[var(--border)] border-r bg-[var(--surface-1)] px-4 py-2',
                sectionIdx > 0 && 'border-[var(--border-1)] border-t'
              )}
            >
              <span className='text-[var(--text-primary)] text-small'>{section.title}</span>
            </div>
            <div
              className={cn(
                'bg-[var(--surface-2)]',
                sectionIdx > 0 && 'border-[var(--border-1)] border-t'
              )}
              style={{ gridColumn: `span ${planColCount} / span ${planColCount}` }}
            />

            {/* Feature rows */}
            {section.rows.map((row, rowIdx) => (
              <div key={row.label} className='contents'>
                {/* Label */}
                <div
                  className={cn(
                    'flex items-center border-[var(--border)] border-r bg-[var(--surface-1)] px-4 py-2.5',
                    rowIdx < section.rows.length - 1 && 'border-[var(--border-1)] border-b'
                  )}
                >
                  <span className='text-[var(--text-body)] text-small'>{row.label}</span>
                </div>

                {/* Plan cells */}
                {row.values.map((value, colIdx) => (
                  <div
                    key={columns[colIdx]?.name ?? colIdx}
                    className={cn(
                      'flex items-center justify-center bg-[var(--surface-2)] px-3 py-2.5',
                      rowIdx < section.rows.length - 1 && 'border-[var(--border-1)] border-b'
                    )}
                  >
                    <Cell value={value} />
                  </div>
                ))}
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}
