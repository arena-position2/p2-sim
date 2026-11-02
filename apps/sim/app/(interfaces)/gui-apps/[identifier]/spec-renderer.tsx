'use client'

import {
  type CSSProperties,
  createContext,
  type FormEvent,
  Fragment,
  type KeyboardEvent,
  type ReactNode,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import type { Spec } from '@json-render/core'
import { cn } from '@sim/emcn'
import {
  BarChart3,
  Building2,
  Calendar,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Cloud,
  CloudLightning,
  CloudRain,
  CloudSnow,
  CloudSun,
  Copy,
  Download,
  Droplets,
  FileText,
  Filter,
  Globe,
  GripVertical,
  Inbox,
  Link2,
  Loader2,
  type LucideIcon,
  MessageSquare,
  Moon,
  MoreHorizontal,
  Pencil,
  Plus,
  Search,
  Settings,
  Shield,
  Sparkles,
  Star,
  Sun,
  Thermometer,
  Trash2,
  TrendingUp,
  Upload,
  Users,
  Wind,
} from 'lucide-react'
import Image from 'next/image'
import { ConstrainedChart } from '@/components/charts/constrained-chart'
import {
  GENERATIVE_APP_SUCCESS_TOAST_MS,
  type RunGenerativeAppActionMeta,
} from '@/lib/arena-generative-ui/action-runtime'
import { bindChartData } from '@/lib/arena-generative-ui/bind-chart-data'
import {
  collectionUsesApiPagination,
  isActionControlPending,
  isBoundPathPending,
  withAliasedProseState,
} from '@/lib/arena-generative-ui/binding-layout-plan'
import {
  isBoundIsoDate,
  isBoundRelativeDateFormat,
} from '@/lib/arena-generative-ui/bound-date-format'
import { formatBoundDisplay } from '@/lib/arena-generative-ui/bound-display'
import { parseBoundNumber } from '@/lib/arena-generative-ui/bound-number-format'
import {
  aggregateStatCollection,
  aggregateTableColumn,
  type BoundTableColumn,
  boundTableColumnLabel,
  parseBoundTableColumns,
  parseProseTable,
  parseStatAggregate,
  tableCellValue,
} from '@/lib/arena-generative-ui/bound-table-reshape'
import { resolveCatalogIconName } from '@/lib/arena-generative-ui/catalog-icon'
import {
  type ArenaGenerativeChatProtocol,
  getGenerativeAppConversationId,
} from '@/lib/arena-generative-ui/chat-protocol'
import { chatTurnsFromState } from '@/lib/arena-generative-ui/chat-turns'
import {
  type ArenaGenerativeFormField,
  asFieldString,
  asFieldStringList,
  collectVisibleFieldValues,
  expandValueFields,
  fieldIsVisible,
  formValuesFromRecord,
  isFormFieldType,
  isTruthyFieldValue,
  listFormFields,
  omitFormFieldValues,
  overlayClosePatch,
  overlayOpenPatch,
  overlayShowWhenUsesSelection,
  parseLabeledOptions,
  parseOptionList,
  parseShowWhen,
  resolveFieldValue,
  resolveLabeledOptionValue,
  snapshotFormValues,
  validateVisibleFields,
  valuesFromFormElement,
} from '@/lib/arena-generative-ui/form-fields'
import { parseBreadcrumbItems } from '@/lib/arena-generative-ui/gui-breadcrumb'
import {
  commandPaletteEntriesFromCollection,
  defaultCommandPaletteActionField,
  defaultCommandPalettePathField,
  defaultCommandPaletteTitleField,
  parseCommandPaletteItems,
} from '@/lib/arena-generative-ui/gui-command-palette'
import {
  paginationPageKey,
  parsePaginationMode,
  specHasPaginationControl,
} from '@/lib/arena-generative-ui/gui-pagination'
import {
  copyTextToClipboard,
  downloadMarkdownPdf,
  resolveHostContentAction,
  visibleMarkdownForElement,
} from '@/lib/arena-generative-ui/host-content-actions'
import {
  type CollectionSort,
  buildElementParents,
  collectionHasApiOwnedSort,
  collectionItemIdentity,
  collectKnownActionIds,
  collectLocalDiscoveryQuery,
  discoveryRegionId,
  dummyCollectionSeedFromSpec,
  filterCollectionItems,
  filterCollectionItemsBySelection,
  filterStaticTableRows,
  filterStaticTableRowsBySelection,
  hostStatePatchAtPath,
  implicitDummyTableStatePath,
  LOCAL_COLLECTION_PAGE_SIZE,
  type PaginatedCollection,
  paginateCollection,
  sortCollectionItems,
  sortStaticTableRows,
  spliceVisibleCollectionItems,
  withDummyCollectionSeed,
  workspacePaneId,
} from '@/lib/arena-generative-ui/local-discovery'
import { unboundCollections } from '@/lib/arena-generative-ui/unbound-collections'
import { paginationActionValues } from '@/lib/arena-generative-ui/pagination'
import { sectionIsMeasureOnly } from '@/lib/arena-generative-ui/section-measure'
import { resolveArenaGenerativeSpacing } from '@/lib/arena-generative-ui/theme'
import {
  ARENA_GENERATIVE_SELECTED_ID_KEY,
  ARENA_GENERATIVE_SELECTED_KEY,
  ARENA_GENERATIVE_STREAM_CONTENT_KEY,
  collectionClickPromotesSelection,
  collectionFromBoundValue,
  displayTextFromActionData,
  interpolateElementProps,
  parseTabItems,
  type RepeatItemScope,
  readScopedStatePath,
  repeatItemActionValues,
  repeatItemKey,
  specHasSamePageSelectItem,
  splitNavTarget,
} from '@/lib/arena-generative-ui/types'
import {
  type ArenaGenerativeUxPlan,
  specKeepsCollectionVisible,
} from '@/lib/arena-generative-ui/ux-compiler'
import { UX_DEFAULTS } from '@/lib/arena-generative-ui/ux-defaults'
import arenaLogo from '@/app/(interfaces)/chat/components/message/components/ArenaLogo.svg'
import { ChatComposer } from '@/app/(interfaces)/gui-apps/[identifier]/chat-composer'
import { ChatTypingIndicator } from '@/app/(interfaces)/gui-apps/[identifier]/chat-typing-indicator'
import {
  GuiHostCalendar,
  GuiHostDateInput,
} from '@/app/(interfaces)/gui-apps/[identifier]/gui-host-calendar'
import { GuiHostSearchField } from '@/app/(interfaces)/gui-apps/[identifier]/gui-host-search-field'
import {
  GuiHostBreadcrumb,
  GuiHostCommandPalette,
  GuiHostPagination,
  GuiHostPopover,
  GuiHostTooltip,
} from '@/app/(interfaces)/gui-apps/[identifier]/gui-host-shell'
import {
  GuiHostCarousel,
  GuiHostCollectionList,
  GuiHostFilmstrip,
  GuiHostKanban,
  GuiHostMap,
  GuiHostTimeline,
  GuiHostTree,
} from '@/app/(interfaces)/gui-apps/[identifier]/gui-host-widgets'
import { MarkdownText } from '@/app/(interfaces)/gui-apps/[identifier]/markdown-text'
import { useGenerativeAppHostState } from '@/app/(interfaces)/gui-apps/generative-app-host-state'
import {
  asGuiFormFiles,
  GUI_BOUND_EMPTY_CLASS as BOUND_EMPTY_CLASS,
  GUI_BUTTON_BASE_CLASS as BUTTON_BASE_CLASS,
  GUI_BUTTON_SIZE_CLASSES as BUTTON_SIZE_CLASSES,
  GUI_BUTTON_VARIANT_CLASSES as BUTTON_VARIANT_CLASSES,
  GUI_CHIP_TONE_CLASSES as CHIP_TONE_CLASSES,
  guiCardSurfaceClass as cardSurfaceClass,
  GUI_FIELD_INPUT_CLASS as FIELD_INPUT_CLASS,
  GUI_FIELD_NATIVE_CONTROL_CLASS as FIELD_NATIVE_CONTROL_CLASS,
  GUI_FIELD_TEXTAREA_CLASS as FIELD_TEXTAREA_CLASS,
  GuiFieldShell as FieldShell,
  guiFieldErrorClass as fieldErrorClass,
  GUI_CHIP_CLASS,
  GUI_OVERLAY_DIALOG_CLASS,
  GUI_OVERLAY_SCRIM_CLASS,
  GUI_TABLE_HEADER_ROW_CLASS,
  GuiFileInput,
  GuiMultiSelect,
  GuiSelect,
  guiButtonClass,
  GuiRequiredMark as RequiredMark,
  GUI_SURFACE_CARD as SURFACE_CARD,
  GUI_SURFACE_STAT as SURFACE_STAT,
  GUI_TONE_CLASSES as TONE_CLASSES,
  guiTextToneClass as textToneClass,
} from '@/app/(interfaces)/gui-apps/gui-chrome'

interface SpecElement {
  type?: string
  props?: Record<string, unknown>
  children?: string[]
}

interface SpecRendererProps {
  spec: Spec
  state: Record<string, unknown>
  pending: boolean
  /** Abandon in-flight CTAs so WorkingCard Cancel returns to idle. */
  onCancelPending?: () => void
  /** In-flight action ids. When set, bound regions and controls pending is per action. */
  pendingActionIds?: ReadonlySet<string>
  /** Host keys each action writes. Required for per-action bound-region pending. */
  actionHostKeys?: Record<string, readonly string[]>
  /** Markdown keys that alias `content` for showWhen and DataText. */
  proseAliasKeys?: readonly string[]
  /** visitorEmail / constant input names the host stamps; those fields never render. */
  actionHiddenInputs?: Record<string, readonly string[]>
  /** Reserved Start protocol each action may bind through Chat. */
  actionChatProtocol?: Record<string, ArenaGenerativeChatProtocol>
  /** localStorage key for the Chat conversationId. */
  conversationStorageKey?: string
  /** Compiler action plan. When omitted, confirm falls back to destructive variant. */
  uxPlan?: ArenaGenerativeUxPlan
  /** Current page path; Tabs use this when it matches an item, otherwise `activePath`. */
  currentPath?: string
  onNavigate: (path: string) => void
  onRunAction: (
    actionId: string,
    values: Record<string, unknown>,
    meta?: RunGenerativeAppActionMeta
  ) => Promise<void>
  /** Copies a Repeat row into host state without calling an API. */
  onSelectItem?: (item: unknown, index: number) => void
  /** Drops the copied Repeat row so an in-page detail can return to the list. */
  onClearItem?: () => void
  /** Drops selectedId without wiping generate content (top-level Tabs / page navigation). */
  onClearSelection?: () => void
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function asBoolean(value: unknown): boolean {
  return value === true
}

function asPositiveNumber(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return value
  }
  if (typeof value === 'string') {
    const parsed = Number(value)
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed
    }
  }
  return fallback
}

function asFiniteNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value)
    if (Number.isFinite(parsed)) return parsed
  }
  return undefined
}

const ICON_BY_NAME: Record<string, LucideIcon> = {
  search: Search,
  file: FileText,
  chart: BarChart3,
  shield: Shield,
  building: Building2,
  check: Check,
  spark: Sparkles,
  users: Users,
  globe: Globe,
  message: MessageSquare,
  link: Link2,
  inbox: Inbox,
  calendar: Calendar,
  star: Star,
  trend: TrendingUp,
  plus: Plus,
  pencil: Pencil,
  trash: Trash2,
  download: Download,
  copy: Copy,
  filter: Filter,
  upload: Upload,
  settings: Settings,
  more: MoreHorizontal,
  sun: Sun,
  moon: Moon,
  cloud: Cloud,
  'cloud-sun': CloudSun,
  'cloud-rain': CloudRain,
  'cloud-snow': CloudSnow,
  'cloud-lightning': CloudLightning,
  wind: Wind,
  droplet: Droplets,
  thermometer: Thermometer,
  back: ChevronLeft,
}

function roleIconName(label: string): string | null {
  const text = label.trim().toLowerCase()
  if (text === 'back') return 'back'
  if (text === 'search' || text === 'find') return 'search'
  if (text === 'delete' || text === 'remove') return 'trash'
  if (text === 'edit') return 'pencil'
  if (text === 'add' || text === 'create' || text === 'new') return 'plus'
  if (text === 'download') return 'download'
  if (text === 'copy') return 'copy'
  if (text === 'filter') return 'filter'
  if (text === 'upload') return 'upload'
  if (text === 'settings') return 'settings'
  return null
}

function RoleLabel({ label }: { label: string }) {
  const icon = roleIconName(label)
  if (!label && !icon) return null
  return (
    <>
      {icon ? <CatalogIcon name={icon} well='none' /> : null}
      {label}
    </>
  )
}

function looksLikeImageSrc(value: string): boolean {
  return /^(https?:|data:|\/)/i.test(value) || /\.(png|jpe?g|gif|svg|webp)(\?|$)/i.test(value)
}

function initialsFromName(value: string): string {
  const parts = value.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return ''
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return `${parts[0]?.[0] ?? ''}${parts[1]?.[0] ?? ''}`.toUpperCase()
}

interface AvatarModel {
  src: string
  initials: string
}

function avatarModel(
  props: Record<string, unknown>,
  state: Record<string, unknown>,
  scope?: RepeatItemScope
): AvatarModel {
  let src = asString(props.src) || asString(props.logoSrc)
  let initials = asString(props.initials)
  const statePath = asString(props.statePath)
  if (statePath) {
    const fromState = readScopedStatePath(state, statePath, scope)
    if (typeof fromState === 'string' && fromState.trim()) {
      if (looksLikeImageSrc(fromState)) src = src || fromState
      else initials = initials || initialsFromName(fromState)
    }
  }
  if (!initials && src) initials = initialsFromName(asString(props.title) || asString(props.alt))
  return { src, initials: initials || '?' }
}

function parseProgressStepLines(raw: string): Array<{ label: string; nested: boolean }> {
  return raw
    .split('\n')
    .map((line) => {
      if (!line.trim()) return null
      return { label: line.trim(), nested: /^\s{2,}|\t/.test(line) }
    })
    .filter((step): step is { label: string; nested: boolean } => step !== null)
}

function firstSearchFieldName(elements: Record<string, SpecElement>): string {
  for (const element of Object.values(elements)) {
    if (element.type !== 'SearchField') continue
    const name = asString(element.props?.name)
    if (name) return name
  }
  return 'query'
}

function parseChipSetValue(raw: string): { name: string | null; value: string } {
  const separator = raw.indexOf('=')
  if (separator > 0) {
    return { name: raw.slice(0, separator).trim(), value: raw.slice(separator + 1) }
  }
  return { name: null, value: raw }
}

/**
 * Document-order Chip ids that share a `setValue` field. Two or more means a
 * same-page view switch — the host paints selected, not duplicate brand/muted chips.
 */
function chipIdsForSetValueField(
  elements: Record<string, SpecElement>,
  rootId: string,
  field: string
): string[] {
  const ids: string[] = []
  const walk = (id: string) => {
    const element = elements[id]
    if (!element) return
    if (element.type === 'Chip') {
      const parsed = parseChipSetValue(asString(element.props?.setValue))
      if (parsed.name === field) ids.push(id)
    }
    for (const childId of element.children ?? []) walk(childId)
  }
  walk(rootId)
  return ids
}

function viewSwitchDefaultValues(
  elements: Record<string, SpecElement>,
  rootId: string,
  values: Record<string, unknown>
): Record<string, string> {
  const defaults: Record<string, string> = {}
  const seen = new Set<string>()
  const walk = (id: string) => {
    const element = elements[id]
    if (!element) return
    if (element.type === 'Chip') {
      const parsed = parseChipSetValue(asString(element.props?.setValue))
      if (parsed.name && !seen.has(parsed.name)) {
        seen.add(parsed.name)
        const group = chipIdsForSetValueField(elements, rootId, parsed.name)
        if (group.length >= 2) {
          const current = values[parsed.name]
          const currentText =
            current === undefined || current === null ? '' : String(current).trim()
          if (currentText.length === 0) defaults[parsed.name] = parsed.value
        }
      }
    }
    for (const childId of element.children ?? []) walk(childId)
  }
  walk(rootId)
  return defaults
}

/**
 * Brand when this Chip is the active view; muted otherwise. `null` keeps the
 * authored tone (suggestion chips, a lone setValue Chip).
 */
function viewSwitchChipTone(
  elementId: string,
  setValue: string,
  values: Record<string, unknown>,
  spec: Spec
): 'brand' | 'muted' | null {
  const parsed = parseChipSetValue(setValue)
  if (!parsed.name) return null
  const group = chipIdsForSetValueField(spec.elements, spec.root, parsed.name)
  if (group.length < 2) return null
  const current = values[parsed.name]
  const currentText = current === undefined || current === null ? '' : String(current).trim()
  const selectedId =
    currentText.length === 0
      ? group[0]
      : (group.find((id) => {
          const chipValue = parseChipSetValue(asString(spec.elements[id]?.props?.setValue)).value
          return chipValue === currentText
        }) ?? group[0])
  return elementId === selectedId ? 'brand' : 'muted'
}

function disclosureInstanceKey(elementId: string, scope?: RepeatItemScope): string {
  if (!scope) return elementId
  return `${elementId}:${repeatItemKey(scope.item, scope.index)}`
}

function disclosureIsOpen(
  key: string,
  defaultOpen: boolean,
  toggled: Record<string, boolean>
): boolean {
  return key in toggled ? toggled[key] : defaultOpen
}

function subtreeHasActionId(
  elements: Record<string, SpecElement>,
  id: string,
  actionId: string
): boolean {
  const element = elements[id]
  if (!element) return false
  if (asString(element.props?.actionId) === actionId) return true
  return (element.children ?? []).some((childId) => subtreeHasActionId(elements, childId, actionId))
}

/**
 * Patch that opens a closed Modal/Drawer. When `actionId` is set, only overlays
 * that contain that action (Form / SubmitButton / Button) are considered, so a
 * complete/delete CTA does not steal a create dialog.
 */
function closedOverlayOpenPatch(
  elements: Record<string, SpecElement>,
  visibilityValues: Record<string, unknown>,
  actionId?: string
): Record<string, unknown> | null {
  for (const [id, element] of Object.entries(elements)) {
    if (element.type !== 'Modal' && element.type !== 'Drawer') continue
    if (fieldIsVisible(element.props ?? {}, visibilityValues)) continue
    const patch = overlayOpenPatch(element.props?.showWhen)
    if (!patch) continue
    if (actionId && !subtreeHasActionId(elements, id, actionId)) continue
    return patch
  }
  return null
}

function overlayClosePatchForAction(
  elements: Record<string, SpecElement>,
  actionId: string
): Record<string, unknown> | null {
  if (!actionId) return null
  for (const [id, element] of Object.entries(elements)) {
    if (element.type !== 'Modal' && element.type !== 'Drawer') continue
    if (!subtreeHasActionId(elements, id, actionId)) continue
    const patch = overlayClosePatch(element.props?.showWhen)
    return Object.keys(patch).length > 0 ? patch : null
  }
  return null
}

function overlayFormFields(
  elements: Record<string, SpecElement>,
  flag: string
): ArenaGenerativeFormField[] {
  for (const element of Object.values(elements)) {
    if (element.type !== 'Modal' && element.type !== 'Drawer') continue
    const matches = parseShowWhen(element.props?.showWhen).some((clause) => clause.name === flag)
    if (!matches) continue
    return listFormFields(elements, element.children ?? [])
  }
  return []
}

const DEFAULT_PROGRESS_DURATION_MS = 150_000

