'use client'

import { useEffect, useRef, useSyncExternalStore } from 'react'
import { createLogger } from '@sim/logger'
import {
  type EChartsOptionLike,
  sanitizeEChartsOption,
} from '@/lib/chart-generation/echarts-option'

const logger = createLogger('ChatEChartsRenderer')

/**
 * Single shared ECharts module promise so the bundle is fetched once and every
 * chart on the page reuses the same in-flight download.
 */
let echartsModulePromise: Promise<typeof import('echarts')> | null = null

function loadECharts(): Promise<typeof import('echarts')> {
  echartsModulePromise ??= import('echarts')
  return echartsModulePromise
}

// Prefetch the ECharts bundle as soon as this module loads on the client
// (i.e. when a chat surface mounts), during idle time. By the time the first
// chart arrives the bundle is already downloaded, instead of the first chart
// paying the download cost.
if (typeof window !== 'undefined') {
  const prefetch = () => {
    loadECharts().catch(() => {
      // Allow a later render attempt to retry the import.
      echartsModulePromise = null
    })
  }
  if ('requestIdleCallback' in window) {
    window.requestIdleCallback(prefetch, { timeout: 3000 })
  } else {
    setTimeout(prefetch, 1000)
  }
}

interface ChatEChartsRendererProps {
  option: EChartsOptionLike
  height?: number
}

function subscribeToThemeClass(onStoreChange: () => void) {
  const root = document.documentElement
  const observer = new MutationObserver(onStoreChange)
  observer.observe(root, { attributes: true, attributeFilter: ['class'] })
  return () => observer.disconnect()
}

function isDarkTheme() {
  return document.documentElement.classList.contains('dark')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function resolveCssColor(element: HTMLElement, variable: string, fallback: string) {
  const previous = element.style.color
  element.style.color = `var(${variable}, ${fallback})`
  const resolved = getComputedStyle(element).color
  element.style.color = previous
  return resolved || fallback
}

function paintTextStyle(target: Record<string, unknown>, color: string) {
  const existing = isRecord(target.textStyle) ? target.textStyle : {}
  target.textStyle = { ...existing, color }
}

function paintAxis(axis: Record<string, unknown>, label: string, grid: string) {
  const axisLabel = isRecord(axis.axisLabel) ? axis.axisLabel : {}
  axis.axisLabel = { ...axisLabel, color: label }
  const nameTextStyle = isRecord(axis.nameTextStyle) ? axis.nameTextStyle : {}
  axis.nameTextStyle = { ...nameTextStyle, color: label }
  const axisLine = isRecord(axis.axisLine) ? axis.axisLine : {}
  const lineStyle = isRecord(axisLine.lineStyle) ? axisLine.lineStyle : {}
  axis.axisLine = { ...axisLine, lineStyle: { ...lineStyle, color: grid } }
  const splitLine = isRecord(axis.splitLine) ? axis.splitLine : {}
  const splitStyle = isRecord(splitLine.lineStyle) ? splitLine.lineStyle : {}
  axis.splitLine = { ...splitLine, lineStyle: { ...splitStyle, color: grid } }
}

/**
 * ECharts paints title, legend, and axis text on a canvas, so CSS color does not
 * reach them. Read the deployed-chat chart tokens (with text tokens as fallback)
 * and stamp those colors onto the option.
 */
function applyChartTheme(option: EChartsOptionLike, element: HTMLElement): EChartsOptionLike {
  const title = resolveCssColor(element, '--color-ds-chart-label', 'var(--text-primary, #1a1a1a)')
  const label = resolveCssColor(element, '--color-ds-chart-axis', 'var(--text-secondary, #525252)')
  const grid = resolveCssColor(element, '--color-ds-chart-grid-line', 'var(--border, #d8d8d8)')
  const background = resolveCssColor(element, '--color-ds-chart-background', 'transparent')

  const themed = structuredClone(sanitizeEChartsOption(option))
  themed.backgroundColor = background
  if (isRecord(themed.title)) paintTextStyle(themed.title, title)
  if (Array.isArray(themed.title)) {
    for (const entry of themed.title) {
      if (isRecord(entry)) paintTextStyle(entry, title)
    }
  }
  if (isRecord(themed.legend)) paintTextStyle(themed.legend, title)
  for (const key of ['xAxis', 'yAxis'] as const) {
    const axis = themed[key]
    if (Array.isArray(axis)) {
      for (const entry of axis) {
        if (isRecord(entry)) paintAxis(entry, label, grid)
      }
    } else if (isRecord(axis)) {
      paintAxis(axis, label, grid)
    }
  }
  for (const series of themed.series) {
    if (isRecord(series.label)) {
      series.label = { ...series.label, color: title }
    }
  }
  return themed
}

/**
 * Renders an agent/tool-provided ECharts option as an interactive chart inside a
 * chat message. ECharts is imported dynamically to keep it out of the initial
 * bundle and avoid SSR issues.
 */
export function ChatEChartsRenderer({ option, height = 400 }: ChatEChartsRendererProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const isDark = useSyncExternalStore(subscribeToThemeClass, isDarkTheme, () => false)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    let disposed = false
    let chart: import('echarts').ECharts | undefined
    let resizeObserver: ResizeObserver | undefined

    void loadECharts()
      .then((echarts) => {
        if (disposed || !container) return
        chart = echarts.init(container)
        chart.setOption(applyChartTheme(option, container))
        resizeObserver = new ResizeObserver(() => chart?.resize())
        resizeObserver.observe(container)
      })
      .catch((error) => {
        logger.error('Failed to render chart', { error })
      })

    return () => {
      disposed = true
      resizeObserver?.disconnect()
      chart?.dispose()
    }
  }, [option, isDark])

  return <div ref={containerRef} className='my-4 w-full' style={{ height }} />
}
