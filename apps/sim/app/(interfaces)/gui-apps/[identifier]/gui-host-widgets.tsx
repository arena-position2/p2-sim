'use client'

import {
  Children,
  useEffect,
  useId,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react'
import { cn } from '@sim/emcn'
import { ChevronLeft, ChevronRight } from 'lucide-react'
import {
  GUI_BOUND_EMPTY_CLASS,
  GUI_WIDGET_SURFACE_CLASS,
} from '@/app/(interfaces)/gui-apps/gui-chrome'
import { formatBoundDateDisplay } from '@/lib/arena-generative-ui/bound-date-format'
import { shortRecordLines } from '@/lib/arena-generative-ui/gui-collection-fields'
import {
  carouselSlidesFromCollection,
  defaultCarouselSrcField,
  defaultCarouselTitleField,
} from '@/lib/arena-generative-ui/gui-carousel'
import {
  defaultMapLatField,
  defaultMapLngField,
  defaultMapTitleField,
  mapMarkersForCollection,
  markerHasCoordinates,
  osmEmbedUrl,
} from '@/lib/arena-generative-ui/gui-map'
import {
  defaultTreeChildrenField,
  defaultTreeTitleField,
  treeNodesFromCollection,
  treeRootIds,
  type TreeNode,
} from '@/lib/arena-generative-ui/gui-tree'
import {
  collectionListRowsFromCollection,
  defaultCollectionListBodyField,
  defaultCollectionListTitleField,
} from '@/lib/arena-generative-ui/gui-collection-list'
import {
  defaultFilmstripSubtitleField,
  defaultFilmstripTitleField,
  filmstripSlidesFromCollection,
} from '@/lib/arena-generative-ui/gui-filmstrip'
import {
  defaultKanbanGroupField,
  defaultKanbanTitleField,
  kanbanColumnsForCollection,
} from '@/lib/arena-generative-ui/gui-kanban'
import {
  defaultTimelineDateField,
  defaultTimelineTitleField,
  timelineItemsForCollection,
} from '@/lib/arena-generative-ui/gui-timeline'

const SURFACE_CLASS = GUI_WIDGET_SURFACE_CLASS
const BOUND_EMPTY_CLASS = GUI_BOUND_EMPTY_CLASS

interface GuiHostMapProps {
  items: readonly unknown[]
  latField?: string
  lngField?: string
  titleField?: string
  emptyText: string
  busy?: boolean
  onSelectItem?: (item: unknown, index: number) => void
}

export function GuiHostMap({
  items,
  latField,
  lngField,
  titleField,
  emptyText,
  busy,
  onSelectItem,
}: GuiHostMapProps) {
  const resolvedLat = latField || defaultMapLatField(items)
  const resolvedLng = lngField || defaultMapLngField(items)
  const resolvedTitle =
    titleField || defaultMapTitleField(items, new Set([resolvedLat, resolvedLng]))
  const markers = mapMarkersForCollection(items, resolvedLat, resolvedLng, resolvedTitle)
  const located = markers.filter(markerHasCoordinates)
  const [selectedIndex, setSelectedIndex] = useState(located[0]?.index ?? 0)
  const headingId = useId()

  useEffect(() => {
    if (markers.some((marker) => marker.index === selectedIndex)) return
    setSelectedIndex(located[0]?.index ?? 0)
  }, [items, selectedIndex])

  if (items.length === 0) {
    return (
      <p
        data-testid='empty-state'
        className={BOUND_EMPTY_CLASS}
      >
        {emptyText}
      </p>
    )
  }

  const selected = markers.find((marker) => marker.index === selectedIndex) ?? located[0]
  const embed =
    selected && markerHasCoordinates(selected)
      ? osmEmbedUrl(selected.lat as number, selected.lng as number)
      : undefined

  const selectMarker = (marker: (typeof markers)[number]) => {
    setSelectedIndex(marker.index)
    onSelectItem?.(marker.item, marker.index)
  }

  return (
    <div
      data-testid='gui-map'
      aria-busy={busy || undefined}
      aria-labelledby={headingId}
      className={SURFACE_CLASS}
    >
      <p id={headingId} className='font-medium text-(--gui-text,#2c2d33)'>
        {selected?.title ?? 'Map'}
      </p>
      {embed ? (
        <iframe
          title={selected?.title ?? 'Map'}
          src={embed}
          className='h-64 w-full rounded-(--gui-radius-sm,8px) border border-(--gui-border,#e2e3e5)'
          loading='lazy'
          referrerPolicy='no-referrer'
        />
      ) : (
        <p className='py-2 text-(length:--gui-body-size,16px) text-(--gui-text-muted,#575a66)'>
          No coordinates to plot.
        </p>
      )}
      {located.length > 0 ? (
        <div data-testid='gui-map-pins' className='relative h-24 w-full'>
          {located.map((marker) => {
            const lats = located.map((item) => item.lat as number)
            const lngs = located.map((item) => item.lng as number)
            const minLat = Math.min(...lats)
            const maxLat = Math.max(...lats)
            const minLng = Math.min(...lngs)
            const maxLng = Math.max(...lngs)
            const latSpan = maxLat - minLat || 1
            const lngSpan = maxLng - minLng || 1
            const top = `${((maxLat - (marker.lat as number)) / latSpan) * 80 + 10}%`
            const left = `${(((marker.lng as number) - minLng) / lngSpan) * 80 + 10}%`
            return (
              <button
                key={marker.index}
                type='button'
                data-testid='gui-map-pin'
                aria-label={marker.title}
                title={marker.title}
                className={cn(
                  'absolute size-3 -translate-x-1/2 -translate-y-1/2 rounded-full',
                  marker.index === selectedIndex
                    ? 'bg-(--gui-brand,#1a73e8)'
                    : 'bg-(--gui-text-muted,#575a66)'
                )}
                style={{ top, left }}
                onClick={() => selectMarker(marker)}
              />
            )
          })}
        </div>
      ) : null}
      <ul className='flex flex-col gap-1'>
        {markers.map((marker) => (
          <li key={marker.index}>
            <button
              type='button'
              className={cn(
                'w-full rounded-(--gui-radius-sm,8px) px-2 py-1.5 text-left text-(length:--gui-body-size,16px)',
                marker.index === selectedIndex
                  ? 'bg-(--gui-brand-surface,#f3f8fe) text-(--gui-brand,#1a73e8)'
                  : 'text-(--gui-text,#2c2d33) hover:bg-(--gui-canvas,#f7f8f9)'
              )}
              onClick={() => selectMarker(marker)}
            >
              <span className='block truncate'>{marker.title}</span>
              {marker.address && marker.address !== marker.title ? (
                <span className='block truncate text-(length:--gui-label-size,12px) text-(--gui-text-muted,#575a66)'>
                  {marker.address}
                </span>
              ) : null}
              {!markerHasCoordinates(marker) ? (
                <span className='block text-(length:--gui-label-size,12px) text-(--gui-text-muted,#575a66)'>
                  No location
                </span>
              ) : null}
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}

interface GuiHostTreeProps {
  items: readonly unknown[]
  childrenField?: string
  titleField?: string
  emptyText: string
  busy?: boolean
  onSelectItem?: (item: unknown, index: number) => void
}

function TreeRow({
  node,
  depth,
  expanded,
  onToggle,
  onSelect,
}: {
  node: TreeNode
  depth: number
  expanded: ReadonlySet<string>
  onToggle: (id: string) => void
  onSelect: (node: TreeNode) => void
}) {
  const isOpen = expanded.has(node.id)
  const hasChildren = node.children.length > 0
  return (
    <li>
      <div
        className='flex items-center gap-1'
        style={{ paddingLeft: `${depth * 16}px` }}
      >
        {hasChildren ? (
          <button
            type='button'
            aria-expanded={isOpen}
            aria-label={isOpen ? `Collapse ${node.title}` : `Expand ${node.title}`}
            className='inline-flex size-6 items-center justify-center rounded-(--gui-radius-sm,8px) text-(--gui-text-muted,#575a66) hover:bg-(--gui-canvas,#f7f8f9)'
            onClick={() => onToggle(node.id)}
          >
            {isOpen ? (
              <ChevronRight className='size-[14px] rotate-90' />
            ) : (
              <ChevronRight className='size-[14px]' />
            )}
          </button>
        ) : (
          <span className='inline-flex size-6' />
        )}
        <button
          type='button'
          className='min-w-0 flex-1 truncate rounded-(--gui-radius-sm,8px) px-2 py-1 text-left text-(length:--gui-body-size,16px) text-(--gui-text,#2c2d33) hover:bg-(--gui-canvas,#f7f8f9)'
          onClick={() => onSelect(node)}
        >
          {node.title}
        </button>
      </div>
      {hasChildren && isOpen ? (
        <ul className='flex flex-col'>
          {node.children.map((child) => (
            <TreeRow
              key={child.id}
              node={child}
              depth={depth + 1}
              expanded={expanded}
              onToggle={onToggle}
              onSelect={onSelect}
            />
          ))}
        </ul>
      ) : null}
    </li>
  )
}

export function GuiHostTree({
  items,
  childrenField,
  titleField,
  emptyText,
  busy,
  onSelectItem,
}: GuiHostTreeProps) {
  const resolvedChildren = childrenField || defaultTreeChildrenField(items)
  const resolvedTitle = titleField || defaultTreeTitleField(items, resolvedChildren)
  const nodes = treeNodesFromCollection(items, resolvedChildren, resolvedTitle)
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(treeRootIds(nodes)))
  const headingId = useId()

  useEffect(() => {
    setExpanded(new Set(treeRootIds(nodes)))
  }, [items, resolvedChildren, resolvedTitle])

  if (items.length === 0) {
    return (
      <p
        data-testid='empty-state'
        className={BOUND_EMPTY_CLASS}
      >
        {emptyText}
      </p>
    )
  }

  return (
    <div
      data-testid='gui-tree'
      aria-busy={busy || undefined}
      aria-labelledby={headingId}
      className={SURFACE_CLASS}
    >
      <p id={headingId} className='sr-only'>
        Tree
      </p>
      <ul className='flex flex-col'>
        {nodes.map((node) => (
          <TreeRow
            key={node.id}
            node={node}
            depth={0}
            expanded={expanded}
            onToggle={(id) => {
              setExpanded((current) => {
                const next = new Set(current)
                if (next.has(id)) next.delete(id)
                else next.add(id)
                return next
              })
            }}
            onSelect={(selected) => onSelectItem?.(selected.item, selected.index)}
          />
        ))}
      </ul>
    </div>
  )
}

interface GuiHostCarouselProps {
  items?: readonly unknown[]
  srcField?: string
  titleField?: string
  emptyText: string
  busy?: boolean
  children?: ReactNode
  onSelectItem?: (item: unknown, index: number) => void
}

export function GuiHostCarousel({
  items = [],
  srcField,
  titleField,
  emptyText,
  busy,
  children,
  onSelectItem,
}: GuiHostCarouselProps) {
  const resolvedSrc = srcField || defaultCarouselSrcField(items)
  const resolvedTitle = titleField || defaultCarouselTitleField(items, resolvedSrc)
  const boundSlides = items.length
    ? carouselSlidesFromCollection(items, resolvedSrc, resolvedTitle)
    : []
  const childSlides = Children.toArray(children)
  const useBound = boundSlides.length > 0
  const count = useBound ? boundSlides.length : childSlides.length
  const [index, setIndex] = useState(0)
  const headingId = useId()

  useEffect(() => {
    setIndex(0)
  }, [count])

  const go = (next: number) => {
    if (count === 0) return
    const wrapped = ((next % count) + count) % count
    setIndex(wrapped)
    if (useBound) {
      const slide = boundSlides[wrapped]
      if (slide) onSelectItem?.(slide.item, slide.index)
    }
  }

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'ArrowLeft') {
      event.preventDefault()
      go(index - 1)
    }
    if (event.key === 'ArrowRight') {
      event.preventDefault()
      go(index + 1)
    }
  }

  if (count === 0) {
    return (
      <p
        data-testid='empty-state'
        className={BOUND_EMPTY_CLASS}
      >
        {emptyText}
      </p>
    )
  }

  const caption = useBound ? boundSlides[index]?.title : undefined

  return (
    <div
      data-testid='gui-carousel'
      role='region'
      aria-roledescription='carousel'
      aria-busy={busy || undefined}
      aria-labelledby={headingId}
      tabIndex={0}
      onKeyDown={onKeyDown}
      className={SURFACE_CLASS}
    >
      <div className='flex items-center justify-between gap-2'>
        <p id={headingId} className='font-medium text-(--gui-text,#2c2d33)'>
          {caption || `Slide ${index + 1} of ${count}`}
        </p>
        <div className='flex items-center gap-1'>
          <button
            type='button'
            aria-label='Previous slide'
            className='inline-flex size-8 items-center justify-center rounded-(--gui-radius-sm,8px) text-(--gui-text,#2c2d33) hover:bg-(--gui-canvas,#f7f8f9)'
            onClick={() => go(index - 1)}
          >
            <ChevronLeft className='size-[14px]' />
          </button>
          <button
            type='button'
            aria-label='Next slide'
            className='inline-flex size-8 items-center justify-center rounded-(--gui-radius-sm,8px) text-(--gui-text,#2c2d33) hover:bg-(--gui-canvas,#f7f8f9)'
            onClick={() => go(index + 1)}
          >
            <ChevronRight className='size-[14px]' />
          </button>
        </div>
      </div>
      <div className='overflow-hidden rounded-(--gui-radius-sm,8px)'>
        {useBound ? (
          boundSlides[index]?.src ? (
            <img
              src={boundSlides[index]?.src}
              alt={boundSlides[index]?.alt || caption || ''}
              className='max-h-80 w-full object-contain'
            />
          ) : (
            <p className='px-4 py-16 text-center text-(length:--gui-body-size,16px) text-(--gui-text-muted,#575a66)'>
              {caption}
            </p>
          )
        ) : (
          <div className='w-full'>{childSlides[index]}</div>
        )}
      </div>
      {count > 1 ? (
        <div className='flex justify-center gap-1'>
          {Array.from({ length: count }, (_, slideIndex) => (
            <button
              key={slideIndex}
              type='button'
              aria-label={`Go to slide ${slideIndex + 1}`}
              aria-current={slideIndex === index ? 'true' : undefined}
              className={cn(
                'size-2 rounded-full',
                slideIndex === index
                  ? 'bg-(--gui-brand,#1a73e8)'
                  : 'bg-(--gui-border,#e2e3e5)'
              )}
              onClick={() => go(slideIndex)}
            />
          ))}
        </div>
      ) : null}
    </div>
  )
}

interface GuiHostTimelineProps {
  items: readonly unknown[]
  dateField?: string
  titleField?: string
  emptyText: string
  busy?: boolean
  onSelectItem?: (item: unknown, index: number) => void
}

export function GuiHostTimeline({
  items,
  dateField,
  titleField,
  emptyText,
  busy,
  onSelectItem,
}: GuiHostTimelineProps) {
  const resolvedDate = dateField || defaultTimelineDateField(items)
  const resolvedTitle = titleField || defaultTimelineTitleField(items, resolvedDate)
  const { dated, undated } = timelineItemsForCollection(items, resolvedDate, resolvedTitle)
  const headingId = useId()

  if (items.length === 0) {
    return (
      <p
        data-testid='empty-state'
        className={BOUND_EMPTY_CLASS}
      >
        {emptyText}
      </p>
    )
  }

  const renderEntry = (entry: { title: string; item: unknown; index: number; iso?: string }) => (
    <li key={`${entry.index}-${entry.title}`} className='relative pl-6'>
      <span
        aria-hidden
        className='absolute top-2 left-0 size-2.5 rounded-full bg-(--gui-brand,#1a73e8)'
      />
      <button
        type='button'
        className='flex w-full flex-col items-start gap-0.5 rounded-(--gui-radius-sm,8px) px-2 py-1.5 text-left hover:bg-(--gui-canvas,#f7f8f9)'
        onClick={() => onSelectItem?.(entry.item, entry.index)}
      >
        {entry.iso ? (
          <span className='font-medium text-(length:--gui-label-size,12px) text-(--gui-text-muted,#575a66)'>
            {formatBoundDateDisplay(entry.iso)}
          </span>
        ) : null}
        <span className='text-(length:--gui-body-size,16px) text-(--gui-text,#2c2d33)'>
          {entry.title}
        </span>
        {shortRecordLines(entry.item, new Set([resolvedDate, resolvedTitle])).map((line) => (
          <span
            key={line}
            className='block truncate text-(length:--gui-label-size,12px) text-(--gui-text-muted,#575a66)'
          >
            {line}
          </span>
        ))}
      </button>
    </li>
  )

  return (
    <div
      data-testid='gui-timeline'
      aria-busy={busy || undefined}
      aria-labelledby={headingId}
      className={SURFACE_CLASS}
    >
      <p id={headingId} className='sr-only'>
        Timeline
      </p>
      <ol className='relative flex flex-col gap-1 border-(--gui-border,#e2e3e5) border-l pl-0'>
        {dated.map(renderEntry)}
      </ol>
      {undated.length > 0 ? (
        <div data-testid='unscheduled' className='flex flex-col gap-1 border-(--gui-border,#e2e3e5) border-t pt-3'>
          <p className='font-medium text-(length:--gui-label-size,12px) text-(--gui-text-muted,#575a66) uppercase tracking-[0.25px]'>
            Undated
          </p>
          <ul className='flex flex-col'>{undated.map(renderEntry)}</ul>
        </div>
      ) : null}
    </div>
  )
}

interface GuiHostKanbanProps {
  items: readonly unknown[]
  groupField?: string
  titleField?: string
  columns?: string
  emptyText: string
  busy?: boolean
  onSelectItem?: (item: unknown, index: number) => void
  onMoveCard?: (index: number, columnId: string, groupField: string) => void
}

export function GuiHostKanban({
  items,
  groupField,
  titleField,
  columns,
  emptyText,
  busy,
  onSelectItem,
  onMoveCard,
}: GuiHostKanbanProps) {
  const resolvedGroup = groupField || defaultKanbanGroupField(items)
  const resolvedTitle = titleField || defaultKanbanTitleField(items, resolvedGroup)
  const lanes = kanbanColumnsForCollection(items, resolvedGroup, resolvedTitle, columns)
  const headingId = useId()

  if (items.length === 0) {
    return (
      <p data-testid='empty-state' className={BOUND_EMPTY_CLASS}>
        {emptyText}
      </p>
    )
  }

  return (
    <div
      data-testid='gui-kanban'
      aria-busy={busy || undefined}
      aria-labelledby={headingId}
      className='flex w-full min-w-0 gap-3 overflow-x-auto pb-1'
    >
      <p id={headingId} className='sr-only'>
        Kanban
      </p>
      {lanes.map((lane) => (
        <section
          key={lane.id}
          data-testid='gui-kanban-column'
          className={cn(SURFACE_CLASS, 'w-64 shrink-0')}
        >
          <p className='font-medium text-(length:--gui-label-size,12px) text-(--gui-text-muted,#575a66) uppercase tracking-[0.25px]'>
            {lane.title}
            <span className='ml-1 font-normal'>({lane.cards.length})</span>
          </p>
          <ul
            className='flex min-h-16 flex-col gap-2'
            onDragOver={(event) => {
              if (!onMoveCard) return
              event.preventDefault()
            }}
            onDrop={(event) => {
              if (!onMoveCard) return
              event.preventDefault()
              const from = Number(event.dataTransfer.getData('text/plain'))
              if (!Number.isInteger(from)) return
              onMoveCard(from, lane.id, resolvedGroup)
            }}
          >
            {lane.cards.map((card) => {
              const details = shortRecordLines(
                card.item,
                new Set([resolvedGroup, resolvedTitle])
              )
              return (
              <li key={card.index}>
                <button
                  type='button'
                  draggable={Boolean(onMoveCard)}
                  className='w-full rounded-(--gui-radius-sm,8px) border border-(--gui-border,#e2e3e5) bg-(--gui-surface,#ffffff) px-3 py-2 text-left text-(length:--gui-body-size,16px) text-(--gui-text,#2c2d33) hover:bg-(--gui-canvas,#f7f8f9)'
                  onDragStart={(event) => {
                    event.dataTransfer.setData('text/plain', String(card.index))
                    event.dataTransfer.effectAllowed = 'move'
                  }}
                  onClick={() => onSelectItem?.(card.item, card.index)}
                >
                  <span className='block'>{card.title}</span>
                  {details.map((line) => (
                    <span
                      key={line}
                      className='mt-1 block truncate text-(length:--gui-label-size,12px) text-(--gui-text-muted,#575a66)'
                    >
                      {line}
                    </span>
                  ))}
                </button>
              </li>
              )
            })}
          </ul>
        </section>
      ))}
    </div>
  )
}

interface GuiHostFilmstripProps {
  items: readonly unknown[]
  titleField?: string
  subtitleField?: string
  emptyText: string
  busy?: boolean
  onSelectItem?: (item: unknown, index: number) => void
}

export function GuiHostFilmstrip({
  items,
  titleField,
  subtitleField,
  emptyText,
  busy,
  onSelectItem,
}: GuiHostFilmstripProps) {
  const resolvedTitle = titleField || defaultFilmstripTitleField(items)
  const resolvedSubtitle =
    subtitleField || defaultFilmstripSubtitleField(items, resolvedTitle)
  const slides = filmstripSlidesFromCollection(items, resolvedTitle, resolvedSubtitle)
  const headingId = useId()

  if (items.length === 0) {
    return (
      <p data-testid='empty-state' className={BOUND_EMPTY_CLASS}>
        {emptyText}
      </p>
    )
  }

  return (
    <div
      data-testid='gui-filmstrip'
      aria-busy={busy || undefined}
      aria-labelledby={headingId}
      className='flex w-full min-w-0 gap-2 overflow-x-auto pb-1'
    >
      <p id={headingId} className='sr-only'>
        Filmstrip
      </p>
      {slides.map((slide) => (
        <button
          key={slide.index}
          type='button'
          className='w-28 shrink-0 rounded-(--gui-radius-sm,8px) border border-(--gui-border,#e2e3e5) bg-(--gui-surface,#ffffff) px-3 py-2 text-left hover:bg-(--gui-canvas,#f7f8f9)'
          onClick={() => onSelectItem?.(slide.item, slide.index)}
        >
          <span className='block truncate font-medium text-(length:--gui-label-size,12px) text-(--gui-text-muted,#575a66)'>
            {slide.title}
          </span>
          {slide.subtitle ? (
            <span className='mt-1 block truncate text-(length:--gui-body-size,16px) text-(--gui-text,#2c2d33)'>
              {slide.subtitle}
            </span>
          ) : null}
        </button>
      ))}
    </div>
  )
}

interface GuiHostCollectionListProps {
  items: readonly unknown[]
  titleField?: string
  bodyField?: string
  emptyText: string
  busy?: boolean
  ordered?: boolean
  onSelectItem?: (item: unknown, index: number) => void
}

export function GuiHostCollectionList({
  items,
  titleField,
  bodyField,
  emptyText,
  busy,
  ordered,
  onSelectItem,
}: GuiHostCollectionListProps) {
  const resolvedTitle = titleField || defaultCollectionListTitleField(items)
  const resolvedBody = bodyField || defaultCollectionListBodyField(items, resolvedTitle)
  const rows = collectionListRowsFromCollection(items, resolvedTitle, resolvedBody)
  const headingId = useId()
  const Tag = ordered ? 'ol' : 'ul'

  if (items.length === 0) {
    return (
      <p data-testid='empty-state' className={BOUND_EMPTY_CLASS}>
        {emptyText}
      </p>
    )
  }

  return (
    <Tag
      data-testid='gui-collection-list'
      aria-busy={busy || undefined}
      aria-labelledby={headingId}
      className='flex w-full min-w-0 flex-col gap-1'
    >
      <span id={headingId} className='sr-only'>
        List
      </span>
      {rows.map((row) => {
        const body = (
          <>
            <span className='block truncate text-(length:--gui-body-size,16px) text-(--gui-text,#2c2d33)'>
              {row.title}
            </span>
            {row.body ? (
              <span className='mt-0.5 block truncate text-(length:--gui-label-size,12px) text-(--gui-text-muted,#575a66)'>
                {row.body}
              </span>
            ) : null}
          </>
        )
        return (
          <li key={row.index}>
            {onSelectItem ? (
              <button
                type='button'
                className='w-full rounded-(--gui-radius-sm,8px) px-2 py-2 text-left hover:bg-(--gui-canvas,#f7f8f9)'
                onClick={() => onSelectItem(row.item, row.index)}
              >
                {body}
              </button>
            ) : (
              <div className='w-full px-2 py-2'>{body}</div>
            )}
          </li>
        )
      })}
    </Tag>
  )
}