const SECTION_WIDTHS = {
  narrow: 'max-w-2xl',
  wide: 'max-w-[1280px]',
  full: 'max-w-none',
} as const

/** Minimum track width per `Grid.columns` before the grid collapses. Sized so
 * `columns: 2` stays ~2-up on a 1280px History section instead of auto-fitting to 4. */
const GRID_MIN_ITEM_WIDTHS: Record<string, string> = {
  '2': '520px',
  '3': '300px',
  '4': '240px',
}

const DEFAULT_GRID_MIN_ITEM_WIDTH = '280px'
const DEFAULT_REPEAT_SKELETON_COUNT = 2

function toneClass(value: unknown, fallback: keyof typeof TONE_CLASSES = 'info'): string {
  const tone = asString(value, fallback)
  return TONE_CLASSES[tone as keyof typeof TONE_CLASSES] ?? TONE_CLASSES[fallback]
}

function collectionPageKey(elementId: string, statePath: string, scope?: RepeatItemScope): string {
  return paginationPageKey(elementId, statePath, scope?.index)
}

function CollectionPageChrome({
  paged,
  onPageChange,
}: {
  paged: PaginatedCollection<unknown>
  onPageChange: (page: number) => void
}) {
  return <GuiHostPagination mode='pages' paged={paged} onPageChange={onPageChange} />
}

/**
 * `secondary` is the default so a page that names no emphasis still reads as a
 * hierarchy rather than a wall of identical primary buttons.
 */
function buttonClass(
  props: Record<string, unknown>,
  fallbackVariant: keyof typeof BUTTON_VARIANT_CLASSES
): string {
  return guiButtonClass(props, fallbackVariant)
}

const DELTA_TONE_CLASSES = {
  positive: 'text-(--gui-success-text,#23784f)',
  negative: 'text-(--gui-error-text,#921010)',
  neutral: 'text-(--gui-text-muted,#575a66)',
} as const

function deltaToneClass(value: unknown): string {
  const tone = asString(value, 'neutral')
  return DELTA_TONE_CLASSES[tone as keyof typeof DELTA_TONE_CLASSES] ?? DELTA_TONE_CLASSES.neutral
}

const HEADING_SIZE_CLASSES = {
  h1: 'text-(length:--gui-heading-size,32px) leading-(--gui-heading-leading,40px)',
  h2: 'text-(length:--gui-title-size,24px) leading-(--gui-title-leading,32px)',
  h3: 'text-(length:--gui-section-size,18px) leading-(--gui-section-leading,26px)',
  h4: 'text-(length:--gui-body-size,16px) leading-(--gui-body-leading,24px)',
} as const

const CARD_TITLE_FEATURED_CLASS =
  'text-(length:--gui-title-size,24px) leading-(--gui-title-leading,32px)'
const CARD_TITLE_ITEM_CLASS =
  'text-(length:--gui-section-size,18px) leading-(--gui-section-leading,26px)'

function sectionWidthClass(value: unknown, measureOnly = false): string {
  if (measureOnly && asString(value) !== 'full') return SECTION_WIDTHS.narrow
  const width = asString(value, 'wide')
  return SECTION_WIDTHS[width as keyof typeof SECTION_WIDTHS] ?? SECTION_WIDTHS.wide
}

const ALIGN_ITEMS_CLASSES = {
  start: 'items-start',
  center: 'items-center',
  end: 'items-end',
  stretch: 'items-stretch',
} as const

function alignItemsClass(value: unknown, fallback: keyof typeof ALIGN_ITEMS_CLASSES): string {
  const align = asString(value, fallback)
  return (
    ALIGN_ITEMS_CLASSES[align as keyof typeof ALIGN_ITEMS_CLASSES] ?? ALIGN_ITEMS_CLASSES[fallback]
  )
}

/**
 * `auto-fit` + `minmax` keeps the grid responsive without media queries, and
 * `min(100%, …)` stops a wide track from overflowing a narrow viewport.
 */
function gridTemplateColumns(props: Record<string, unknown>): string {
  const explicit = asString(props.minItemWidth)
  const fromColumns = GRID_MIN_ITEM_WIDTHS[gridColumnCount(props)]
  const minItemWidth = explicit || fromColumns || DEFAULT_GRID_MIN_ITEM_WIDTH
  return `repeat(auto-fit, minmax(min(100%, ${minItemWidth}), 1fr))`
}

function gridColumnCount(props: Record<string, unknown>): string {
  const raw = props.columns
  if (typeof raw === 'number' && Number.isFinite(raw)) return String(raw)
  return asString(raw)
}

/**
 * Skeleton count for a pending Repeat inside a Grid. Matches `columns` so
 * loading density matches the loaded card grid (not a hardcoded 3).
 */
function repeatSkeletonCount(elements: Record<string, SpecElement>, repeatId: string): number {
  for (const element of Object.values(elements)) {
    if (element.type !== 'Grid') continue
    if (!(element.children ?? []).includes(repeatId)) continue
    const raw = Number.parseInt(gridColumnCount(element.props ?? {}), 10)
    if (Number.isFinite(raw) && raw >= 1) return Math.min(raw, 4)
  }
  return DEFAULT_REPEAT_SKELETON_COUNT
}

/**
 * Two-column form grids use equal `1fr` tracks instead of auto-fit min 420px,
 * which would wrap a stacked field into a single narrow column.
 */
function isEqualTwoColFormGrid(withinForm: boolean, props: Record<string, unknown>): boolean {
  return withinForm && gridColumnCount(props) === '2'
}

function visibleLayoutChildIds(
  elements: Record<string, SpecElement>,
  childIds: string[]
): string[] {
  return childIds.filter((id) => {
    const child = elements[id]
    return Boolean(child) && child.type !== 'Modal' && child.type !== 'Drawer'
  })
}

function hasSingleVisibleLayoutChild(
  elements: Record<string, SpecElement>,
  childIds: string[],
  visibilityValues: Record<string, unknown>
): boolean {
  let count = 0
  for (const id of childIds) {
    const child = elements[id]
    if (!child) continue
    if (child.type === 'Modal' || child.type === 'Drawer') continue
    if (!fieldIsVisible(child.props ?? {}, visibilityValues)) continue
    count += 1
    if (count > 1) return false
  }
  return true
}

function singleVisibleLayoutChildId(
  elements: Record<string, SpecElement>,
  childIds: string[],
  visibilityValues: Record<string, unknown>
): string | undefined {
  let found: string | undefined
  for (const id of childIds) {
    const child = elements[id]
    if (!child) continue
    if (child.type === 'Modal' || child.type === 'Drawer') continue
    if (!fieldIsVisible(child.props ?? {}, visibilityValues)) continue
    if (found) return undefined
    found = id
  }
  return found
}

/**
 * Repeat uses `display: contents`, so a Grid whose only child is Repeat is
 * still a multi-cell collection. Collapsing that to one column would ignore
 * `columns: 2` on History / card lists.
 */
function isRepeatCollectionRoot(
  elements: Record<string, SpecElement>,
  id: string | undefined,
  visibilityValues: Record<string, unknown>
): boolean {
  if (!id) return false
  const element = elements[id]
  if (!element) return false
  if (!fieldIsVisible(element.props ?? {}, visibilityValues)) return false
  if (element.type === 'Repeat') return true
  if (element.type !== 'Stack' && element.type !== 'Section') return false
  const nestedId = singleVisibleLayoutChildId(elements, element.children ?? [], visibilityValues)
  return isRepeatCollectionRoot(elements, nestedId, visibilityValues)
}

/** Splits `a | b | c` cells, keeping empty middles so columns stay aligned. */
function splitTableRow(row: string): string[] {
  return row.split('|').map((cell) => cell.trim())
}

function tableHeadersFromState(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const headers: string[] = []
  for (const entry of value) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
    for (const key of Object.keys(entry as Record<string, unknown>)) {
      if (!headers.includes(key)) headers.push(key)
    }
  }
  return headers
}

/** Parses `key: value` rows, or an object from host state, into pairs. */
function keyValueEntries(items: unknown, stateValue: unknown): Array<[string, unknown]> {
  if (stateValue && typeof stateValue === 'object' && !Array.isArray(stateValue)) {
    return Object.entries(stateValue as Record<string, unknown>)
  }
  if (typeof items !== 'string') return []
  const pairs: Array<[string, unknown]> = []
  for (const line of items.split('\n')) {
    const row = line.trim()
    if (!row) continue
    const separator = row.indexOf(':')
    if (separator < 0) {
      pairs.push([row, ''])
      continue
    }
    pairs.push([row.slice(0, separator).trim(), row.slice(separator + 1).trim()])
  }
  return pairs
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function looksLikeHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value.trim())
}

function ScalarValue({
  value,
  format,
  nowMs,
}: {
  value: unknown
  format?: string
  nowMs?: number
}) {
  if (typeof value === 'boolean') return <>{value ? 'Yes' : 'No'}</>
  if (typeof value === 'number' && Number.isFinite(value)) {
    return <>{formatBoundDisplay(String(value), format, { nowMs })}</>
  }
  if (typeof value === 'string' && looksLikeHttpUrl(value)) {
    const href = value.trim()
    return (
      <a
        href={href}
        className='font-medium text-(--gui-brand,#1a73e8) underline-offset-2 hover:underline'
        rel='noreferrer'
      >
        {href}
      </a>
    )
  }
  const text = displayFromStateValue(value, '', format, nowMs)
  return <>{text}</>
}

interface ProgressStepsViewProps {
  pending: boolean
  steps: Array<{ label: string; nested: boolean }>
  durationMs: number
}

function ProgressStepsView({ pending, steps, durationMs }: ProgressStepsViewProps) {
  const [elapsedMs, setElapsedMs] = useState(0)

  useEffect(() => {
    if (!pending) {
      setElapsedMs(0)
      return
    }
    const startedAt = Date.now()
    const timer = setInterval(() => {
      setElapsedMs(Date.now() - startedAt)
    }, 100)
    return () => clearInterval(timer)
  }, [pending])

  if (!pending || steps.length === 0) {
    return null
  }

  const sliceMs = durationMs / steps.length
  const completedCount = Math.min(steps.length - 1, Math.floor(elapsedMs / sliceMs))

  return (
    <ol className='flex flex-col gap-2 text-sm'>
      {steps.map((step, index) => {
        const done = index < completedCount
        const current = index === completedCount
        return (
          <li
            key={`${index}-${step.label}`}
            className={cn(
              'flex items-center gap-2',
              step.nested && 'pl-6',
              done && 'text-(--gui-text,#2c2d33)',
              current && 'font-medium text-(--gui-brand,#1a73e8)',
              !done && !current && 'text-(--gui-text-tertiary,#8a8d99)'
            )}
          >
            <span
              className={cn(
                'inline-flex size-5 items-center justify-center rounded-full border text-xs',
                done &&
                  'border-(--gui-brand,#1a73e8) bg-(--gui-brand,#1a73e8) text-(--gui-text-on-brand,#ffffff)',
                current && 'border-(--gui-brand,#1a73e8) text-(--gui-brand,#1a73e8)',
                !done && !current && 'border-(--gui-border,#e2e3e5)'
              )}
            >
              {done ? '✓' : current ? '…' : ''}
            </span>
            {step.label}
          </li>
        )
      })}
    </ol>
  )
}

const DEFAULT_WORKING_INTERVAL_MS = 2500

function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  if (seconds < 60) return `${seconds}s elapsed`
  const minutes = Math.floor(seconds / 60)
  return `${minutes}m ${seconds % 60}s elapsed`
}

interface WorkingCardViewProps {
  pending: boolean
  title: string
  estimate: string
  tip: string
  steps: Array<{ label: string; nested: boolean }>
  intervalMs: number
  cancelLabel: string
  showSkeleton: boolean
  onCancel?: () => void
}

function WorkingCardView({
  pending,
  title,
  estimate,
  tip,
  steps,
  intervalMs,
  cancelLabel,
  showSkeleton,
  onCancel,
}: WorkingCardViewProps) {
  const [elapsedMs, setElapsedMs] = useState(0)

  useEffect(() => {
    if (!pending) {
      setElapsedMs(0)
      return
    }
    const startedAt = Date.now()
    const timer = setInterval(() => {
      setElapsedMs(Date.now() - startedAt)
    }, 250)
    return () => clearInterval(timer)
  }, [pending])

  if (!pending) {
    return null
  }

  const hasSteps = steps.length > 0
  const currentIndex = hasSteps ? Math.min(steps.length - 1, Math.floor(elapsedMs / intervalMs)) : 0
  const percent = hasSteps ? Math.round(((currentIndex + 1) / steps.length) * 100) : undefined
  const meta = [estimate, formatElapsed(elapsedMs)].filter(Boolean).join(' · ')

  return (
    <div className='flex w-full flex-col gap-4' data-testid='working-card'>
      <div className='flex flex-col gap-4 rounded-(--gui-radius,12px) border border-(--gui-info-border,#a3c7f6) bg-(--gui-info-surface,#f3f8fe) p-5'>
        <div className='flex flex-wrap items-start justify-between gap-2'>
          <p className='font-semibold text-(--gui-brand,#1a73e8)'>
            {title || steps[currentIndex]?.label || 'Working…'}
          </p>
          {meta ? (
            <p className='text-(length:--gui-label-size,12px) text-(--gui-info-text,#10458b)'>
              {meta}
            </p>
          ) : null}
        </div>
        <div
          data-testid='working-card-bar'
          className='h-1.5 w-full overflow-hidden rounded-full bg-(--gui-info-border,#a3c7f6)'
          role='progressbar'
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percent}
        >
          <div
            className={cn(
              'h-full rounded-full bg-(--gui-brand,#1a73e8)',
              percent === undefined ? 'w-1/3 animate-pulse' : 'transition-[width] duration-300'
            )}
            style={percent === undefined ? undefined : { width: `${percent}%` }}
          />
        </div>
        {hasSteps ? (
          <ol className='flex flex-col gap-2.5'>
            {steps.map((step, index) => {
              const done = index < currentIndex
              const current = index === currentIndex
              return (
                <li
                  key={`${index}-${step.label}`}
                  className={cn(
                    'flex items-center gap-2.5 text-sm',
                    step.nested && 'pl-6',
                    done && 'text-(--gui-info-text,#10458b) line-through',
                    current && 'font-semibold text-(--gui-brand-pressed,#10458b)',
                    !done && !current && 'text-(--gui-info-text,#10458b)'
                  )}
                >
                  {done ? (
                    <span className='inline-flex size-5 shrink-0 items-center justify-center rounded-full bg-(--gui-success-text,#23784f) text-white'>
                      <Check className='size-3' aria-hidden />
                    </span>
                  ) : current ? (
                    <Loader2
                      className='size-5 shrink-0 animate-spin text-(--gui-brand,#1a73e8)'
                      aria-hidden
                    />
                  ) : (
                    <span className='size-5 shrink-0 rounded-full border border-(--gui-info-border,#a3c7f6)' />
                  )}
                  <span aria-current={current ? 'step' : undefined}>{step.label}</span>
                </li>
              )
            })}
          </ol>
        ) : null}
        {tip || onCancel ? (
          <div className='flex flex-col gap-3 border-(--gui-info-border,#a3c7f6) border-t pt-3'>
            {tip ? (
              <p className='text-(length:--gui-label-size,12px) text-(--gui-info-text,#10458b) italic'>
                {tip}
              </p>
            ) : null}
            {onCancel ? (
              <button
                type='button'
                data-testid='working-card-cancel'
                className={cn(
                  BUTTON_BASE_CLASS,
                  BUTTON_VARIANT_CLASSES.outline,
                  BUTTON_SIZE_CLASSES.sm,
                  'w-fit'
                )}
                onClick={onCancel}
              >
                {cancelLabel}
              </button>
            ) : null}
          </div>
        ) : null}
      </div>
      {showSkeleton ? <SkeletonBlock variant='outline' lines={6} /> : null}
    </div>
  )
}

const SKELETON_BAR =
  'animate-pulse rounded-(--gui-radius-sm,8px) bg-(--gui-border,#e2e3e5)'

const DEFAULT_SKELETON_LINES: Record<SkeletonVariant, number> = {
  text: 3,
  stat: 1,
  table: 4,
  card: 3,
  form: 3,
  outline: 6,
}

type SkeletonVariant = 'text' | 'stat' | 'table' | 'card' | 'form' | 'outline'

function skeletonVariant(value: unknown): SkeletonVariant {
  const variant = asString(value, 'text')
  return variant in DEFAULT_SKELETON_LINES ? (variant as SkeletonVariant) : 'text'
}

interface SkeletonBlockProps {
  variant: SkeletonVariant
  lines: number
}

/**
 * Shape-matched loading placeholder. Widths taper so a text block reads as prose
 * rather than a solid slab.
 */
const LoadingChromeContext = createContext<'skeleton' | 'spinner'>('skeleton')

function CircularLoader() {
  return (
    <div
      aria-busy='true'
      aria-live='polite'
      data-testid='circular-loader'
      className='flex w-full items-center justify-center py-8'
    >
      <Loader2 className='size-8 animate-spin text-(--gui-brand,#1a73e8)' />
    </div>
  )
}

function RefetchBusyChrome({ busy }: { busy: boolean }) {
  if (!busy) return null
  return (
    <p
      data-testid='refetch-busy'
      className='flex items-center gap-1.5 text-(length:--gui-label-size,12px) text-(--gui-text-muted,#575a66)'
    >
      <Loader2 className='size-3 animate-spin' aria-hidden />
      Updating
    </p>
  )
}

function SkeletonBlock({ variant, lines }: SkeletonBlockProps) {
  const chrome = useContext(LoadingChromeContext)
  if (chrome === 'spinner') return <CircularLoader />
  const rows = Math.max(1, Math.min(12, lines))

  if (variant === 'stat') {
    return (
      <div aria-hidden data-testid='skeleton' className={cn('flex flex-col gap-2', SURFACE_STAT)}>
        <div className={cn(SKELETON_BAR, 'h-3 w-1/2')} />
        <div className={cn(SKELETON_BAR, 'h-7 w-2/3')} />
      </div>
    )
  }

  if (variant === 'table') {
    return (
      <div aria-hidden data-testid='skeleton' className='flex w-full flex-col gap-2'>
        <div className={cn(SKELETON_BAR, 'h-4 w-full opacity-70')} />
        {Array.from({ length: rows }, (_, index) => (
          <div key={index} className={cn(SKELETON_BAR, 'h-8 w-full')} />
        ))}
      </div>
    )
  }

  if (variant === 'outline') {
    const widths = ['100%', '92%', '78%', '85%', '64%', '45%']
    return (
      <div aria-hidden data-testid='skeleton' className='flex w-full flex-col gap-3'>
        <div className={cn(SKELETON_BAR, 'h-5 w-full')} />
        {Array.from({ length: Math.max(0, rows - 1) }, (_, index) => (
          <div
            key={index}
            className={cn(SKELETON_BAR, 'h-3')}
            style={{ width: widths[Math.min(index + 1, widths.length - 1)] }}
          />
        ))}
      </div>
    )
  }

  const body = (
    <div className='flex w-full flex-col gap-2'>
      {Array.from({ length: rows }, (_, index) => (
        <div
          key={index}
          className={cn(SKELETON_BAR, variant === 'form' ? 'h-9 w-full' : 'h-4')}
          style={variant === 'form' ? undefined : { width: index === rows - 1 ? '60%' : '100%' }}
        />
      ))}
    </div>
  )

  if (variant === 'card') {
    return (
      <div aria-hidden data-testid='skeleton' className={SURFACE_CARD}>
        {body}
      </div>
    )
  }

  return (
    <div aria-hidden data-testid='skeleton'>
      {body}
    </div>
  )
}

/**
 * True when a bound region has nothing to show yet, so a pending action can
 * render a placeholder instead of collapsing to nothing.
 */
function isEmptyStateValue(value: unknown): boolean {
  if (value === undefined || value === null) return true
  if (typeof value === 'string') return value.trim().length === 0
  if (Array.isArray(value)) return value.length === 0
  if (typeof value === 'object') return Object.keys(value as Record<string, unknown>).length === 0
  return false
}

function specHasDataTextContent(elements: Record<string, SpecElement>): boolean {
  return Object.values(elements).some(
    (element) =>
      element.type === 'DataText' &&
      asString(element.props?.statePath) === ARENA_GENERATIVE_STREAM_CONTENT_KEY
  )
}

function readStatePath(
  state: Record<string, unknown>,
  path: string,
  scope?: RepeatItemScope
): unknown {
  return readScopedStatePath(state, path, scope)
}

function displayFromStateValue(
  value: unknown,
  fallback: string,
  format?: string,
  nowMs?: number
): string {
  if (isEmptyStateValue(value)) return fallback
  const fromAction = displayTextFromActionData(value)
  const text = fromAction || String(value)
  return formatBoundDisplay(text, format, { nowMs })
}

/** Group Stat numbers when the brief did not name a format. Dates still auto-pretty-print. */
function statDefaultNumberFormat(value: unknown): string | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return 'number'
  if (typeof value !== 'string') return undefined
  if (isBoundIsoDate(value)) return undefined
  return parseBoundNumber(value) === undefined ? undefined : 'number'
}

function specUsesRelativeDates(elements: Record<string, SpecElement>): boolean {
  for (const element of Object.values(elements)) {
    if (isBoundRelativeDateFormat(asString(element.props?.dateFormat))) return true
    for (const column of parseBoundTableColumns(asString(element.props?.columns))) {
      if (isBoundRelativeDateFormat(column.displayFormat)) return true
    }
    for (const value of Object.values(element.props ?? {})) {
      if (typeof value === 'string' && /\|(?:relative|ago)\b/i.test(value)) return true
    }
  }
  return false
}

function nextTableSort(current: CollectionSort | undefined, key: string): CollectionSort {
  if (current?.key === key) {
    return { key, direction: current.direction === 'asc' ? 'desc' : 'asc' }
  }
  return { key, direction: 'asc' }
}

function StateTable({
  value,
  columns,
  style,
  busy,
  sort,
  sortable = false,
  onSort,
  footerItems,
  nowMs,
  reorderable = false,
  onReorder,
  onSelectRow,
  renderRowActions,
}: {
  value: unknown
  columns?: string
  style?: CSSProperties
  busy?: boolean
  sort?: CollectionSort
  sortable?: boolean
  onSort?: (key: string) => void
  footerItems?: readonly unknown[]
  nowMs?: number
  reorderable?: boolean
  onReorder?: (fromIndex: number, toIndex: number) => void
  onSelectRow?: (item: unknown, index: number) => void
  renderRowActions?: (item: unknown, index: number) => ReactNode
}) {
  const items = Array.isArray(value) ? value : []
  const declaredColumns = parseBoundTableColumns(columns)
  const inferred = tableHeadersFromState(value).map((key) => ({
    key,
    indexColumn: false as const,
  }))
  const columnDefs: BoundTableColumn[] =
    declaredColumns.length > 0
      ? declaredColumns
      : inferred.map((column) => ({ key: column.key, indexColumn: false }))
  if (columnDefs.length === 0 && items.length === 0) return null
  const footerSource = footerItems ?? items
  const showFooter = columnDefs.some((column) => column.aggregate)
  const headerClass =
    'px-4 py-3 font-medium text-(length:--gui-label-size,12px) text-(--gui-text-muted,#575a66) uppercase tracking-[0.25px]'

  return (
    <div
      aria-busy={busy || undefined}
      className={cn(
        'w-full overflow-x-auto rounded-(--gui-radius,12px) border border-(--gui-border,#e2e3e5) bg-(--gui-surface,#ffffff)',
        busy && 'opacity-70'
      )}
      style={style}
    >
      <RefetchBusyChrome busy={Boolean(busy)} />
      <table className='w-full border-collapse text-left text-(length:--gui-body-size,16px) leading-(--gui-body-leading,24px)'>
        {columnDefs.length > 0 ? (
          <thead>
            <tr className={GUI_TABLE_HEADER_ROW_CLASS}>
              {reorderable ? <th className={headerClass} aria-label='Reorder' /> : null}
              {columnDefs.map((column) => {
                const label = boundTableColumnLabel(column)
                const sortKey = column.indexColumn ? '' : column.key
                const active = Boolean(sort && sortKey && sort.key === sortKey)
                const canSort = Boolean(sortable && onSort && sortKey)
                return (
                  <th
                    key={`${column.key}-${column.aggregate ?? ''}`}
                    aria-sort={
                      active ? (sort?.direction === 'desc' ? 'descending' : 'ascending') : 'none'
                    }
                    className={headerClass}
                  >
                    {canSort ? (
                      <button
                        type='button'
                        className='uppercase tracking-[0.25px]'
                        onClick={() => onSort?.(sortKey)}
                      >
                        {label}
                      </button>
                    ) : (
                      label
                    )}
                  </th>
                )
              })}
              {renderRowActions ? <th className={headerClass}>Actions</th> : null}
            </tr>
          </thead>
        ) : null}
        <tbody>
          {items.map((item, rowIndex) => (
            <tr
              key={`row-${rowIndex}`}
              draggable={reorderable}
              onDragStart={(event) => {
                event.dataTransfer.setData('text/plain', String(rowIndex))
                event.dataTransfer.effectAllowed = 'move'
              }}
              onDragOver={(event) => {
                if (!reorderable) return
                event.preventDefault()
              }}
              onDrop={(event) => {
                event.preventDefault()
                const from = Number(event.dataTransfer.getData('text/plain'))
                if (!Number.isInteger(from)) return
                onReorder?.(from, rowIndex)
              }}
              onKeyDown={(event) => {
                if (!reorderable || !event.altKey) return
                if (event.key === 'ArrowUp') {
                  event.preventDefault()
                  onReorder?.(rowIndex, Math.max(0, rowIndex - 1))
                }
                if (event.key === 'ArrowDown') {
                  event.preventDefault()
                  onReorder?.(rowIndex, Math.min(items.length - 1, rowIndex + 1))
                }
              }}
              className='border-(--gui-border,#e2e3e5) border-b last:border-b-0'
              onClick={
                onSelectRow
                  ? (event) => {
                      const target = event.target
                      if (!(target instanceof Element)) return
                      if (target.closest('button, a, input, select, textarea')) return
                      onSelectRow(item, rowIndex)
                    }
                  : undefined
              }
            >
              {reorderable ? (
                <td className='px-2 py-3'>
                  <span
                    aria-pressed={false}
                    className='inline-flex text-(--gui-text-tertiary,#8a8d99)'
                  >
                    <GripVertical className='size-[14px]' />
                  </span>
                </td>
              ) : null}
              {columnDefs.map((column, cellIndex) => (
                <td
                  key={`cell-${cellIndex}-${column.key}`}
                  className='px-4 py-3 align-top text-(--gui-text,#2c2d33)'
                >
                  <ScalarValue
                    value={tableCellValue(item, column, rowIndex)}
                    format={column.displayFormat}
                    nowMs={nowMs}
                  />
                </td>
              ))}
              {renderRowActions ? (
                <td className='px-4 py-3 align-top'>{renderRowActions(item, rowIndex)}</td>
              ) : null}
            </tr>
          ))}
        </tbody>
        {showFooter ? (
          <tfoot>
            <tr className='border-(--gui-border,#e2e3e5) border-t bg-(--gui-canvas,#f7f8f9) font-medium'>
              {reorderable ? <td className='px-2 py-3' /> : null}
              {columnDefs.map((column) => {
                const total = aggregateTableColumn(footerSource, column)
                return (
                  <td
                    key={`footer-${column.key}`}
                    className='px-4 py-3 text-(--gui-text,#2c2d33)'
                  >
                    {total === undefined ? (
                      ''
                    ) : (
                      <ScalarValue value={total} format={column.displayFormat} nowMs={nowMs} />
                    )}
                  </td>
                )
              })}
              {renderRowActions ? <td className='px-4 py-3' /> : null}
            </tr>
          </tfoot>
        ) : null}
      </table>
    </div>
  )
}

function StateKeyValue({
  pairs,
  busy,
  depth = 0,
}: {
  pairs: Array<[string, unknown]>
  busy?: boolean
  depth?: number
}) {
  if (pairs.length === 0) return null
  return (
    <dl
      aria-busy={busy || undefined}
      className='grid w-full grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-x-6 gap-y-3 text-(length:--gui-body-size,16px) leading-(--gui-body-leading,24px)'
    >
      {pairs.map(([key, value]) => (
        <Fragment key={key}>
          <dt className='font-medium text-(length:--gui-label-size,12px) text-(--gui-text-muted,#575a66) uppercase tracking-[0.25px]'>
            {key}
          </dt>
          <dd className='min-w-0 text-(--gui-text,#2c2d33)'>
            <KeyValueCell value={value} depth={depth} />
          </dd>
        </Fragment>
      ))}
    </dl>
  )
}

function KeyValueCell({ value, depth }: { value: unknown; depth: number }) {
  if (depth > 4) return <ScalarValue value={value} />
  if (Array.isArray(value)) {
    if (value.length === 0) return <span className='text-(--gui-text-muted,#575a66)'>—</span>
    const objectRows = value.every((item) => isPlainRecord(item))
    if (objectRows) {
      return <StateTable value={value} />
    }
    return (
      <ul className='flex list-disc flex-col gap-2 pl-5'>
        {value.map((item, index) => (
          <li key={index}>
            {isPlainRecord(item) || Array.isArray(item) ? (
              <KeyValueCell value={item} depth={depth + 1} />
            ) : (
              <ScalarValue value={item} />
            )}
          </li>
        ))}
      </ul>
    )
  }
  if (isPlainRecord(value)) {
    return <StateKeyValue pairs={Object.entries(value)} depth={depth + 1} />
  }
  return <ScalarValue value={value} />
}

const DEFAULT_EMPTY_TEXT = {
  collection: 'No results',
  details: 'No details',
} as const

/**
 * Zero-result copy for a bound collection. `col-span-full` lets it span a parent
 * Grid so an empty Repeat does not shrink to a single card cell.
 */
function EmptyState({ text }: { text: string }) {
  return (
    <p data-testid='empty-state' className={BOUND_EMPTY_CLASS}>
      {text}
    </p>
  )
}

/**
 * `fallback` is empty-state copy, not loading copy, so a pending action still shows the skeleton —
 * otherwise every DataText that declares a fallback silently opts out of its loading state.
 */
function DataTextView({
  value,
  fallback,
  pending,
  style,
}: {
  value: unknown
  fallback: string
  pending: boolean
  style?: CSSProperties
}) {
  const display = displayFromStateValue(value, fallback)
  if (pending && isEmptyStateValue(value)) {
    return (
      <div aria-live='polite' aria-busy='true'>
        <SkeletonBlock variant='text' lines={DEFAULT_SKELETON_LINES.text} />
      </div>
    )
  }
  return (
    <div aria-live='polite' aria-busy={pending || undefined}>
      <MarkdownText style={style} content={display} />
    </div>
  )
}

function ChatTranscript({ pinKey, children }: { pinKey: string; children: ReactNode }) {
  const endRef = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    endRef.current?.scrollIntoView?.({ block: 'end' })
  }, [pinKey])
  return (
    <div data-testid='generative-chat-transcript' className='flex w-full flex-col gap-3'>
      {children}
      <div ref={endRef} data-testid='generative-chat-transcript-end' />
    </div>
  )
}

function chatTurnBubbleClass(role: 'user' | 'assistant'): string {
  return cn(
    'max-w-[85%] rounded-(--gui-radius,12px) px-3 py-2',
    role === 'user'
      ? 'self-end bg-(--gui-brand-surface,#f3f8fe) text-(--gui-text,#2c2d33)'
      : 'self-start bg-(--gui-surface,#fff) text-(--gui-text,#2c2d33)'
  )
}

function submitButtonActionId(elements: Record<string, SpecElement>, childIds: string[]): string {
  for (const childId of childIds) {
    const child = elements[childId]
    if (!child) continue
    if (child.type === 'SubmitButton') {
      const actionId = asString(child.props?.actionId)
      if (actionId) return actionId
    }
    const nested = submitButtonActionId(elements, child.children ?? [])
    if (nested) return nested
  }
  return ''
}

function ActionBusyMark({ show }: { show: boolean }) {
  if (!show) return null
  return (
    <span
      data-testid='action-busy'
      aria-hidden
      className='inline-block size-3 animate-spin rounded-full border-2 border-current border-t-transparent'
    />
  )
}

function sparklinePoints(values: number[]): string {
  if (values.length === 0) return ''
  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = max - min || 1
  return values
    .map((value, index) => {
      const x = values.length === 1 ? 50 : (index / (values.length - 1)) * 100
      const y = 100 - ((value - min) / span) * 100
      return `${x},${y}`
    })
    .join(' ')
}

function numbersFromSparklineProps(
  props: Record<string, unknown>,
  state: Record<string, unknown>,
  scope?: RepeatItemScope
): number[] {
  const statePath = asString(props.statePath)
  if (statePath) {
    const raw = readScopedStatePath(state, statePath, scope)
    if (Array.isArray(raw)) {
      return raw.map((item) => Number(item)).filter((item) => Number.isFinite(item))
    }
  }
  const literal = asString(props.values)
  if (!literal) return []
  return literal
    .split(',')
    .map((part) => Number(part.trim()))
    .filter((item) => Number.isFinite(item))
}

const APP_HEADER_BAR_CLASS =
  'sticky top-0 z-20 w-full border-(--gui-border,#e2e3e5) border-b bg-(--gui-surface,#ffffff)'

function ArenaAppHeaderLogo() {
  return (
    <Image
      src={arenaLogo}
      alt='Arena'
      width={30}
      height={30}
      data-testid='app-header-logo'
      className='size-[30px] shrink-0'
      priority
    />
  )
}

function AppHeaderBar({ children }: { children: ReactNode }) {
  return (
    <header data-testid='app-header' className={APP_HEADER_BAR_CLASS}>
      <div className='flex w-full items-center gap-2.5 px-4 py-3'>
        <ArenaAppHeaderLogo />
        {children}
      </div>
    </header>
  )
}

function isBrandMarkType(type: string | undefined): boolean {
  return type === 'Icon' || type === 'Avatar'
}

/**
 * True when `id` is product chrome: AppHeader, or a horizontal brand row the
 * generator faked with Icon + title inside Section.
 */
function isAppChromeElement(elements: Record<string, SpecElement>, id: string): boolean {
  const element = elements[id]
  if (!element) return false
  if (element.type === 'AppHeader') return true
  if (element.type !== 'Stack' && element.type !== 'Toolbar') return false
  const direction = asString(
    element.props?.direction,
    element.type === 'Toolbar' ? 'horizontal' : 'vertical'
  )
  if (element.type === 'Stack' && direction !== 'horizontal') return false
  const kids = element.children ?? []
  const first = kids[0] ? elements[kids[0]] : undefined
  if (isBrandMarkType(first?.type)) return true
  if (first?.type === 'Stack') {
    const nestedId = first.children?.[0]
    const nested = nestedId ? elements[nestedId] : undefined
    return isBrandMarkType(nested?.type)
  }
  return false
}

function resolvePageChrome(
  elements: Record<string, SpecElement>,
  pageChildIds: string[]
): { id: string | null; nested: boolean } {
  for (const id of pageChildIds) {
    if (elements[id]?.type === 'AppHeader') return { id, nested: false }
  }
  const firstId = pageChildIds[0]
  const first = firstId ? elements[firstId] : undefined
  if (first?.type === 'Section') {
    const sectionFirstId = first.children?.[0]
    if (sectionFirstId && isAppChromeElement(elements, sectionFirstId)) {
      return { id: sectionFirstId, nested: true }
    }
  }
  if (firstId && isAppChromeElement(elements, firstId)) {
    return { id: firstId, nested: false }
  }
  return { id: null, nested: false }
}

function CatalogIcon({ name, well }: { name: string; well: string }) {
  const Glyph = ICON_BY_NAME[name] ?? Search
  const wellClass =
    well === 'circle' ? 'rounded-full' : well === 'square' ? 'rounded-(--gui-radius,12px)' : ''
  const icon = (
    <Glyph
      aria-hidden
      className={cn(well === 'none' ? 'size-5' : 'size-5', 'text-(--gui-brand,#1a73e8)')}
    />
  )
  if (well === 'none') {
    return <span className='inline-flex items-center justify-center'>{icon}</span>
  }
  return (
    <span
      data-testid='icon-well'
      className={cn(
        'inline-flex size-10 items-center justify-center bg-(--gui-brand-surface,#f3f8fe)',
        wellClass || 'rounded-full'
      )}
    >
      {icon}
    </span>
  )
}

function AvatarView({ src, initials }: AvatarModel) {
  return (
    <span
      data-testid='avatar'
      className='inline-flex size-10 shrink-0 items-center justify-center overflow-hidden rounded-full bg-(--gui-brand-surface,#f3f8fe) font-medium text-(--gui-brand,#1a73e8) text-sm'
    >
      {src ? <img src={src} alt='' className='size-full object-cover' /> : <span>{initials}</span>}
    </span>
  )
}

function specFormFields(elements: Record<string, SpecElement>): ArenaGenerativeFormField[] {
  return Object.values(elements).flatMap((element) =>
    isFormFieldType(element.type) ? [{ type: element.type, props: element.props ?? {} }] : []
  )
}

function styleFromProps(props: Record<string, unknown>): CSSProperties {
  const style: CSSProperties = {}
  const backgroundColor = asString(props.backgroundColor)
  const padding = asString(props.padding)
  const maxWidth = asString(props.maxWidth)
  const gap = asString(props.gap)
  if (backgroundColor) style.backgroundColor = backgroundColor
  if (padding) style.padding = resolveArenaGenerativeSpacing(padding)
  if (maxWidth) style.maxWidth = maxWidth
  if (gap) style.gap = resolveArenaGenerativeSpacing(gap)
  return style
}

function wrapTaskSurface(node: ReactNode): ReactNode {
  return node
}

function WorkspaceView({
  children,
  showInspector,
  style,
}: {
  children: ReactNode
  showInspector: boolean
  style?: CSSProperties
}) {
  const panes = Array.isArray(children) ? children : [children]
  const navigator = panes[0] ?? null
  const primary = panes[1] ?? null
  const inspector = panes[2] ?? null
  return (
    <div
      className={cn(
        'grid w-full grid-cols-1',
        'md:grid-cols-[240px_minmax(0,1fr)]',
        showInspector && inspector ? 'xl:grid-cols-[240px_minmax(0,1fr)_minmax(220px,320px)]' : null
      )}
      style={style}
    >
      {navigator ? <div className='min-w-0'>{navigator}</div> : null}
      <div className='min-w-0'>{primary}</div>
      {showInspector && inspector ? <div className='min-w-0'>{inspector}</div> : null}
    </div>
  )
}

function CatalogStepper({
  items,
  activePath,
  currentPath,
  onNavigate,
  style,
}: {
  items: Array<{ label: string; path: string }>
  activePath: string
  currentPath?: string
  onNavigate: (path: string) => void
  style?: CSSProperties
}) {
  const itemPaths = items.map((item) => splitNavTarget(item.path).path)
  const routePath = currentPath ? splitNavTarget(currentPath).path : ''
  const resolvedActive = itemPaths.includes(routePath) ? routePath : splitNavTarget(activePath).path

  return (
    <ol className='flex w-full flex-wrap items-center gap-2' style={style}>
      {items.map((item, index) => {
        const path = splitNavTarget(item.path).path
        const isActive = path === resolvedActive
        const isLink = path.length > 0 && path !== item.label
        return (
          <li key={`${item.label}-${path}-${index}`} className='flex items-center gap-2'>
            {index > 0 ? (
              <span className='text-(--gui-text-muted,#575a66)' aria-hidden>
                /
              </span>
            ) : null}
            {isLink ? (
              <button
                type='button'
                onClick={() => onNavigate(item.path)}
                aria-current={isActive ? 'step' : undefined}
                className={cn(
                  'text-(length:--gui-label-size,12px)',
                  isActive
                    ? 'font-medium text-(--gui-brand,#1a73e8)'
                    : 'text-(--gui-text-muted,#575a66) hover:text-(--gui-text,#2c2d33)'
                )}
              >
                {index + 1}. {item.label}
              </button>
            ) : (
              <span
                aria-current={isActive ? 'step' : undefined}
                className={cn(
                  'text-(length:--gui-label-size,12px)',
                  isActive
                    ? 'font-medium text-(--gui-text,#2c2d33)'
                    : 'text-(--gui-text-muted,#575a66)'
                )}
              >
                {index + 1}. {item.label}
              </span>
            )}
          </li>
        )
      })}
    </ol>
  )
}

function CatalogTabs({
  items,
  activePath,
  currentPath,
  onNavigate,
  style,
}: {
  items: Array<{ label: string; path: string }>
  activePath: string
  currentPath?: string
  onNavigate: (path: string) => void
  style?: CSSProperties
}) {
  const itemPaths = items.map((item) => splitNavTarget(item.path).path)
  const routePath = currentPath ? splitNavTarget(currentPath).path : ''
  const resolvedActive = itemPaths.includes(routePath) ? routePath : splitNavTarget(activePath).path

  const focusTab = (event: KeyboardEvent<HTMLButtonElement>, index: number, key: string) => {
    if (key !== 'ArrowLeft' && key !== 'ArrowRight') return
    event.preventDefault()
    const delta = key === 'ArrowRight' ? 1 : -1
    const next = (index + delta + items.length) % items.length
    const tabs = event.currentTarget.parentElement?.querySelectorAll('[role="tab"]')
    const target = tabs?.[next]
    if (target instanceof HTMLElement) target.focus()
  }

  return (
    <nav
      className='flex w-full flex-wrap items-center gap-1 border-(--gui-border,#e2e3e5) border-b'
      style={style}
    >
      {items.map((item, index) => {
        const isActive = splitNavTarget(item.path).path === resolvedActive
        return (
          <button
            key={item.path}
            type='button'
            role='tab'
            tabIndex={isActive ? 0 : -1}
            aria-selected={isActive}
            aria-current={isActive ? 'page' : undefined}
            onClick={() => onNavigate(item.path)}
            onKeyDown={(event) => focusTab(event, index, event.key)}
            className={cn(
              '-mb-px border-b-2 px-4 py-2.5 text-(length:--gui-body-size,16px)',
              isActive
                ? 'border-(--gui-brand,#1a73e8) font-medium text-(--gui-brand,#1a73e8)'
                : 'border-transparent text-(--gui-text-muted,#575a66) hover:text-(--gui-text,#2c2d33)'
            )}
          >
            {item.label}
          </button>
        )
      })}
    </nav>
  )
}

function CatalogImage({
  src,
  alt,
  width,
  height,
}: {
  src: string
  alt: string
  width?: string
  height?: string
}) {
  const [failed, setFailed] = useState(false)
  if (!src || failed) {
    return (
      <div
        data-testid='image-fallback'
        role={alt ? 'img' : undefined}
        aria-label={alt || undefined}
        className='flex min-h-16 items-center justify-center bg-(--gui-canvas,#f7f8f9) text-(length:--gui-label-size,12px) text-(--gui-text-muted,#575a66)'
      >
        {alt}
      </div>
    )
  }
  return (
    <img
      src={src}
      alt={alt}
      width={width}
      height={height}
      loading='lazy'
      onError={() => setFailed(true)}
    />
  )
}

/**
 * Local overlay chrome for catalog Modal / Drawer. Uses `--gui-*` tokens, not editor ChipModal.
 */
function CatalogOverlayShell({
  testId,
  title,
  placement,
  onClose,
  children,
}: {
  testId: string
  title: string
  placement: 'modal' | 'drawer-left' | 'drawer-right'
  onClose: () => void
  children: ReactNode
}) {
  const dialogRef = useRef<HTMLDivElement>(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  const titleId = `${testId}-title`

  useEffect(() => {
    const previous = document.activeElement
    const focusable = dialogRef.current?.querySelector<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    )
    focusable?.focus()
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onCloseRef.current()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      if (previous instanceof HTMLElement) previous.focus()
    }
  }, [])

  const isDrawer = placement !== 'modal'
  const drawerSide = placement === 'drawer-left' ? 'left-0' : 'right-0'

  return (
    <div className={isDrawer ? 'pointer-events-none fixed inset-0 z-30' : GUI_OVERLAY_SCRIM_CLASS}>
      <button
        type='button'
        aria-label='Close'
        className={cn(
          'absolute inset-0 cursor-default bg-transparent',
          isDrawer ? 'pointer-events-auto' : null
        )}
        onClick={() => onCloseRef.current()}
      />
      <div
        ref={dialogRef}
        role='dialog'
        aria-modal='true'
        aria-labelledby={titleId}
        data-testid={testId}
        className={cn(
          GUI_OVERLAY_DIALOG_CLASS,
          isDrawer
            ? cn('absolute top-0 bottom-0 w-[min(100%,24rem)]', drawerSide)
            : 'relative z-10 w-full max-w-lg rounded-(--gui-radius,12px)'
        )}
        onClick={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key !== 'Tab') return
          const nodes = dialogRef.current?.querySelectorAll<HTMLElement>(
            'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
          )
          if (!nodes?.length) return
          const first = nodes[0]
          const last = nodes[nodes.length - 1]
          if (event.shiftKey && document.activeElement === first) {
            event.preventDefault()
            last.focus()
          } else if (!event.shiftKey && document.activeElement === last) {
            event.preventDefault()
            first.focus()
          }
        }}
      >
        <div className='flex items-center justify-between gap-3 border-(--gui-border,#e2e3e5) border-b px-4 py-3'>
          <h2 id={titleId} className='font-semibold text-(--gui-text,#2c2d33) text-base'>
            {title}
          </h2>
          <button
            type='button'
            data-testid={`${testId}-close`}
            className='rounded-(--gui-radius,12px) px-2 py-1 text-(--gui-text-muted,#575a66) text-sm hover:bg-(--gui-surface-muted,#f7f8f9)'
            onClick={() => onCloseRef.current()}
          >
            Close
          </button>
        </div>
        <div className='min-h-0 flex-1 overflow-auto p-4'>{children}</div>
      </div>
    </div>
  )
}

function DismissibleCatalogOverlay({
  open,
  title,
  testId,
  placement,
  onClearItem,
  onDismiss,
  children,
}: {
  open: boolean
  title: string
  testId: string
  placement: 'modal' | 'drawer-left' | 'drawer-right'
  onClearItem?: () => void
  onDismiss?: () => void
  children: ReactNode
}) {
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => {
    if (!open) setDismissed(false)
  }, [open])

  if (!open || dismissed) return null

  return (
    <CatalogOverlayShell
      testId={testId}
      title={title}
      placement={placement}
      onClose={() => {
        setDismissed(true)
        onDismiss?.()
        onClearItem?.()
      }}
    >
      {children}
    </CatalogOverlayShell>
  )
}

function CatalogToastView({ text, tone }: { text: string; tone: unknown }) {
  const [hidden, setHidden] = useState(false)

  useEffect(() => {
    setHidden(false)
    const timer = window.setTimeout(() => setHidden(true), GENERATIVE_APP_SUCCESS_TOAST_MS)
    return () => window.clearTimeout(timer)
  }, [text])

  if (hidden) return null

  return (
    <div
      role='status'
      data-testid='catalog-toast'
      className='pointer-events-none fixed inset-x-0 bottom-6 z-20 flex justify-center px-4'
    >
      <p
        className={cn(
          'rounded-(--gui-radius,12px) px-4 py-2 text-sm shadow-(--gui-shadow-card,0px_2px_8px_rgba(44,45,51,0.1))',
          toneClass(tone, 'info')
        )}
      >
        {text}
      </p>
    </div>
  )
}

/**
 * Walks a json-render Spec and renders Arena Generative UI catalog components.
 */
export function SpecRenderer({
  spec,
  state: rawState,
  pending,
  pendingActionIds,
  actionHostKeys,
  proseAliasKeys,
  actionHiddenInputs,
  actionChatProtocol,
  conversationStorageKey,
  uxPlan,
  currentPath,
  onNavigate,
  onRunAction,
  onSelectItem,
  onClearItem,
  onClearSelection,
  onCancelPending,
}: SpecRendererProps) {
  const dummySeed = useMemo(() => dummyCollectionSeedFromSpec(spec), [spec])
  const host = useGenerativeAppHostState()
  const state = withAliasedProseState(
    withDummyCollectionSeed({ ...rawState, ...host.state }, spec),
    proseAliasKeys ?? []
  )
  const elements = (spec.elements ?? {}) as Record<string, SpecElement>
  const suppressBoundSkeleton = Object.values(elements).some((element) => {
    if (element.type !== 'WorkingCard') return false
    return element.props?.skeleton !== false
  })
  useLayoutEffect(() => {
    const fill: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(dummySeed)) {
      if (rawState[key] === undefined) fill[key] = value
    }
    host.fillMissingState(fill)
  }, [dummySeed, host.fillMissingState, rawState])
  const pageKey = currentPath ?? ''
  const [formValues, setFormValuesState] = useState<Record<string, unknown>>(() =>
    pageKey ? host.pageFormValues(pageKey) : {}
  )
  const [overlayFlags, setOverlayFlags] = useState<Record<string, unknown>>({})
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({})
  const [localPages, setLocalPagesState] = useState<Record<string, number>>(() =>
    pageKey ? host.pageLocalPages(pageKey) : {}
  )
  const [disclosureOpen, setDisclosureOpen] = useState<Record<string, boolean>>({})
  const [regionSelection, setRegionSelection] = useState<
    Record<string, { id: string; item: unknown }>
  >({})
  const [tableSorts, setTableSorts] = useState<Record<string, CollectionSort>>({})
  const usesRelativeDates = specUsesRelativeDates(elements)
  const [nowMs, setNowMs] = useState(() => Date.now())
  useEffect(() => {
    if (!usesRelativeDates) return
    const timer = setInterval(() => setNowMs(Date.now()), 60_000)
    return () => clearInterval(timer)
  }, [usesRelativeDates])
  const setFormValues = (
    update:
      | Record<string, unknown>
      | ((current: Record<string, unknown>) => Record<string, unknown>)
  ) => {
    setFormValuesState((current) => {
      const next = typeof update === 'function' ? update(current) : update
      if (pageKey) host.setPageFormValues(pageKey, next)
      return next
    })
  }
  const setLocalPages = (
    update: Record<string, number> | ((current: Record<string, number>) => Record<string, number>)
  ) => {
    setLocalPagesState((current) => {
      const next = typeof update === 'function' ? update(current) : update
      if (pageKey) host.setPageLocalPages(pageKey, next)
      return next
    })
  }
  const toggleDisclosure = (key: string, defaultOpen: boolean) => {
    setDisclosureOpen((current) => ({
      ...current,
      [key]: !(key in current ? current[key] : defaultOpen),
    }))
  }
  const knownActionIds = collectKnownActionIds(
    actionHostKeys,
    actionHiddenInputs,
    actionChatProtocol,
    uxPlan?.actions
  )
  const headerSortDisabled = collectionHasApiOwnedSort(elements, knownActionIds)
  const elementParents = buildElementParents(elements)
  const discoveryForElement = (elementId: string) =>
    collectLocalDiscoveryQuery({
      formValues,
      elements,
      knownActionIds,
      scopeRootId: discoveryRegionId(elements, elementParents, elementId),
    })
  const localDiscovery = collectLocalDiscoveryQuery({
    formValues,
    elements,
    knownActionIds,
  })
  const discoverySignature = `${localDiscovery.search}\u0000${JSON.stringify(localDiscovery.filters)}`
  const collectionLengthSignature = Object.entries(elements)
    .filter(
      ([, element]) =>
        element.type === 'Table' ||
        element.type === 'Repeat' ||
        element.type === 'Calendar' ||
        element.type === 'Timeline' ||
        element.type === 'Map' ||
        element.type === 'Tree' ||
        element.type === 'Carousel' ||
        element.type === 'Kanban' ||
        element.type === 'Filmstrip' ||
        (element.type === 'List' && Boolean(asString(element.props?.statePath)))
    )
    .map(([id, element]) => {
      const statePath = asString(element.props?.statePath) || implicitDummyTableStatePath(spec, id)
      if (!statePath || statePath === 'item' || statePath.startsWith('item.')) {
        return `${id}:static`
      }
      const raw = collectionFromBoundValue(readStatePath(state, statePath))
      return `${id}:${raw?.length ?? 0}`
    })
    .join('|')
  const pageResetSignature = `${discoverySignature}\u0001${collectionLengthSignature}`
  useEffect(() => {
    setLocalPages({})
  }, [pageResetSignature])
  const selectedIdSet = isTruthyFieldValue(state[ARENA_GENERATIVE_SELECTED_ID_KEY])
  const hideListForSelection =
    selectedIdSet &&
    specHasSamePageSelectItem(spec, currentPath) &&
    !specKeepsCollectionVisible(spec)
  const collectionOnSelect = (elementId: string, statePath: string) => {
    if (!collectionClickPromotesSelection(state, statePath)) return undefined
    const paneId = workspacePaneId(elements, elementParents, elementId)
    if (!paneId) return onSelectItem
    const workspaceId = elementParents.get(paneId)
    const navigatorId = elements[workspaceId ?? '']?.children?.[0]
    if (paneId === navigatorId) return onSelectItem
    return (item: unknown) => {
      const itemId = collectionItemIdentity(item)
      if (!itemId) return
      setRegionSelection((current) => ({
        ...current,
        [paneId]: { id: itemId, item },
      }))
    }
  }
  const applySelectionFilter = (elementId: string, items: unknown[]) => {
    const paneId = workspacePaneId(elements, elementParents, elementId)
    const picked = paneId ? regionSelection[paneId] : undefined
    if (picked) return filterCollectionItemsBySelection(items, picked.id, picked.item)
    if ((paneId || specKeepsCollectionVisible(spec)) && selectedIdSet) {
      return filterCollectionItemsBySelection(
        items,
        state[ARENA_GENERATIVE_SELECTED_ID_KEY],
        state[ARENA_GENERATIVE_SELECTED_KEY]
      )
    }
    return items
  }

  const boundPending = (statePath: string) => {
    if (suppressBoundSkeleton) return false
    return pendingActionIds
      ? isBoundPathPending(statePath, pendingActionIds, actionHostKeys ?? {})
      : pending
  }

  const hideCatalogEmptyWhilePending = (() => {
    if (pending) return true
    for (const element of Object.values(elements)) {
      if (
        element.type !== 'Repeat' &&
        element.type !== 'Table' &&
        element.type !== 'Calendar' &&
        element.type !== 'Timeline' &&
        element.type !== 'Map' &&
        element.type !== 'Tree' &&
        element.type !== 'Carousel' &&
        element.type !== 'Kanban' &&
        element.type !== 'Filmstrip' &&
        !(element.type === 'List' && asString(element.props?.statePath)) &&
        element.type !== 'KeyValue'
      ) {
        continue
      }
      const path = asString(element.props?.statePath)
      if (!path) continue
      if (boundPending(path) && isEmptyStateValue(readStatePath(state, path))) return true
    }
    return false
  })()

  const controlPending = (actionId: string) => {
    if (!UX_DEFAULTS.Button.disabledWhileLoading) return false
    if (uxPlan && actionId && !(actionId in uxPlan.actions)) return false
    return isActionControlPending(actionId, pendingActionIds, pending)
  }

  const loaderPending = (actionId: string) => {
    if (!actionId) return pending
    return isActionControlPending(actionId, pendingActionIds, pending)
  }

  const confirmAction = (actionId: string, fallbackDestructive = false) => {
    if (!actionId) return false
    const plan = uxPlan?.actions[actionId]
    return plan ? plan.confirm : fallbackDestructive
  }

  const confirmMeta = (
    actionId: string,
    fallbackDestructive = false
  ): RunGenerativeAppActionMeta | undefined =>
    confirmAction(actionId, fallbackDestructive) ? { destructive: true } : undefined

  const omitHiddenInputs = (actionId: string, values: Record<string, unknown>) => {
    const hidden = actionHiddenInputs?.[actionId]
    if (!hidden || hidden.length === 0) return values
    const drop = new Set(hidden)
    const next: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(values)) {
      if (!drop.has(key)) next[key] = value
    }
    return next
  }

  const dispatchAction = (
    actionId: string,
    values: Record<string, unknown>,
    meta?: RunGenerativeAppActionMeta
  ) => {
    let next = omitHiddenInputs(actionId, values)
    const protocol = actionChatProtocol?.[actionId]
    if (protocol?.input || protocol?.conversationId) {
      next = {
        ...next,
        conversationId: getGenerativeAppConversationId(conversationStorageKey ?? ''),
      }
    }
    if (meta) return onRunAction(actionId, next, meta)
    return onRunAction(actionId, next)
  }

  const requestNavigate = (target: string, options?: { keepSelection?: boolean }) => {
    const path = splitNavTarget(target).path
    if (currentPath && path === currentPath && selectedIdSet) {
      onClearItem?.()
      return
    }
    if (path !== currentPath && !options?.keepSelection) {
      onClearSelection?.()
    }
    onNavigate(target)
  }

  function pageCollection<T>(
    elementId: string,
    items: readonly T[],
    statePath: string,
    itemScope?: RepeatItemScope
  ): { visible: readonly T[]; chrome: ReactNode } {
    const apiOwned = statePath.length > 0 && collectionUsesApiPagination(statePath, actionHostKeys)
    if (apiOwned || items.length <= LOCAL_COLLECTION_PAGE_SIZE) {
      return { visible: items, chrome: null }
    }
    const key = collectionPageKey(elementId, statePath, itemScope)
    const paged = paginateCollection(items, localPages[key] ?? 1)
    if (specHasPaginationControl(elements, statePath)) {
      return { visible: paged.items, chrome: null }
    }
    return {
      visible: paged.items,
      chrome: (
        <CollectionPageChrome
          paged={paged}
          onPageChange={(page) =>
            setLocalPages((current) => ({
              ...current,
              [key]: page,
            }))
          }
        />
      ),
    }
  }

  const applyCollectionReorder = (
    statePath: string,
    fullItems: readonly unknown[],
    visibleItems: readonly unknown[],
    fromIndex: number,
    toIndex: number
  ) => {
    if (!statePath) return
    const next = spliceVisibleCollectionItems(fullItems, visibleItems, fromIndex, toIndex)
    host.mergeState(hostStatePatchAtPath(state, statePath, next))
  }

  const applyItemField = (
    statePath: string,
    source: readonly unknown[],
    index: number,
    field: string,
    value: string
  ) => {
    if (!statePath) return
    const target = source[index]
    if (!target || typeof target !== 'object' || Array.isArray(target)) return
    const next = source.map((item, itemIndex) =>
      itemIndex === index ? { ...(item as Record<string, unknown>), [field]: value } : item
    )
    host.mergeState(hostStatePatchAtPath(state, statePath, next))
  }

  /**
   * Chrome hoisted out of Section is rendered once at Page, then skipped when
   * the Section walks the same child id.
   */
  const chromeSkipIds = new Set<string>()

  /**
   * `withinForm` tracks whether an ancestor is a `Form`. A `SubmitButton` outside one
   * submits nothing, so it needs its `actionId` wired to a click instead. `formActionId`
   * is the enclosing Form's action so submit and fields pending is per that CTA.
   * `withinCard` skips the host task surface on Form/SearchField already on a Card.
   */
  const renderNode = (
    id: string,
    scope?: RepeatItemScope,
    withinForm = false,
    formActionId = '',
    withinCard = false
  ): ReactNode => {
    if (chromeSkipIds.has(id)) return null
    const element = elements[id]
    if (!element) return null
    const props = interpolateElementProps(element.props ?? {}, { state, scope, pending })
    const childIds = element.children ?? []
    const childWithinForm = withinForm || element.type === 'Form'
    const childWithinCard =
      withinCard ||
      element.type === 'Card' ||
      element.type === 'Stat' ||
      element.type === 'WorkingCard' ||
      element.type === 'EmptyState'
    const nextFormActionId =
      element.type === 'Form'
        ? asString(props.actionId) || submitButtonActionId(elements, childIds)
        : formActionId
    const fieldActionId = asString(props.actionId) || nextFormActionId
    if (
      isFormFieldType(element.type) &&
      asString(props.name) &&
      (actionHiddenInputs?.[fieldActionId] ?? []).includes(asString(props.name))
    ) {
      return null
    }
    const children = childIds.map((childId) => (
      <Fragment key={childId}>
        {renderNode(childId, scope, childWithinForm, nextFormActionId, childWithinCard)}
      </Fragment>
    ))
    const hasChildren = childIds.length > 0
    const fieldBusy = controlPending(formActionId)
    const fieldSnapshot = snapshotFormValues(specFormFields(elements), formValues, state, scope)
    const actionValues = {
      ...paginationActionValues(state),
      ...formValues,
      ...(scope ? repeatItemActionValues(scope.item, scope.index) : {}),
    }
    const visibilityValues = {
      ...state,
      ...formValues,
      ...(scope ? repeatItemActionValues(scope.item, scope.index) : {}),
      ...overlayFlags,
      ...viewSwitchDefaultValues(elements, spec.root, {
        ...state,
        ...formValues,
        ...(scope ? repeatItemActionValues(scope.item, scope.index) : {}),
        ...overlayFlags,
      }),
    }

    const applyOverlayPatch = (patch: Record<string, unknown>) => {
      setOverlayFlags((current) => ({ ...current, ...patch }))
    }

    const setNamedValue = (name: string, value: unknown) => {
      setFormValues((current) => ({ ...current, [name]: value }))
      setFieldErrors((current) => {
        if (!current[name]) return current
        const next = { ...current }
        delete next[name]
        return next
      })
    }

    const renderChildNodes = (ids: string[]) =>
      ids.map((childId) => (
        <Fragment key={childId}>
          {renderNode(childId, scope, childWithinForm, nextFormActionId, childWithinCard)}
        </Fragment>
      ))

    switch (element.type) {
      case 'Page': {
        const hasPageHeader = childIds.some((childId) => elements[childId]?.type === 'PageHeader')
        const title = asString(props.title)
        const chrome = resolvePageChrome(elements, childIds)
        let chromeNode: ReactNode = null
        if (chrome.id) {
          const node = renderNode(chrome.id)
          chromeNode =
            elements[chrome.id]?.type === 'AppHeader' ? node : <AppHeaderBar>{node}</AppHeaderBar>
        }
        if (chrome.id && chrome.nested) chromeSkipIds.add(chrome.id)
        const bodyIds =
          chrome.id && !chrome.nested ? childIds.filter((id) => id !== chrome.id) : childIds
        return (
          <div
            className='relative min-h-full bg-(--gui-canvas,#f7f8f9) text-(length:--gui-body-size,16px) text-(--gui-text,#2c2d33) leading-(--gui-body-leading,24px)'
            style={styleFromProps(props)}
          >
            {chromeNode}
            {title && !hasPageHeader ? <h1 className='sr-only'>{title}</h1> : null}
            {bodyIds.map((childId) => (
              <Fragment key={childId}>{renderNode(childId)}</Fragment>
            ))}
          </div>
        )
      }
      case 'Section': {
        if (!fieldIsVisible(props, visibilityValues)) return null
        return (
          <section
            className={cn(
              'mx-auto flex w-full flex-col gap-(--gui-section-gap,24px) px-6 py-6',
              sectionWidthClass(props.width, sectionIsMeasureOnly(elements, childIds))
            )}
            style={styleFromProps(props)}
          >
            {renderChildNodes(childIds)}
          </section>
        )
      }
      case 'Stack': {
        if (!fieldIsVisible(props, visibilityValues)) return null
        const justify = asString(props.justify, 'start')
        const horizontal = asString(props.direction, 'vertical') === 'horizontal'
        const gapStyle = {
          gap: resolveArenaGenerativeSpacing(asString(props.gap, 'var(--gui-gap, 16px)')),
          ...styleFromProps(props),
        }
        return (
          <div
            className={cn(
              'flex',
              horizontal ? 'flex-row' : 'flex-col',
              alignItemsClass(props.align, 'stretch'),
              justify === 'center' && 'justify-center',
              justify === 'between' && 'justify-between',
              justify === 'end' && 'justify-end',
              asBoolean(props.wrap) && 'flex-wrap'
            )}
            style={gapStyle}
          >
            {renderChildNodes(childIds)}
          </div>
        )
      }
      case 'Grid': {
        if (!fieldIsVisible(props, visibilityValues)) return null
        if (isEqualTwoColFormGrid(withinForm, props)) {
          return (
            <div
              className='grid w-full grid-cols-1 md:grid-cols-2'
              style={{
                gap: resolveArenaGenerativeSpacing(asString(props.gap, 'var(--gui-gap, 16px)')),
                ...styleFromProps(props),
              }}
            >
              {children}
            </div>
          )
        }
        return (
          <div
            className='grid w-full'
            style={{
              gridTemplateColumns: gridTemplateColumns(props),
              gap: resolveArenaGenerativeSpacing(asString(props.gap, 'var(--gui-gap, 16px)')),
              ...styleFromProps(props),
            }}
          >
            {children}
          </div>
        )
      }
      case 'Repeat': {
        if (!fieldIsVisible(props, visibilityValues)) return null
        if (hideListForSelection) return null
        const statePath = asString(props.statePath)
        const stateValue = statePath ? readStatePath(state, statePath, scope) : undefined
        const rawItems = collectionFromBoundValue(stateValue)
        const discovered = filterCollectionItems(rawItems ?? [], discoveryForElement(id))
        const items =
          applySelectionFilter(id, discovered)
        if (
          statePath &&
          boundPending(statePath) &&
          isEmptyStateValue(stateValue) &&
          (!rawItems || rawItems.length === 0)
        ) {
          const skeletonCount = repeatSkeletonCount(elements, id)
          return (
            <>
              {Array.from({ length: skeletonCount }, (_, index) => (
                <SkeletonBlock
                  key={`repeat-skeleton-${index}`}
                  variant='card'
                  lines={DEFAULT_SKELETON_LINES.card}
                />
              ))}
            </>
          )
        }
        if (!rawItems || rawItems.length === 0) {
          if (!statePath) return null
          return <EmptyState text={asString(props.emptyText, DEFAULT_EMPTY_TEXT.collection)} />
        }
        if (items.length === 0) {
          return <EmptyState text={asString(props.emptyText, DEFAULT_EMPTY_TEXT.collection)} />
        }
        const { visible: visibleItems, chrome } = pageCollection(id, items, statePath, scope)
        const refetching = Boolean(statePath && boundPending(statePath))
        const canReorder =
          asBoolean(props.reorderable) &&
          Boolean(statePath) &&
          !collectionUsesApiPagination(statePath, actionHostKeys)
        return (
          <>
            <RefetchBusyChrome busy={refetching} />
            <div className='contents' aria-busy={refetching || undefined}>
              {visibleItems.map((item, index) =>
                canReorder ? (
                  <div
                    key={repeatItemKey(item, index)}
                    className='relative'
                    draggable
                    onDragStart={(event) => {
                      event.dataTransfer.setData('text/plain', String(index))
                      event.dataTransfer.effectAllowed = 'move'
                    }}
                    onDragOver={(event) => event.preventDefault()}
                    onDrop={(event) => {
                      event.preventDefault()
                      const from = Number(event.dataTransfer.getData('text/plain'))
                      if (!Number.isInteger(from)) return
                      applyCollectionReorder(statePath, items, visibleItems, from, index)
                    }}
                    onKeyDown={(event) => {
                      if (!event.altKey) return
                      if (event.key === 'ArrowUp') {
                        event.preventDefault()
                        applyCollectionReorder(
                          statePath,
                          items,
                          visibleItems,
                          index,
                          Math.max(0, index - 1)
                        )
                      }
                      if (event.key === 'ArrowDown') {
                        event.preventDefault()
                        applyCollectionReorder(
                          statePath,
                          items,
                          visibleItems,
                          index,
                          Math.min(visibleItems.length - 1, index + 1)
                        )
                      }
                    }}
                  >
                    <span
                      aria-pressed={false}
                      className='absolute top-3 left-2 z-10 text-(--gui-text-tertiary,#8a8d99)'
                    >
                      <GripVertical className='size-[14px]' />
                    </span>
                    {childIds.map((childId) => (
                      <Fragment key={childId}>
                        {renderNode(
                          childId,
                          { item, index },
                          childWithinForm,
                          nextFormActionId,
                          childWithinCard
                        )}
                      </Fragment>
                    ))}
                  </div>
                ) : (
                  <Fragment key={repeatItemKey(item, index)}>
                    {childIds.map((childId) => (
                      <Fragment key={childId}>
                        {renderNode(
                          childId,
                          { item, index },
                          childWithinForm,
                          nextFormActionId,
                          childWithinCard
                        )}
                      </Fragment>
                    ))}
                  </Fragment>
                )
              )}
            </div>
            {chrome}
          </>
        )
      }
      case 'Columns': {
        const layout = asString(props.layout, 'equal')
        const singleChild = hasSingleVisibleLayoutChild(elements, childIds, visibilityValues)
        return (
          <div
            className={cn(
              'grid w-full grid-cols-1',
              !singleChild && layout === 'sidebar-left' && 'md:grid-cols-[280px_1fr]',
              !singleChild && layout === 'sidebar-right' && 'md:grid-cols-[1fr_280px]',
              !singleChild && layout === 'equal' && 'md:grid-cols-2'
            )}
            style={{
              gap: resolveArenaGenerativeSpacing(asString(props.gap, 'var(--gui-gap, 16px)')),
              ...styleFromProps(props),
            }}
          >
            {children}
          </div>
        )
      }
      case 'Workspace': {
        const inspectorWhen = asString(props.inspectorWhen)
        const showInspector =
          !inspectorWhen || fieldIsVisible({ showWhen: inspectorWhen }, visibilityValues)
        return (
          <WorkspaceView
            showInspector={showInspector}
            style={{
              gap: resolveArenaGenerativeSpacing(asString(props.gap, 'var(--gui-gap, 16px)')),
              ...styleFromProps(props),
            }}
          >
            {children}
          </WorkspaceView>
        )
      }
      case 'AppHeader': {
        const title = asString(props.title)
        return (
          <header
            data-testid='app-header'
            className={APP_HEADER_BAR_CLASS}
            style={styleFromProps(props)}
          >
            <div className='flex w-full items-center justify-between gap-3 px-4 py-3'>
              <div className='flex min-w-0 items-center gap-2.5'>
                <ArenaAppHeaderLogo />
                {title ? (
                  <p className='truncate font-semibold text-(length:--gui-body-size,16px) text-(--gui-text,#2c2d33) leading-(--gui-body-leading,24px)'>
                    {title}
                  </p>
                ) : null}
              </div>
              {hasChildren ? (
                <div className='flex shrink-0 items-center gap-2'>{children}</div>
              ) : null}
            </div>
          </header>
        )
      }
      case 'PageHeader': {
        const align = asString(props.align, 'start')
        const kicker = asString(props.kicker)
        const subtitle = asString(props.subtitle)
        const isCenter = align === 'center'
        const title = (
          <h1
            className={cn(
              'font-semibold text-(--gui-text,#2c2d33) tracking-tight',
              'text-(length:--gui-display-size,40px) leading-(--gui-display-leading,48px)'
            )}
          >
            {asString(props.title)}
          </h1>
        )
        const copy = (
          <div
            className={cn(
              'flex min-w-0 flex-col gap-2',
              isCenter && 'mx-auto items-center text-center'
            )}
          >
            {kicker ? (
              <p className='font-medium text-(length:--gui-label-size,12px) text-(--gui-brand,#1a73e8)'>
                {kicker}
              </p>
            ) : null}
            {title}
            {subtitle ? (
              <p
                className={cn(
                  'max-w-(--gui-measure,40rem) text-(length:--gui-body-size,16px) text-(--gui-text-muted,#575a66) leading-normal',
                  isCenter && 'mx-auto'
                )}
              >
                {subtitle}
              </p>
            ) : null}
          </div>
        )
        if (isCenter) {
          return (
            <div className='relative w-full pb-1' style={styleFromProps(props)}>
              {hasChildren ? (
                <div className='absolute top-0 right-0 flex items-center gap-2'>{children}</div>
              ) : null}
              {copy}
            </div>
          )
        }
        return (
          <div
            className='flex w-full flex-wrap items-end justify-between gap-4 pb-1'
            style={styleFromProps(props)}
          >
            {copy}
            {hasChildren ? <div className='flex items-center gap-2'>{children}</div> : null}
          </div>
        )
      }
      case 'Toolbar': {
        const justify = asString(props.justify, 'start')
        return (
          <div
            className={cn(
              'flex w-full flex-wrap items-center gap-2',
              justify === 'center' && 'justify-center',
              justify === 'between' && 'justify-between',
              justify === 'end' && 'justify-end'
            )}
            style={styleFromProps(props)}
          >
            {children}
          </div>
        )
      }
      case 'Filter': {
        if (!fieldIsVisible(props, visibilityValues)) return null
        const justify = asString(props.justify, 'start')
        return (
          <div
            data-testid='filter'
            className={cn(
              'flex w-full flex-wrap items-center gap-2',
              justify === 'center' && 'justify-center',
              justify === 'between' && 'justify-between',
              justify === 'end' && 'justify-end'
            )}
            style={styleFromProps(props)}
          >
            {children}
          </div>
        )
      }
      case 'Tabs': {
        const items = parseTabItems(props.items)
        if (items.length === 0) return null
        return (
          <CatalogTabs
            items={items}
            activePath={asString(props.activePath)}
            currentPath={currentPath}
            onNavigate={requestNavigate}
            style={styleFromProps(props)}
          />
        )
      }
      case 'Stepper': {
        const items = parseTabItems(props.items)
        if (items.length === 0) return null
        return (
          <CatalogStepper
            items={items}
            activePath={asString(props.activePath)}
            currentPath={currentPath}
            onNavigate={requestNavigate}
            style={styleFromProps(props)}
          />
        )
      }
      case 'Breadcrumb': {
        const items = parseBreadcrumbItems(props.items)
        if (items.length === 0) return null
        return (
          <GuiHostBreadcrumb items={items} currentPath={currentPath} onNavigate={requestNavigate} />
        )
      }
      case 'Table': {
        const statePath = asString(props.statePath) || implicitDummyTableStatePath(spec, id)
        const stateValue = statePath ? readStatePath(state, statePath, scope) : undefined
        const rawCollection = collectionFromBoundValue(stateValue)
        const proseTable = rawCollection ? undefined : parseProseTable(stateValue)
        if (typeof stateValue === 'string' && !rawCollection && !proseTable && statePath) {
          if (boundPending(statePath) && isEmptyStateValue(stateValue)) {
            return <SkeletonBlock variant='table' lines={DEFAULT_SKELETON_LINES.table} />
          }
          return (
            <DataTextView
              value={stateValue}
              fallback={asString(props.emptyText, DEFAULT_EMPTY_TEXT.collection)}
              pending={boundPending(statePath)}
              style={styleFromProps(props)}
            />
          )
        }
        const sourceCollection = rawCollection ?? proseTable?.records
        const discoveredCollection = sourceCollection
          ? filterCollectionItems(sourceCollection, discoveryForElement(id))
          : undefined
        const filteredCollection = discoveredCollection
          ? applySelectionFilter(id, discoveredCollection)
          : discoveredCollection
        const tableSort = tableSorts[id]
        const collection = filteredCollection
          ? sortCollectionItems(filteredCollection, tableSort)
          : undefined
        const boundEmpty = Boolean(
          statePath &&
            (sourceCollection ? sourceCollection.length === 0 : isEmptyStateValue(stateValue))
        )
        if (statePath && boundPending(statePath) && boundEmpty) {
          return <SkeletonBlock variant='table' lines={DEFAULT_SKELETON_LINES.table} />
        }
        if (statePath && !boundPending(statePath) && boundEmpty) {
          const hasStatic =
            asString(props.columns).trim().length > 0 || asString(props.rows).trim().length > 0
          if (stateValue !== undefined || !hasStatic) {
            return <EmptyState text={asString(props.emptyText, DEFAULT_EMPTY_TEXT.collection)} />
          }
        }
        if (
          sourceCollection &&
          sourceCollection.length > 0 &&
          collection &&
          collection.length === 0
        ) {
          return <EmptyState text={asString(props.emptyText, DEFAULT_EMPTY_TEXT.collection)} />
        }
        const canReorder =
          asBoolean(props.reorderable) &&
          Boolean(statePath) &&
          !collectionUsesApiPagination(statePath, actionHostKeys)
        const headerSortable = !headerSortDisabled
        const selectRow = collectionOnSelect(id, statePath)
        const rowActions =
          childIds.length > 0
            ? (item: unknown, index: number) => (
                <div className='flex flex-wrap items-center gap-2'>
                  {childIds.map((childId) => (
                    <Fragment key={childId}>
                      {renderNode(
                        childId,
                        { item, index },
                        childWithinForm,
                        nextFormActionId,
                        childWithinCard
                      )}
                    </Fragment>
                  ))}
                </div>
              )
            : undefined
        if (collection && collection.length > 0) {
          const { visible, chrome } = pageCollection(id, collection, statePath, scope)
          return (
            <div className='flex w-full flex-col'>
              <StateTable
                value={visible}
                columns={asString(props.columns) || proseTable?.headers.join(',')}
                style={styleFromProps(props)}
                busy={Boolean(statePath && boundPending(statePath))}
                sort={tableSort}
                sortable={headerSortable}
                onSort={(key) =>
                  setTableSorts((current) => ({
                    ...current,
                    [id]: nextTableSort(current[id], key),
                  }))
                }
                footerItems={collection}
                nowMs={nowMs}
                reorderable={canReorder}
                onReorder={(from, to) =>
                  applyCollectionReorder(statePath, collection, visible, from, to)
                }
                onSelectRow={selectRow}
                renderRowActions={rowActions}
              />
              {chrome}
            </div>
          )
        }
        if (stateValue === undefined) {
          const headers = asString(props.columns)
            .split(',')
            .map((header) => header.trim())
            .filter(Boolean)
          const discoveredRows = filterStaticTableRows(
            headers,
            asString(props.rows)
              .split('\n')
              .map((row) => row.trim())
              .filter(Boolean)
              .map(splitTableRow),
            discoveryForElement(id)
          )
          const panePick = regionSelection[workspacePaneId(elements, elementParents, id) ?? '']
          const selectedRows =
            panePick
              ? filterStaticTableRowsBySelection(
                  headers,
                  discoveredRows,
                  panePick.id,
                  panePick.item
                )
              : specKeepsCollectionVisible(spec) && selectedIdSet
              ? filterStaticTableRowsBySelection(
                  headers,
                  discoveredRows,
                  state[ARENA_GENERATIVE_SELECTED_ID_KEY],
                  state[ARENA_GENERATIVE_SELECTED_KEY]
                )
              : discoveredRows
          const rows = sortStaticTableRows(headers, selectedRows, tableSort)
          if (headers.length === 0 && rows.length === 0) return null
          if (rows.length === 0) {
            return <EmptyState text={asString(props.emptyText, DEFAULT_EMPTY_TEXT.collection)} />
          }
          const records = rows.map((row) => {
            const record: Record<string, unknown> = {}
            headers.forEach((header, index) => {
              record[parseBoundTableColumns(header)[0]?.key ?? header] = row[index]
            })
            return record
          })
          const { visible, chrome } = pageCollection(id, records, '', scope)
          return (
            <div className='flex w-full flex-col'>
              <StateTable
                value={visible}
                columns={asString(props.columns)}
                style={styleFromProps(props)}
                sort={tableSort}
                sortable={headerSortable}
                onSort={(key) =>
                  setTableSorts((current) => ({
                    ...current,
                    [id]: nextTableSort(current[id], key),
                  }))
                }
                footerItems={records}
                nowMs={nowMs}
                onSelectRow={selectRow}
                renderRowActions={rowActions}
              />
              {chrome}
            </div>
          )
        }
        return (
          <StateTable
            value={stateValue}
            columns={asString(props.columns)}
            style={styleFromProps(props)}
            busy={Boolean(statePath && boundPending(statePath))}
            nowMs={nowMs}
          />
        )
      }
      case 'Calendar': {
        if (!fieldIsVisible(props, visibilityValues)) return null
        const statePath = asString(props.statePath)
        const stateValue = statePath ? readStatePath(state, statePath, scope) : undefined
        const rawItems = collectionFromBoundValue(stateValue)
        const discovered = filterCollectionItems(rawItems ?? [], discoveryForElement(id))
        const items =
          applySelectionFilter(id, discovered)
        if (
          statePath &&
          boundPending(statePath) &&
          isEmptyStateValue(stateValue) &&
          (!rawItems || rawItems.length === 0)
        ) {
          return <SkeletonBlock variant='table' lines={DEFAULT_SKELETON_LINES.table} />
        }
        if (!rawItems || rawItems.length === 0) {
          return <EmptyState text={asString(props.emptyText, DEFAULT_EMPTY_TEXT.collection)} />
        }
        const viewProp = asString(props.view)
        const view = viewProp === 'week' || viewProp === 'month' ? viewProp : undefined
        return (
          <GuiHostCalendar
            items={items}
            dateField={asString(props.dateField) || undefined}
            titleField={asString(props.titleField) || undefined}
            view={view}
            emptyText={asString(props.emptyText, DEFAULT_EMPTY_TEXT.collection)}
            busy={Boolean(statePath && boundPending(statePath))}
            allowViewToggle={!view}
            onSelectItem={collectionOnSelect(id, statePath)}
          />
        )
      }
      case 'Timeline': {
        if (!fieldIsVisible(props, visibilityValues)) return null
        const statePath = asString(props.statePath)
        const stateValue = statePath ? readStatePath(state, statePath, scope) : undefined
        const rawItems = collectionFromBoundValue(stateValue)
        const discovered = filterCollectionItems(rawItems ?? [], discoveryForElement(id))
        const items =
          applySelectionFilter(id, discovered)
        if (
          statePath &&
          boundPending(statePath) &&
          isEmptyStateValue(stateValue) &&
          (!rawItems || rawItems.length === 0)
        ) {
          return <SkeletonBlock variant='card' lines={DEFAULT_SKELETON_LINES.card} />
        }
        if (!rawItems || rawItems.length === 0) {
          return <EmptyState text={asString(props.emptyText, DEFAULT_EMPTY_TEXT.collection)} />
        }
        return (
          <GuiHostTimeline
            items={items}
            dateField={asString(props.dateField) || undefined}
            titleField={asString(props.titleField) || undefined}
            emptyText={asString(props.emptyText, DEFAULT_EMPTY_TEXT.collection)}
            busy={Boolean(statePath && boundPending(statePath))}
            onSelectItem={collectionOnSelect(id, statePath)}
          />
        )
      }
      case 'Map': {
        if (!fieldIsVisible(props, visibilityValues)) return null
        const statePath = asString(props.statePath)
        const stateValue = statePath ? readStatePath(state, statePath, scope) : undefined
        const rawItems = collectionFromBoundValue(stateValue)
        const discovered = filterCollectionItems(rawItems ?? [], discoveryForElement(id))
        const items =
          applySelectionFilter(id, discovered)
        if (
          statePath &&
          boundPending(statePath) &&
          isEmptyStateValue(stateValue) &&
          (!rawItems || rawItems.length === 0)
        ) {
          return <SkeletonBlock variant='card' lines={DEFAULT_SKELETON_LINES.card} />
        }
        if (!rawItems || rawItems.length === 0) {
          return <EmptyState text={asString(props.emptyText, DEFAULT_EMPTY_TEXT.collection)} />
        }
        return (
          <GuiHostMap
            items={items}
            latField={asString(props.latField) || undefined}
            lngField={asString(props.lngField) || undefined}
            titleField={asString(props.titleField) || undefined}
            emptyText={asString(props.emptyText, DEFAULT_EMPTY_TEXT.collection)}
            busy={Boolean(statePath && boundPending(statePath))}
            onSelectItem={collectionOnSelect(id, statePath)}
          />
        )
      }
      case 'Tree': {
        if (!fieldIsVisible(props, visibilityValues)) return null
        const statePath = asString(props.statePath)
        const stateValue = statePath ? readStatePath(state, statePath, scope) : undefined
        const rawItems = collectionFromBoundValue(stateValue)
        const discovered = filterCollectionItems(rawItems ?? [], discoveryForElement(id))
        const items =
          applySelectionFilter(id, discovered)
        if (
          statePath &&
          boundPending(statePath) &&
          isEmptyStateValue(stateValue) &&
          (!rawItems || rawItems.length === 0)
        ) {
          return <SkeletonBlock variant='card' lines={DEFAULT_SKELETON_LINES.card} />
        }
        if (!rawItems || rawItems.length === 0) {
          return <EmptyState text={asString(props.emptyText, DEFAULT_EMPTY_TEXT.collection)} />
        }
        return (
          <GuiHostTree
            items={items}
            childrenField={asString(props.childrenField) || undefined}
            titleField={asString(props.titleField) || undefined}
            emptyText={asString(props.emptyText, DEFAULT_EMPTY_TEXT.collection)}
            busy={Boolean(statePath && boundPending(statePath))}
            onSelectItem={collectionOnSelect(id, statePath)}
          />
        )
      }
      case 'Carousel': {
        if (!fieldIsVisible(props, visibilityValues)) return null
        const statePath = asString(props.statePath)
        const stateValue = statePath ? readStatePath(state, statePath, scope) : undefined
        const rawItems = collectionFromBoundValue(stateValue)
        const discovered = filterCollectionItems(rawItems ?? [], discoveryForElement(id))
        const items =
          applySelectionFilter(id, discovered)
        if (
          statePath &&
          boundPending(statePath) &&
          isEmptyStateValue(stateValue) &&
          (!rawItems || rawItems.length === 0)
        ) {
          return <SkeletonBlock variant='card' lines={DEFAULT_SKELETON_LINES.card} />
        }
        const boundItems = rawItems && rawItems.length > 0 ? items : []
        if (boundItems.length === 0 && !hasChildren) {
          return <EmptyState text={asString(props.emptyText, DEFAULT_EMPTY_TEXT.collection)} />
        }
        return (
          <GuiHostCarousel
            items={boundItems}
            srcField={asString(props.srcField) || undefined}
            titleField={asString(props.titleField) || undefined}
            emptyText={asString(props.emptyText, DEFAULT_EMPTY_TEXT.collection)}
            busy={Boolean(statePath && boundPending(statePath))}
            onSelectItem={collectionOnSelect(id, statePath)}
          >
            {boundItems.length === 0 ? children : null}
          </GuiHostCarousel>
        )
      }
      case 'Kanban': {
        if (!fieldIsVisible(props, visibilityValues)) return null
        const statePath = asString(props.statePath)
        const stateValue = statePath ? readStatePath(state, statePath, scope) : undefined
        const rawItems = collectionFromBoundValue(stateValue)
        const discovered = filterCollectionItems(rawItems ?? [], discoveryForElement(id))
        const items =
          applySelectionFilter(id, discovered)
        if (
          statePath &&
          boundPending(statePath) &&
          isEmptyStateValue(stateValue) &&
          (!rawItems || rawItems.length === 0)
        ) {
          return <SkeletonBlock variant='card' lines={DEFAULT_SKELETON_LINES.card} />
        }
        if (!rawItems || rawItems.length === 0) {
          return <EmptyState text={asString(props.emptyText, DEFAULT_EMPTY_TEXT.collection)} />
        }
        return (
          <GuiHostKanban
            items={items}
            groupField={asString(props.groupField) || undefined}
            titleField={asString(props.titleField) || undefined}
            columns={asString(props.columns) || undefined}
            emptyText={asString(props.emptyText, DEFAULT_EMPTY_TEXT.collection)}
            busy={Boolean(statePath && boundPending(statePath))}
            onSelectItem={collectionOnSelect(id, statePath)}
            onMoveCard={
              statePath && !collectionUsesApiPagination(statePath, actionHostKeys)
                ? (index, columnId, groupField) => {
                    const source = rawItems ?? items
                    const moved = items[index]
                    const sourceIndex = source.indexOf(moved)
                    applyItemField(
                      statePath,
                      source,
                      sourceIndex >= 0 ? sourceIndex : index,
                      groupField,
                      columnId
                    )
                  }
                : undefined
            }
          />
        )
      }
      case 'Filmstrip': {
        if (!fieldIsVisible(props, visibilityValues)) return null
        const statePath = asString(props.statePath)
        const stateValue = statePath ? readStatePath(state, statePath, scope) : undefined
        const rawItems = collectionFromBoundValue(stateValue)
        const discovered = filterCollectionItems(rawItems ?? [], discoveryForElement(id))
        const items =
          applySelectionFilter(id, discovered)
        if (
          statePath &&
          boundPending(statePath) &&
          isEmptyStateValue(stateValue) &&
          (!rawItems || rawItems.length === 0)
        ) {
          return <SkeletonBlock variant='card' lines={DEFAULT_SKELETON_LINES.card} />
        }
        if (!rawItems || rawItems.length === 0) {
          return <EmptyState text={asString(props.emptyText, DEFAULT_EMPTY_TEXT.collection)} />
        }
        return (
          <GuiHostFilmstrip
            items={items}
            titleField={asString(props.titleField) || undefined}
            subtitleField={asString(props.subtitleField) || undefined}
            emptyText={asString(props.emptyText, DEFAULT_EMPTY_TEXT.collection)}
            busy={Boolean(statePath && boundPending(statePath))}
            onSelectItem={collectionOnSelect(id, statePath)}
          />
        )
      }
      case 'Pagination': {
        if (!fieldIsVisible(props, visibilityValues)) return null
        const actionId = asString(props.actionId)
        const statePath = asString(props.statePath)
        const mode = parsePaginationMode(props.mode, actionId ? 'more' : 'pages')
        if (actionId) {
          return (
            <GuiHostPagination
              mode={mode === 'pages' ? 'more' : mode}
              hasMore={isTruthyFieldValue(state.hasMore)}
              pending={controlPending(actionId)}
              onLoadMore={() => void dispatchAction(actionId, actionValues, confirmMeta(actionId))}
            />
          )
        }
        if (!statePath) return null
        const stateValue = readStatePath(state, statePath, scope)
        const rawItems = collectionFromBoundValue(stateValue) ?? []
        const discovered = filterCollectionItems(rawItems, discoveryForElement(id))
        const items =
          applySelectionFilter(id, discovered)
        const key = collectionPageKey(id, statePath, scope)
        const paged = paginateCollection(items, localPages[key] ?? 1)
        return (
          <GuiHostPagination
            mode='pages'
            paged={paged}
            onPageChange={(page) =>
              setLocalPages((current) => ({
                ...current,
                [key]: page,
              }))
            }
          />
        )
      }
      case 'Stat': {
        const statePath = asString(props.statePath)
        const stateValue = statePath ? readStatePath(state, statePath, scope) : undefined
        if (
          statePath &&
          boundPending(statePath) &&
          isEmptyStateValue(stateValue) &&
          !asString(props.value)
        ) {
          return <SkeletonBlock variant='stat' lines={DEFAULT_SKELETON_LINES.stat} />
        }
        const aggregate = parseStatAggregate(asString(props.aggregate))
        const collection = collectionFromBoundValue(stateValue)
        const aggregated =
          aggregate && collection ? aggregateStatCollection(collection, aggregate) : undefined
        const displaySource = aggregated !== undefined ? aggregated : stateValue
        const value =
          displaySource === undefined
            ? asString(props.value)
            : displayFromStateValue(
                displaySource,
                asString(props.value),
                asString(props.numberFormat) ||
                  asString(props.dateFormat) ||
                  statDefaultNumberFormat(displaySource),
                nowMs
              )
        const delta = asString(props.delta)
        const isDisplay = asString(props.size) === 'display'
        const refetching =
          Boolean(statePath) && boundPending(statePath) && !isEmptyStateValue(stateValue)
        return (
          <div
            aria-busy={refetching || undefined}
            className={cn('flex flex-col gap-2', SURFACE_STAT, refetching && 'opacity-70')}
            style={styleFromProps(props)}
          >
            <RefetchBusyChrome busy={refetching} />
            <span className='font-medium text-(length:--gui-label-size,12px) text-(--gui-text-muted,#575a66) uppercase tracking-[0.25px]'>
              {asString(props.label)}
            </span>
            <div className='flex flex-wrap items-baseline gap-2'>
              <span
                className={cn(
                  'font-semibold text-(--gui-text,#2c2d33)',
                  isDisplay
                    ? 'text-(length:--gui-stat-size,40px) leading-(--gui-stat-leading,48px)'
                    : 'text-(length:--gui-title-size,24px) leading-(--gui-title-leading,32px)'
                )}
              >
                {value}
              </span>
              {delta ? (
                <span className={cn('font-medium text-sm', deltaToneClass(props.deltaTone))}>
                  {delta}
                </span>
              ) : null}
            </div>
            {asString(props.hint) ? (
              <span className='text-(length:--gui-caption-size,12px) text-(--gui-text-muted,#575a66) leading-(--gui-caption-leading,20px)'>
                {asString(props.hint)}
              </span>
            ) : null}
          </div>
        )
      }
      case 'Sparkline': {
        const series = numbersFromSparklineProps(props, state, scope)
        const statePath = asString(props.statePath)
        if (statePath && boundPending(statePath) && series.length === 0) {
          return <SkeletonBlock variant='stat' lines={1} />
        }
        const points = sparklinePoints(series)
        const label = asString(props.label)
        const sparklineBusy = Boolean(statePath && boundPending(statePath) && series.length > 0)
        return (
          <div
            aria-busy={sparklineBusy || undefined}
            className={cn('flex w-full flex-col gap-2', sparklineBusy && 'opacity-70')}
            data-testid='sparkline'
            style={styleFromProps(props)}
          >
            <RefetchBusyChrome busy={sparklineBusy} />
            {label ? (
              <span className='font-medium text-(length:--gui-label-size,12px) text-(--gui-text-muted,#575a66)'>
                {label}
              </span>
            ) : null}
            <svg
              viewBox='0 0 100 100'
              preserveAspectRatio='none'
              className='h-10 w-full'
              aria-hidden={label ? undefined : true}
              role={label ? 'img' : undefined}
            >
              {label ? <title>{label}</title> : null}
              {points ? (
                <polyline
                  fill='none'
                  stroke='var(--gui-brand, #1a73e8)'
                  strokeWidth='2'
                  strokeLinejoin='round'
                  strokeLinecap='round'
                  points={points}
                  vectorEffect='non-scaling-stroke'
                />
              ) : null}
            </svg>
          </div>
        )
      }
      case 'Chart': {
        const statePath = asString(props.statePath)
        const bound = bindChartData(props, state, scope)
        if (statePath && boundPending(statePath) && !bound.dsl) {
          return <SkeletonBlock variant='card' lines={4} />
        }
        if (!bound.dsl) {
          return <EmptyState text={bound.emptyText} />
        }
        const chartBusy = Boolean(statePath && boundPending(statePath))
        return (
          <div
            aria-busy={chartBusy || undefined}
            className={cn('w-full', chartBusy && 'opacity-70')}
            style={styleFromProps(props)}
          >
            <RefetchBusyChrome busy={chartBusy} />
            <ConstrainedChart dsl={bound.dsl} height={bound.height} />
          </div>
        )
      }
      case 'EmptyState':
        if (hideCatalogEmptyWhilePending) return null
        return (
          <div
            data-testid='empty-state'
            className='flex w-full max-w-(--gui-measure,40rem) flex-col items-start gap-3 py-6'
            style={styleFromProps(props)}
          >
            {asString(props.icon) ? (
              <CatalogIcon name={asString(props.icon)} well='circle' />
            ) : (
              <CatalogIcon name='inbox' well='circle' />
            )}
            <p className='font-semibold text-(length:--gui-title-size,24px) text-(--gui-text,#2c2d33) leading-(--gui-title-leading,32px)'>
              {asString(props.title)}
            </p>
            {asString(props.body) ? (
              <p className='text-(length:--gui-body-size,16px) text-(--gui-text-muted,#575a66)'>
                {asString(props.body)}
              </p>
            ) : null}
            {hasChildren ? <div className='mt-1'>{children}</div> : null}
          </div>
        )
      case 'Badge':
        return (
          <span
            className={cn(
              'inline-flex items-center rounded-(--gui-radius-pill) px-2 py-0.5 font-medium text-xs',
              toneClass(props.tone)
            )}
            style={styleFromProps(props)}
          >
            {asString(props.text)}
          </span>
        )
      case 'Chip': {
        const text = asString(props.text)
        const actionId = asString(props.actionId)
        const navigateTo = asString(props.navigateTo)
        const setValue = asString(props.setValue)
        const hostExport = resolveHostContentAction(props)
        const viewTone = setValue ? viewSwitchChipTone(id, setValue, visibilityValues, spec) : null
        const tone = viewTone ?? asString(props.tone, 'muted')
        const interactive = Boolean(actionId || navigateTo || setValue || hostExport)
        const className = cn(
          GUI_CHIP_CLASS,
          CHIP_TONE_CLASSES[tone as keyof typeof CHIP_TONE_CLASSES] ?? CHIP_TONE_CLASSES.muted
        )
        const runChip = () => {
          if (hostExport) {
            const markdown = visibleMarkdownForElement(elements, id, state, visibilityValues, scope)
            if (hostExport === 'copy') void copyTextToClipboard(markdown)
            else downloadMarkdownPdf(markdown)
            return
          }
          if (actionId && confirmAction(actionId)) {
            void dispatchAction(actionId, actionValues, confirmMeta(actionId))
            return
          }
          if (setValue) {
            const parsed = parseChipSetValue(setValue)
            setNamedValue(parsed.name || firstSearchFieldName(elements), parsed.value)
          }
          if (navigateTo) requestNavigate(navigateTo)
          if (actionId) void dispatchAction(actionId, actionValues)
        }
        const chipBusy = Boolean(actionId) && controlPending(actionId)
        if (!interactive) {
          return (
            <span className={className} style={styleFromProps(props)}>
              {text}
            </span>
          )
        }
        return (
          <button
            type='button'
            disabled={chipBusy}
            aria-busy={chipBusy || undefined}
            aria-pressed={viewTone ? viewTone === 'brand' : undefined}
            className={cn(className, chipBusy && 'gap-2')}
            style={styleFromProps(props)}
            data-testid={
              hostExport === 'copy'
                ? 'host-copy-markdown'
                : hostExport === 'downloadPdf'
                  ? 'host-download-pdf'
                  : undefined
            }
            onClick={runChip}
          >
            <ActionBusyMark show={chipBusy} />
            {text}
          </button>
        )
      }
      case 'Icon': {
        const bound = asString(props.statePath)
          ? readStatePath(state, asString(props.statePath), scope)
          : undefined
        return (
          <CatalogIcon
            name={resolveCatalogIconName({ name: asString(props.name), bound })}
            well={asString(props.well, 'circle')}
          />
        )
      }
      case 'Avatar':
        return <AvatarView {...avatarModel(props, state, scope)} />
      case 'EntityHeader': {
        const avatar = avatarModel(props, state, scope)
        const meta = parseOptionList(props.meta)
        return (
          <div
            data-testid='entity-header'
            className='flex w-full flex-col gap-3'
            style={styleFromProps(props)}
          >
            <div className='flex items-start gap-4'>
              <AvatarView {...avatar} />
              <div className='flex min-w-0 flex-1 flex-col gap-2'>
                <div className='flex flex-wrap items-center gap-2'>
                  <h2 className='font-semibold text-(length:--gui-title-size,24px) text-(--gui-text,#2c2d33) leading-(--gui-title-leading,32px)'>
                    {asString(props.title)}
                  </h2>
                  {asString(props.badge) ? (
                    <span
                      className={cn(
                        'inline-flex items-center rounded-(--gui-radius-pill) px-2 py-0.5 font-medium text-xs',
                        toneClass(props.badgeTone)
                      )}
                    >
                      {asString(props.badge)}
                    </span>
                  ) : null}
                </div>
                {asString(props.description) ? (
                  <p className='max-w-(--gui-measure,40rem) text-(length:--gui-body-size,16px) text-(--gui-text-muted,#575a66) leading-normal'>
                    {asString(props.description)}
                  </p>
                ) : null}
                {meta.length > 0 ? (
                  <div className='flex flex-wrap gap-2'>
                    {meta.map((item) => (
                      <span
                        key={item}
                        className={cn(
                          'inline-flex items-center rounded-(--gui-radius-pill) px-3 py-1 font-medium text-sm',
                          CHIP_TONE_CLASSES.muted
                        )}
                      >
                        {item}
                      </span>
                    ))}
                  </div>
                ) : null}
                {hasChildren ? (
                  <div className='flex flex-wrap items-center gap-3'>{children}</div>
                ) : null}
              </div>
            </div>
          </div>
        )
      }
      case 'KeyValue': {
        const statePath = asString(props.statePath)
        const stateValue = statePath ? readStatePath(state, statePath, scope) : undefined
        const pairs = keyValueEntries(props.items, stateValue)
        if (pairs.length === 0 && statePath && boundPending(statePath)) {
          return <SkeletonBlock variant='text' lines={DEFAULT_SKELETON_LINES.text} />
        }
        if (pairs.length === 0 && statePath && !boundPending(statePath)) {
          return <EmptyState text={asString(props.emptyText, DEFAULT_EMPTY_TEXT.details)} />
        }
        const kvBusy = Boolean(statePath && boundPending(statePath) && pairs.length > 0)
        return (
          <div className={cn(kvBusy && 'opacity-70')}>
            <RefetchBusyChrome busy={kvBusy} />
            <StateKeyValue pairs={pairs} busy={Boolean(statePath && boundPending(statePath))} />
          </div>
        )
      }
      case 'Disclosure': {
        if (!fieldIsVisible(props, visibilityValues)) return null
        const title = asString(props.title)
        const subtitle = asString(props.subtitle)
        const defaultOpen =
          asBoolean(props.defaultOpen) || !UX_DEFAULTS.Disclosure.collapsedByDefault
        const rowKey = disclosureInstanceKey(id, scope)
        const open = disclosureIsOpen(rowKey, defaultOpen, disclosureOpen)
        const bodyIds = childIds.filter((childId) => elements[childId]?.type !== 'Icon')
        const Chevron = open ? ChevronDown : ChevronRight
        return (
          <div
            data-testid='disclosure'
            className='w-full border-(--gui-border,#e2e3e5) border-b last:border-b-0'
            style={styleFromProps(props)}
          >
            <button
              type='button'
              aria-expanded={open}
              className='flex w-full items-center justify-between gap-3 py-3 text-left'
              onClick={() => toggleDisclosure(rowKey, defaultOpen)}
            >
              <span className='min-w-0 flex-1'>
                <span className='block font-medium text-(length:--gui-body-size,16px) text-(--gui-text,#2c2d33) leading-(--gui-body-leading,24px)'>
                  {title}
                </span>
                {subtitle ? (
                  <span className='mt-0.5 block text-(length:--gui-label-size,12px) text-(--gui-text-muted,#575a66)'>
                    {subtitle}
                  </span>
                ) : null}
              </span>
              <Chevron
                aria-hidden
                className='size-[14px] shrink-0 text-(--gui-text-muted,#575a66)'
              />
            </button>
            {open ? (
              <div className='pb-3 text-(length:--gui-body-size,16px) text-(--gui-text,#2c2d33) leading-normal'>
                {bodyIds.map((childId) => (
                  <Fragment key={childId}>
                    {renderNode(childId, scope, childWithinForm, nextFormActionId, childWithinCard)}
                  </Fragment>
                ))}
              </div>
            ) : null}
          </div>
        )
      }
      case 'Card': {
        if (!fieldIsVisible(props, visibilityValues)) return null
        const title = asString(props.title)
        const subtitle = asString(props.subtitle)
        const description = asString(props.description)
        const footerText = asString(props.footerText)
        const heading =
          title || subtitle || description ? (
            <div className='flex min-w-0 flex-col gap-1'>
              {title ? (
                <h2
                  title={title}
                  className={cn(
                    'line-clamp-2 min-w-0 wrap-break-word font-semibold text-(--gui-text,#2c2d33)',
                    scope ? CARD_TITLE_ITEM_CLASS : CARD_TITLE_FEATURED_CLASS
                  )}
                >
                  {title}
                </h2>
              ) : null}
              {subtitle ? (
                <p className='min-w-0 truncate text-(length:--gui-body-size,16px) text-(--gui-text-muted,#575a66) leading-(--gui-body-leading,24px)'>
                  {subtitle}
                </p>
              ) : null}
              {description ? (
                <p className='line-clamp-3 text-(length:--gui-body-size,16px) text-(--gui-text-muted,#575a66) leading-(--gui-body-leading,24px)'>
                  {description}
                </p>
              ) : null}
            </div>
          ) : null
        return (
          <div
            data-testid='card'
            data-variant={asString(props.variant, 'default')}
            className={cn('flex w-full min-w-0 flex-col gap-4', cardSurfaceClass(props.variant))}
            style={styleFromProps(props)}
          >
            {heading}
            {childIds.map((childId) => (
              <Fragment key={childId}>
                {renderNode(childId, scope, childWithinForm, nextFormActionId, childWithinCard)}
              </Fragment>
            ))}
            {footerText ? (
              <div
                data-testid='card-footer'
                className='border-(--gui-border,#e2e3e5) border-t pt-4 text-(length:--gui-caption-size,12px) text-(--gui-text-muted,#575a66) leading-(--gui-caption-leading,20px)'
              >
                {footerText}
              </div>
            ) : null}
          </div>
        )
      }
      case 'Heading': {
        const level = asString(props.level, 'h2')
        const Tag = (['h1', 'h2', 'h3', 'h4'].includes(level) ? level : 'h2') as
          | 'h1'
          | 'h2'
          | 'h3'
          | 'h4'
        return (
          <Tag
            className={cn(
              'font-semibold tracking-tight',
              HEADING_SIZE_CLASSES[Tag],
              textToneClass(props.tone)
            )}
            style={styleFromProps(props)}
          >
            {asString(props.text)}
          </Tag>
        )
      }
      case 'Text':
        return (
          <MarkdownText
            className={textToneClass(props.tone)}
            style={styleFromProps(props)}
            content={asString(props.text)}
          />
        )
      case 'DataText': {
        if (!fieldIsVisible(props, visibilityValues)) return null
        const path = asString(props.statePath)
        if (path === ARENA_GENERATIVE_STREAM_CONTENT_KEY && chatTurnsFromState(state).length > 0) {
          return null
        }
        const dataTextValue = readStatePath(state, path, scope)
        const dataTextPending = boundPending(path)
        const dataTextBusy = dataTextPending && !isEmptyStateValue(dataTextValue)
        return (
          <div className={cn(dataTextBusy && 'opacity-70', textToneClass(props.tone))}>
            <RefetchBusyChrome busy={dataTextBusy} />
            <DataTextView
              value={dataTextValue}
              fallback={asString(props.fallback, '')}
              pending={dataTextPending}
              style={styleFromProps(props)}
            />
          </div>
        )
      }
      case 'Alert':
        return (
          <div
            className={cn('rounded-(--gui-radius-sm,8px) px-4 py-3', toneClass(props.tone))}
          >
            <MarkdownText content={asString(props.text)} />
          </div>
        )
      case 'Toast': {
        if (!fieldIsVisible(props, visibilityValues)) return null
        return <CatalogToastView text={asString(props.text)} tone={props.tone} />
      }
      case 'Tooltip': {
        return (
          <GuiHostTooltip text={asString(props.text)} label={asString(props.label) || undefined}>
            {hasChildren ? children : undefined}
          </GuiHostTooltip>
        )
      }
      case 'Popover': {
        const showWhen = asString(props.showWhen)
        const controlled = Boolean(showWhen)
        return (
          <GuiHostPopover
            title={asString(props.title) || undefined}
            label={asString(props.label) || undefined}
            open={controlled ? fieldIsVisible(props, visibilityValues) : undefined}
            onOpenChange={
              controlled
                ? (next) => {
                    if (next) {
                      const patch = overlayOpenPatch(props.showWhen)
                      if (patch) applyOverlayPatch(patch)
                      return
                    }
                    applyOverlayPatch(overlayClosePatch(props.showWhen))
                  }
                : undefined
            }
          >
            {children}
          </GuiHostPopover>
        )
      }
      case 'Modal':
      case 'Drawer': {
        const side = asString(props.side, 'right')
        const closePatch = overlayClosePatch(props.showWhen)
        return (
          <DismissibleCatalogOverlay
            open={fieldIsVisible(props, visibilityValues)}
            title={asString(props.title)}
            testId={element.type === 'Modal' ? 'modal' : 'drawer'}
            placement={
              element.type === 'Modal' ? 'modal' : side === 'left' ? 'drawer-left' : 'drawer-right'
            }
            onDismiss={
              Object.keys(closePatch).length > 0 ? () => applyOverlayPatch(closePatch) : undefined
            }
            onClearItem={overlayShowWhenUsesSelection(props.showWhen) ? onClearItem : undefined}
          >
            {children}
          </DismissibleCatalogOverlay>
        )
      }
      case 'Spinner':
        return pending ? (
          <p className='text-(length:--gui-body-size,16px) text-(--gui-text-muted,#575a66)'>
            {asString(props.label, 'Loading…')}
          </p>
        ) : null
      case 'Skeleton': {
        if (!pending) return null
        const variant = skeletonVariant(props.variant)
        return (
          <SkeletonBlock
            variant={variant}
            lines={asPositiveNumber(props.lines, DEFAULT_SKELETON_LINES[variant])}
          />
        )
      }
      case 'ProgressSteps': {
        const steps = parseProgressStepLines(asString(props.steps))
        return (
          <ProgressStepsView
            pending={loaderPending(asString(props.actionId))}
            steps={steps}
            durationMs={asPositiveNumber(props.durationMs, DEFAULT_PROGRESS_DURATION_MS)}
          />
        )
      }
      case 'WorkingCard': {
        const steps = parseProgressStepLines(asString(props.steps))
        const intervalMs = asPositiveNumber(
          props.intervalMs,
          steps.length > 0
            ? asPositiveNumber(props.durationMs, DEFAULT_WORKING_INTERVAL_MS * steps.length) /
                steps.length
            : DEFAULT_WORKING_INTERVAL_MS
        )
        const cancelTo = asString(props.cancelTo)
        const showSkeleton = props.skeleton !== false
        return (
          <WorkingCardView
            pending={loaderPending(asString(props.actionId))}
            title={asString(props.title)}
            estimate={asString(props.estimate)}
            tip={asString(props.tip)}
            steps={steps}
            intervalMs={intervalMs}
            cancelLabel={asString(props.cancelLabel, 'Cancel')}
            showSkeleton={showSkeleton}
            onCancel={
              onCancelPending || cancelTo
                ? () => {
                    onCancelPending?.()
                    if (cancelTo) onNavigate(cancelTo)
                  }
                : undefined
            }
          />
        )
      }
      case 'ProgressBar': {
        const statePath = asString(props.statePath)
        const stateValue = statePath ? readStatePath(state, statePath, scope) : undefined
        const raw = stateValue === undefined ? props.value : stateValue
        const parsed = asFiniteNumber(raw)
        if (!pending && parsed === undefined) {
          return null
        }
        const percent = Math.min(100, Math.max(0, parsed ?? (pending ? 12 : 0)))
        const label = asString(props.label)
        return (
          <div className='flex w-full flex-col gap-2' style={styleFromProps(props)}>
            {label ? (
              <span className='text-(length:--gui-label-size,12px) text-(--gui-text-muted,#575a66)'>
                {label}
              </span>
            ) : null}
            <div
              data-testid='progress-bar'
              className='h-2 w-full overflow-hidden rounded-full bg-(--gui-border,#e2e3e5)'
              role='progressbar'
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(percent)}
            >
              <div
                className='h-full rounded-full bg-(--gui-brand,#1a73e8) transition-[width] duration-300'
                style={{ width: `${percent}%` }}
              />
            </div>
          </div>
        )
      }
      case 'Chat': {
        const actionId = asString(props.actionId)
        if (!actionId) return null
        const protocol = actionChatProtocol?.[actionId]
        const turns = chatTurnsFromState(state)
        const contentValue = state[ARENA_GENERATIVE_STREAM_CONTENT_KEY]
        const chatWaiting = controlPending(actionId)
        const showTurnList = turns.length > 0
        const lastTurn = showTurnList ? turns[turns.length - 1] : undefined
        const lastAssistantWaiting =
          chatWaiting && lastTurn?.role === 'assistant' && !lastTurn.content && !lastTurn.error
        const transcriptPinKey = `${turns.length}:${lastTurn?.content ?? ''}:${lastTurn?.error ?? ''}:${chatWaiting}`
        const showTrailingTyping = chatWaiting && lastTurn?.role === 'user'
        const showStandaloneTyping = chatWaiting && !showTurnList && isEmptyStateValue(contentValue)
        const showLegacyTranscript =
          !showTurnList &&
          !showStandaloneTyping &&
          Boolean(protocol) &&
          !specHasDataTextContent(elements) &&
          !isEmptyStateValue(contentValue)
        const composer = (
          <ChatComposer
            actionId={actionId}
            placeholder={asString(props.placeholder, 'Message')}
            protocol={protocol}
            conversationStorageKey={conversationStorageKey}
            hostState={state}
            pending={chatWaiting}
            onSubmit={(id, values) => dispatchAction(id, values, { surface: 'chat' })}
          />
        )
        if (!showTurnList && !showStandaloneTyping && !showLegacyTranscript) {
          return composer
        }
        return (
          <div className='flex w-full flex-col gap-3'>
            <ChatTranscript pinKey={transcriptPinKey}>
              {showTurnList
                ? turns.map((turn, index) => (
                    <div
                      key={`${turn.role}-${index}`}
                      data-testid='generative-chat-turn'
                      data-role={turn.role}
                      className={chatTurnBubbleClass(turn.role)}
                    >
                      {lastAssistantWaiting && index === turns.length - 1 ? (
                        <ChatTypingIndicator />
                      ) : (
                        <>
                          {turn.content || !turn.error ? (
                            <DataTextView value={turn.content} fallback='' pending={false} />
                          ) : null}
                          {turn.error ? (
                            <p
                              data-testid='generative-chat-turn-error'
                              className='text-(length:--gui-label-size,12px) text-(--gui-danger,#c62828)'
                            >
                              {turn.error}
                            </p>
                          ) : null}
                        </>
                      )}
                    </div>
                  ))
                : null}
              {showTrailingTyping ? (
                <div
                  data-testid='generative-chat-turn'
                  data-role='assistant'
                  className={chatTurnBubbleClass('assistant')}
                >
                  <ChatTypingIndicator />
                </div>
              ) : null}
              {showStandaloneTyping ? (
                <div
                  data-testid='generative-chat-turn'
                  data-role='assistant'
                  className={chatTurnBubbleClass('assistant')}
                >
                  <ChatTypingIndicator />
                </div>
              ) : null}
              {showLegacyTranscript ? (
                <DataTextView
                  value={contentValue}
                  fallback=''
                  pending={false}
                  style={styleFromProps(props)}
                />
              ) : null}
            </ChatTranscript>
            {composer}
          </div>
        )
      }
      case 'Form': {
        const actionId =
          asString(props.actionId) || submitButtonActionId(elements, element.children ?? [])
        const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
          event.preventDefault()
          const fields = listFormFields(elements, element.children ?? [])
          const mergedValues = {
            ...formValues,
            ...valuesFromFormElement(event.currentTarget),
          }
          const errors = validateVisibleFields(fields, mergedValues, state, scope)
          if (Object.keys(errors).length > 0) {
            setFieldErrors(errors)
            return
          }
          setFieldErrors({})
          const values = {
            ...actionValues,
            ...collectVisibleFieldValues(fields, mergedValues, state, scope),
          }
          if (actionId) {
            const closePatch = overlayClosePatchForAction(elements, actionId)
            if (closePatch) applyOverlayPatch(closePatch)
            void dispatchAction(actionId, values, confirmMeta(actionId))
          }
        }
        return wrapTaskSurface(
          <form
            className={cn(
              'flex w-full min-w-0 flex-col gap-(--gui-gap,16px)',
              alignItemsClass(props.align, 'stretch')
            )}
            onSubmit={handleSubmit}
            noValidate
          >
            {children}
          </form>,
          props,
          withinCard
        )
      }
      case 'SearchField': {
        if (!fieldIsVisible(props, fieldSnapshot)) return null
        const name = asString(props.name, 'query')
        const label = asString(props.label)
        const fieldId = `field-${name}`
        const error = fieldErrors[name]
        const value = resolveFieldValue('SearchField', props, formValues, state, scope)
        const suggestions = parseOptionList(props.suggestions)
        const submitLabel = asString(props.submitLabel, 'Search')
        const actionId = asString(props.actionId)
        const required = asBoolean(props.required)
        const searchBusy = controlPending(actionId)
        const live = asBoolean(props.live) && Boolean(actionId)
        const dispatchLiveQuery = (query: string) => {
          void dispatchAction(
            actionId,
            { ...actionValues, ...formValues, [name]: query },
            confirmMeta(actionId)
          )
        }
        const searchInput = (
          <GuiHostSearchField
            fieldId={fieldId}
            name={name}
            label={label}
            required={required}
            error={error}
            placeholder={asString(props.placeholder)}
            value={value}
            suggestions={suggestions}
            submitLabel={submitLabel}
            searchBusy={searchBusy}
            live={live}
            buttonClass={buttonClass}
            busyMark={<ActionBusyMark show={searchBusy} />}
            requiredMark={<RequiredMark show={required} />}
            onValueChange={(next) => setNamedValue(name, next)}
            onLiveQuery={dispatchLiveQuery}
          />
        )
        if (withinForm) return searchInput
        const handleSearchSubmit = (event: FormEvent<HTMLFormElement>) => {
          event.preventDefault()
          const fields: ArenaGenerativeFormField[] = [{ type: 'SearchField', props }]
          const mergedValues = {
            ...formValues,
            ...valuesFromFormElement(event.currentTarget),
          }
          const errors = validateVisibleFields(fields, mergedValues, state, scope)
          if (Object.keys(errors).length > 0) {
            setFieldErrors(errors)
            return
          }
          setFieldErrors({})
          const values = {
            ...actionValues,
            ...collectVisibleFieldValues(fields, mergedValues, state, scope),
          }
          if (actionId) {
            void dispatchAction(actionId, values, confirmMeta(actionId))
          }
        }
        return wrapTaskSurface(
          <form className='w-full' onSubmit={handleSearchSubmit} noValidate>
            {searchInput}
          </form>,
          props,
          withinCard
        )
      }
      case 'CommandPalette': {
        const statePath = asString(props.statePath)
        const staticEntries = parseCommandPaletteItems(props.items)
        const boundItems = statePath
          ? (collectionFromBoundValue(readStatePath(state, statePath, scope)) ?? [])
          : []
        const titleField = asString(props.titleField) || defaultCommandPaletteTitleField(boundItems)
        const pathField =
          asString(props.pathField) || defaultCommandPalettePathField(boundItems, titleField)
        const actionField =
          asString(props.actionField) || defaultCommandPaletteActionField(boundItems, titleField)
        const boundEntries =
          boundItems.length > 0
            ? commandPaletteEntriesFromCollection(boundItems, titleField, pathField, actionField)
            : []
        const entries = boundEntries.length > 0 ? boundEntries : staticEntries
        const showWhen = asString(props.showWhen)
        const controlled = Boolean(showWhen)
        return (
          <GuiHostCommandPalette
            placeholder={asString(props.placeholder) || undefined}
            label={asString(props.label) || undefined}
            entries={entries}
            open={controlled ? fieldIsVisible(props, visibilityValues) : undefined}
            onOpenChange={
              controlled
                ? (next) => {
                    if (next) {
                      const patch = overlayOpenPatch(props.showWhen)
                      if (patch) applyOverlayPatch(patch)
                      return
                    }
                    applyOverlayPatch(overlayClosePatch(props.showWhen))
                  }
                : undefined
            }
            onNavigate={requestNavigate}
            onRunAction={(actionId) =>
              void dispatchAction(actionId, actionValues, confirmMeta(actionId))
            }
          />
        )
      }
      case 'TextInput':
      case 'TextArea':
      case 'Select':
      case 'Combobox':
      case 'RadioGroup':
      case 'MultiSelect':
      case 'NumberInput':
      case 'DateInput':
      case 'Checkbox':
      case 'Switch':
      case 'FileInput': {
        if (!isFormFieldType(element.type)) return null
        if (!fieldIsVisible(props, fieldSnapshot)) return null
        const name = asString(props.name)
        const label = asString(props.label)
        const fieldId = `field-${name}`
        const error = fieldErrors[name]
        const value = resolveFieldValue(element.type, props, formValues, state, scope)
        const required = asBoolean(props.required)
        const inputClass = cn(FIELD_INPUT_CLASS, fieldErrorClass(error))

        if (element.type === 'TextArea') {
          return (
            <FieldShell
              name={name}
              label={label}
              htmlFor={fieldId}
              error={error}
              required={required}
            >
              <textarea
                id={fieldId}
                name={name}
                required={required}
                placeholder={asString(props.placeholder) || undefined}
                rows={4}
                value={asFieldString(value)}
                onChange={(event) => setNamedValue(name, event.target.value)}
                className={cn(FIELD_TEXTAREA_CLASS, fieldErrorClass(error))}
              />
            </FieldShell>
          )
        }
        if (element.type === 'Select' || element.type === 'Combobox') {
          const options = parseLabeledOptions(props.options)
          const selected = resolveLabeledOptionValue(asFieldString(value), options)
          const commit = (next: string) => {
            const resolved = resolveLabeledOptionValue(next, options)
            const expanded = expandValueFields(resolved, props.valueFields)
            setFormValues((current) => ({ ...current, [name]: resolved, ...expanded }))
            setFieldErrors((current) => {
              if (!current[name]) return current
              const nextErrors = { ...current }
              delete nextErrors[name]
              return nextErrors
            })
            const actionId = asString(props.actionId)
            if (actionId) {
              void dispatchAction(actionId, { ...actionValues, [name]: resolved, ...expanded })
            }
          }
          return (
            <FieldShell
              name={name}
              label={label}
              htmlFor={fieldId}
              error={error}
              required={required}
            >
              <GuiSelect
                id={fieldId}
                name={name}
                value={selected}
                options={options}
                required={required}
                error={error}
                searchable={element.type === 'Combobox'}
                onChange={commit}
              />
            </FieldShell>
          )
        }
        if (element.type === 'RadioGroup') {
          const options = parseLabeledOptions(props.options)
          const selected = resolveLabeledOptionValue(asFieldString(value), options)
          const commit = (next: string) => {
            const resolved = resolveLabeledOptionValue(next, options)
            const expanded = expandValueFields(resolved, props.valueFields)
            setFormValues((current) => ({ ...current, [name]: resolved, ...expanded }))
            const actionId = asString(props.actionId)
            if (actionId) {
              void dispatchAction(actionId, { ...actionValues, [name]: resolved, ...expanded })
            }
          }
          return (
            <FieldShell name={name} label={label} error={error} required={required}>
              <div role='radiogroup' aria-label={label || name} className='flex flex-col gap-2'>
                {options.map((option) => {
                  const optionId = `${fieldId}-${option.value}`
                  return (
                    <label
                      key={option.value}
                      htmlFor={optionId}
                      className='flex items-center gap-2'
                    >
                      <input
                        id={optionId}
                        type='radio'
                        name={name}
                        value={option.value}
                        checked={selected === option.value}
                        onChange={() => commit(option.value)}
                        className={cn(FIELD_NATIVE_CONTROL_CLASS, 'rounded-full')}
                      />
                      <span>{option.label}</span>
                    </label>
                  )
                })}
              </div>
            </FieldShell>
          )
        }
        if (element.type === 'MultiSelect') {
          const options = parseOptionList(props.options)
          return (
            <FieldShell name={name} label={label} error={error} required={required}>
              <GuiMultiSelect
                id={fieldId}
                name={name}
                options={options}
                selected={asFieldStringList(value)}
                onChange={(next) => setNamedValue(name, next)}
              />
            </FieldShell>
          )
        }
        if (element.type === 'FileInput') {
          return (
            <FieldShell
              name={name}
              label={label}
              htmlFor={fieldId}
              error={error}
              required={required}
            >
              <GuiFileInput
                id={fieldId}
                name={name}
                accept={asString(props.accept) || undefined}
                multiple={asBoolean(props.multiple)}
                required={required}
                error={error}
                value={asGuiFormFiles(value)}
                onChange={(next) => setNamedValue(name, next)}
              />
            </FieldShell>
          )
        }
        if (element.type === 'Checkbox' || element.type === 'Switch') {
          const checked = value === true || value === 'true' || value === 'on'
          if (element.type === 'Switch') {
            const switchLabelId = `${fieldId}-label`
            return (
              <FieldShell name={name} label='' error={error}>
                <div
                  className={cn(
                    'flex items-center gap-2 text-sm',
                    fieldBusy && 'cursor-not-allowed opacity-60'
                  )}
                >
                  <button
                    id={fieldId}
                    type='button'
                    role='switch'
                    aria-checked={checked}
                    aria-labelledby={label ? switchLabelId : undefined}
                    aria-label={label ? undefined : name}
                    name={name}
                    disabled={fieldBusy}
                    onClick={() => setNamedValue(name, !checked)}
                  >
                    <span
                      className={cn(
                        'relative inline-flex h-5 w-9 items-center rounded-(--gui-radius-pill) transition-colors duration-100',
                        checked ? 'bg-(--gui-brand,#1a73e8)' : 'bg-(--gui-border,#e2e3e5)'
                      )}
                    >
                      <span
                        className={cn(
                          'inline-block size-4 rounded-(--gui-radius-pill) bg-(--gui-surface,#ffffff) shadow-(--gui-shadow-card,0px_2px_8px_rgba(44,45,51,0.1)) transition-transform',
                          checked ? 'translate-x-4' : 'translate-x-0.5'
                        )}
                      />
                    </span>
                  </button>
                  {label ? (
                    <label id={switchLabelId} htmlFor={fieldId}>
                      {label}
                      <RequiredMark show={required} />
                    </label>
                  ) : null}
                </div>
              </FieldShell>
            )
          }
          return (
            <FieldShell name={name} label='' error={error}>
              <label htmlFor={fieldId} className='flex items-center gap-2'>
                <input
                  id={fieldId}
                  type='checkbox'
                  name={name}
                  required={required}
                  checked={checked}
                  onChange={(event) => setNamedValue(name, event.target.checked)}
                  className={FIELD_NATIVE_CONTROL_CLASS}
                />
                <span>
                  {label}
                  <RequiredMark show={required} />
                </span>
              </label>
            </FieldShell>
          )
        }
        if (element.type === 'DateInput') {
          return (
            <FieldShell
              name={name}
              label={label}
              htmlFor={fieldId}
              error={error}
              required={required}
            >
              <GuiHostDateInput
                id={fieldId}
                name={name}
                value={asFieldString(value)}
                required={required}
                min={asString(props.min) || undefined}
                max={asString(props.max) || undefined}
                className={inputClass}
                onChange={(next) => setNamedValue(name, next)}
              />
            </FieldShell>
          )
        }
        const inputType = element.type === 'NumberInput' ? 'number' : 'text'
        return (
          <FieldShell name={name} label={label} htmlFor={fieldId} error={error} required={required}>
            <input
              id={fieldId}
              name={name}
              type={inputType}
              required={required}
              placeholder={asString(props.placeholder) || undefined}
              min={asString(props.min) || undefined}
              max={asString(props.max) || undefined}
              step={asString(props.step) || undefined}
              value={asFieldString(value)}
              onChange={(event) => setNamedValue(name, event.target.value)}
              className={inputClass}
            />
          </FieldShell>
        )
      }
      case 'SubmitButton': {
        const label = asString(props.label, 'Submit')
        const className = buttonClass(props, 'primary')
        const actionId = asString(props.actionId)
        const submitBusy = controlPending(actionId || formActionId)
        /**
         * Outside a Form there is nothing to submit, so a bare `type="submit"` would
         * be inert. Run the button's own `actionId` instead — this also revives
         * already-published drafts whose primary button never did anything.
         */
        if (!withinForm && actionId) {
          return (
            <button
              type='button'
              disabled={submitBusy}
              aria-busy={submitBusy || undefined}
              className={cn(className, submitBusy && 'gap-2')}
              onClick={() => void dispatchAction(actionId, actionValues, confirmMeta(actionId))}
            >
              <ActionBusyMark show={submitBusy} />
              {label}
            </button>
          )
        }
        return (
          <button
            type='submit'
            disabled={submitBusy}
            aria-busy={submitBusy || undefined}
            className={cn(className, submitBusy && 'gap-2')}
          >
            <ActionBusyMark show={submitBusy} />
            {label}
          </button>
        )
      }
      case 'Button': {
        const href = asString(props.href)
        const navigateTo = asString(props.navigateTo)
        const actionId = asString(props.actionId)
        const setValue = asString(props.setValue)
        const hostExport = resolveHostContentAction(props)
        const className = buttonClass(props, 'secondary')
        if (!fieldIsVisible(props, visibilityValues)) return null
        if (href) {
          return (
            <a
              href={href}
              className={className}
              style={styleFromProps(props)}
              rel='noreferrer'
              title={asString(props.label) || undefined}
            >
              <RoleLabel label={asString(props.label)} />
            </a>
          )
        }
        const actionBusy = controlPending(actionId)
        const destructiveLooks = asString(props.variant) === 'destructive' && Boolean(actionId)
        const confirm = confirmAction(actionId, destructiveLooks)
        return (
          <button
            type='button'
            className={cn(className, actionBusy && 'gap-2')}
            style={styleFromProps(props)}
            disabled={actionBusy}
            aria-busy={actionBusy || undefined}
            title={asString(props.label) || asString(props.ariaLabel) || undefined}
            data-testid={
              hostExport === 'copy'
                ? 'host-copy-markdown'
                : hostExport === 'downloadPdf'
                  ? 'host-download-pdf'
                  : undefined
            }
            onClick={() => {
              if (hostExport) {
                const markdown = visibleMarkdownForElement(
                  elements,
                  id,
                  state,
                  visibilityValues,
                  scope
                )
                if (hostExport === 'copy') void copyTextToClipboard(markdown)
                else downloadMarkdownPdf(markdown)
                return
              }
              if (confirm) {
                void dispatchAction(actionId, actionValues, { destructive: true })
                return
              }
              if (asBoolean(props.clearItem)) {
                onClearItem?.()
              }
              const parsedSetValue = setValue ? parseChipSetValue(setValue) : null
              if ((asBoolean(props.selectItem) || parsedSetValue?.name === 'editing') && scope) {
                onSelectItem?.(scope.item, scope.index)
              }
              if (parsedSetValue?.name === 'editing') {
                const item = scope?.item ?? state[ARENA_GENERATIVE_SELECTED_KEY]
                const fields = overlayFormFields(elements, 'editing')
                const prefills = formValuesFromRecord(
                  item,
                  fields.length > 0 ? fields : specFormFields(elements)
                )
                if (Object.keys(prefills).length > 0) {
                  setFormValues((current) => ({ ...current, ...prefills }))
                }
              }
              if (parsedSetValue?.name === 'creating') {
                const fields = overlayFormFields(elements, 'creating')
                if (fields.length > 0) {
                  setFormValues((current) => omitFormFieldValues(current, fields))
                }
                applyOverlayPatch({
                  [parsedSetValue.name]: parsedSetValue.value,
                  editing: '',
                })
              } else if (parsedSetValue?.name === 'editing') {
                applyOverlayPatch({
                  [parsedSetValue.name]: parsedSetValue.value,
                  creating: '',
                })
              } else if (parsedSetValue?.name) {
                applyOverlayPatch({ [parsedSetValue.name]: parsedSetValue.value })
              }
              const navPath = navigateTo ? splitNavTarget(navigateTo).path : ''
              const samePageNav = Boolean(navigateTo) && (!navPath || navPath === currentPath)
              const overlayPatch = asBoolean(props.selectItem)
                ? null
                : actionId
                  ? closedOverlayOpenPatch(elements, visibilityValues, actionId)
                  : samePageNav || (!navigateTo && !setValue)
                    ? closedOverlayOpenPatch(elements, visibilityValues)
                    : null
              if (overlayPatch) {
                applyOverlayPatch(overlayPatch)
                return
              }
              if (navigateTo)
                requestNavigate(navigateTo, { keepSelection: asBoolean(props.selectItem) })
              if (actionId) void dispatchAction(actionId, actionValues)
            }}
          >
            <ActionBusyMark show={actionBusy} />
            <RoleLabel label={asString(props.label)} />
          </button>
        )
      }
      case 'NavLink':
        return (
          <button
            type='button'
            className='inline-flex items-center gap-1 font-medium text-(length:--gui-body-size,16px) text-(--gui-brand,#1a73e8) underline-offset-2 hover:text-(--gui-brand-hover,#155cba) hover:underline'
            title={asString(props.label) || undefined}
            onClick={() => requestNavigate(asString(props.to))}
          >
            <RoleLabel label={asString(props.label)} />
          </button>
        )
      case 'Link':
        return (
          <a
            href={asString(props.href)}
            className='font-medium text-(--gui-brand,#1a73e8) underline-offset-2 hover:text-(--gui-brand-hover,#155cba) hover:underline'
            style={styleFromProps(props)}
            rel='noreferrer'
          >
            {asString(props.label)}
          </a>
        )
      case 'Image':
        return (
          <CatalogImage
            src={asString(props.src)}
            alt={asString(props.alt)}
            width={asString(props.width) || undefined}
            height={asString(props.height) || undefined}
          />
        )
      case 'Divider':
        return <hr className='border-(--gui-border,#e2e3e5)' style={styleFromProps(props)} />
      case 'List': {
        const statePath = asString(props.statePath)
        if (!statePath) {
          const Tag = asBoolean(props.ordered) ? 'ol' : 'ul'
          return <Tag className='list-inside pl-1'>{children}</Tag>
        }
        if (!fieldIsVisible(props, visibilityValues)) return null
        const stateValue = readStatePath(state, statePath, scope)
        const rawItems = collectionFromBoundValue(stateValue)
        const discovered = filterCollectionItems(rawItems ?? [], discoveryForElement(id))
        const items =
          applySelectionFilter(id, discovered)
        if (
          boundPending(statePath) &&
          isEmptyStateValue(stateValue) &&
          (!rawItems || rawItems.length === 0)
        ) {
          return <SkeletonBlock variant='card' lines={DEFAULT_SKELETON_LINES.card} />
        }
        if (!rawItems || rawItems.length === 0) {
          return <EmptyState text={asString(props.emptyText, DEFAULT_EMPTY_TEXT.collection)} />
        }
        const { visible, chrome } = pageCollection(id, items, statePath, scope)
        return (
          <>
            <GuiHostCollectionList
              items={visible}
              titleField={asString(props.titleField) || undefined}
              bodyField={asString(props.bodyField) || undefined}
              emptyText={asString(props.emptyText, DEFAULT_EMPTY_TEXT.collection)}
              busy={boundPending(statePath)}
              ordered={asBoolean(props.ordered)}
              onSelectItem={collectionOnSelect(id, statePath)}
            />
            {chrome}
          </>
        )
      }
      case 'ListItem':
        return (
          <li>
            <MarkdownText content={asString(props.text)} />
          </li>
        )
      default:
        return <div>{children}</div>
    }
  }

  return (
    <LoadingChromeContext.Provider
      value={uxPlan?.loadingChrome === 'spinner' ? 'spinner' : 'skeleton'}
    >
      {renderNode(spec.root)}
      {unboundCollections(spec, state).map((entry) => (
        <section key={entry.key} data-testid='unbound-collection' className='mx-auto w-full max-w-3xl px-4 py-4'>
          <GuiHostCollectionList
            items={entry.items}
            emptyText='No rows'
          />
        </section>
      ))}
    </LoadingChromeContext.Provider>
  )
}
