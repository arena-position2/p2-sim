'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { getErrorMessage } from '@sim/utils/errors'
import { getSelectorManifestEntry, type SelectorKey } from '@/lib/selectors/manifest'
import { buildSelectorContextFromBlock } from '@/lib/workflows/subblocks/context'
import {
  buildCanonicalIndexForSurface,
  resolveDependencyValue,
} from '@/lib/workflows/subblocks/visibility'
import { getBlock } from '@/blocks/registry'
import {
  type SelectorClientContext,
  useSelectorOptionDetail,
  useSelectorOptionDetails,
  useSelectorOptions,
} from '@/hooks/queries/selectors'
import { useWorkflowRegistry } from '@/stores/workflows/registry/store'
import { useSubBlockStore } from '@/stores/workflows/subblock/store'
import { useWorkflowStore } from '@/stores/workflows/workflow/store'

export interface FetchedOption {
  label: string
  id: string
}

type LocalOption = string | { id: string }

interface UseFetchedOptionsProps {
  blockId: string
  subBlockId: string
  dependsOnFields: string[]
  selectorKey?: SelectorKey
  fetchOptions?: (blockId: string) => Promise<FetchedOption[]>
  fetchOptionById?: (blockId: string, optionId: string) => Promise<FetchedOption | null>
  selectorExcludeSelf?: boolean
  isPreview: boolean
  disabled: boolean
  search?: string
  valueToHydrate: string | null | undefined
  valuesToHydrate?: readonly string[]
  localOptions: readonly LocalOption[]
}

export interface UseFetchedOptionsResult {
  fetchedOptions: FetchedOption[]
  isDynamic: boolean
  isLoadingOptions: boolean
  isFetchingMore: boolean
  isLoadingAll: boolean
  hasMore: boolean
  truncated: boolean
  hasLoadedOptions: boolean
  fetchError: string | null
  hydratedOption: FetchedOption | null
  hydratedOptions: FetchedOption[]
  missingOptionId: string | null
  loadMore: () => void
  loadAll: () => void
  refetch: () => void
}

function hasLocalOption(options: readonly LocalOption[], id: string): boolean {
  return options.some((option) => (typeof option === 'string' ? option === id : option.id === id))
}

/**
 * Adapts ordinary Dropdown/ComboBox fields to the shared React Query selector facade. The
 * context builder keeps active canonical values and exact environment references intact; no
 * provider or environment resolution happens in the browser.
 */
export function useFetchedOptions({
  blockId,
  subBlockId,
  dependsOnFields,
  selectorKey,
  fetchOptions,
  fetchOptionById,
  selectorExcludeSelf,
  isPreview,
  disabled,
  search,
  valueToHydrate,
  valuesToHydrate,
  localOptions,
}: UseFetchedOptionsProps): UseFetchedOptionsResult {
  const activeWorkflowId = useWorkflowRegistry((state) => state.activeWorkflowId)
  const workspaceId = useWorkflowRegistry((state) => state.hydration.workspaceId)
  const block = useWorkflowStore((state) => state.blocks[blockId])
  const liveValues = useSubBlockStore((state) =>
    activeWorkflowId ? state.workflowValues[activeWorkflowId]?.[blockId] : undefined
  )
  const blockConfig = block?.type ? getBlock(block.type) : null
  const canonicalModeOverrides = block?.data?.canonicalModes
  const triggerSurface = block?.triggerMode === true
  const canonicalIndex = useMemo(
    () => buildCanonicalIndexForSurface(blockConfig?.subBlocks || [], triggerSurface),
    [blockConfig?.subBlocks, triggerSurface]
  )
  const dependencyValues = useMemo(() => {
    if (dependsOnFields.length === 0 || !liveValues) return []
    return dependsOnFields.map((depKey) =>
      resolveDependencyValue(depKey, liveValues, canonicalIndex, canonicalModeOverrides)
    )
  }, [canonicalIndex, canonicalModeOverrides, dependsOnFields, liveValues])

  const useLegacyFetch = Boolean(fetchOptions) && !selectorKey
  const [legacyOptions, setLegacyOptions] = useState<FetchedOption[]>([])
  const [legacyLoading, setLegacyLoading] = useState(false)
  const [legacyError, setLegacyError] = useState<string | null>(null)
  const [legacyHydrated, setLegacyHydrated] = useState<FetchedOption | null>(null)
  const [legacyMissing, setLegacyMissing] = useState<string | null>(null)
  const [legacyHasLoaded, setLegacyHasLoaded] = useState(false)
  const [hydrationRevision, setHydrationRevision] = useState(0)
  const hydratedRevisionRef = useRef<{ id: string; revision: number } | null>(null)
  const fetchRequestIdRef = useRef(0)
  const previousFetchScopeRef = useRef('')
  const hasFetchedRef = useRef(false)

  const runLegacyFetch = useCallback(async () => {
    if (!useLegacyFetch || !fetchOptions || isPreview || disabled) return

    const requestId = ++fetchRequestIdRef.current
    setLegacyLoading(true)
    setLegacyError(null)
    try {
      const options = await fetchOptions(blockId)
      if (requestId !== fetchRequestIdRef.current) return
      setLegacyOptions(options)
    } catch (error) {
      if (requestId !== fetchRequestIdRef.current) return
      setLegacyError(getErrorMessage(error, 'Failed to fetch options'))
      setLegacyOptions([])
    } finally {
      if (requestId === fetchRequestIdRef.current) {
        setLegacyLoading(false)
        setLegacyHasLoaded(true)
      }
    }
  }, [blockId, disabled, fetchOptions, isPreview, useLegacyFetch])

  useEffect(() => {
    if (!useLegacyFetch) return

    const current = JSON.stringify([workspaceId, dependencyValues])
    const previous = previousFetchScopeRef.current
    if (previous && current !== previous) {
      fetchRequestIdRef.current += 1
      setLegacyOptions([])
      setLegacyLoading(false)
      setLegacyHydrated(null)
      setLegacyMissing(null)
      setLegacyError(null)
      setLegacyHasLoaded(false)
      hydratedRevisionRef.current = null
      hasFetchedRef.current = false
    }
    previousFetchScopeRef.current = current
  }, [dependencyValues, useLegacyFetch, workspaceId])

  useEffect(() => {
    if (
      !useLegacyFetch ||
      isPreview ||
      disabled ||
      hasFetchedRef.current ||
      legacyLoading ||
      legacyError
    ) {
      return
    }
    hasFetchedRef.current = true
    void runLegacyFetch()
  }, [
    dependencyValues,
    disabled,
    isPreview,
    legacyError,
    legacyLoading,
    runLegacyFetch,
    useLegacyFetch,
  ])

  useEffect(() => {
    if (!useLegacyFetch || !fetchOptionById || isPreview || disabled || !valueToHydrate) return
    if (valueToHydrate.startsWith('<') || valueToHydrate.includes('{{')) return
    if (
      legacyHydrated?.id === valueToHydrate &&
      hydratedRevisionRef.current?.id === valueToHydrate &&
      hydratedRevisionRef.current.revision === hydrationRevision
    ) {
      return
    }
    if (hasLocalOption(legacyOptions, valueToHydrate)) return
    if (hasLocalOption(localOptions, valueToHydrate)) return

    let isActive = true
    fetchOptionById(blockId, valueToHydrate)
      .then((option) => {
        if (!isActive) return
        hydratedRevisionRef.current = option
          ? { id: valueToHydrate, revision: hydrationRevision }
          : null
        setLegacyHydrated(option)
        setLegacyMissing(option ? null : valueToHydrate)
      })
      .catch(() => {
        if (!isActive) return
        setLegacyHydrated(null)
        setLegacyMissing(null)
      })

    return () => {
      isActive = false
    }
  }, [
    blockId,
    disabled,
    fetchOptionById,
    hydrationRevision,
    isPreview,
    legacyHydrated?.id,
    legacyOptions,
    localOptions,
    useLegacyFetch,
    valueToHydrate,
    workspaceId,
  ])

  const refetchLegacy = useCallback(() => {
    hasFetchedRef.current = true
    setHydrationRevision((revision) => revision + 1)
    void runLegacyFetch()
  }, [runLegacyFetch])
  const noop = useCallback(() => {}, [])

  const effectiveKey = selectorKey ?? 'workspace.triggerTypes'
  const manifest = getSelectorManifestEntry(effectiveKey)

  const context = useMemo<SelectorClientContext>(() => {
    if (!selectorKey || !block?.type) return {}
    const merged: Record<string, { value?: unknown }> = { ...(block.subBlocks ?? {}) }
    for (const [id, value] of Object.entries(liveValues ?? {})) {
      merged[id] = { ...merged[id], value }
    }
    const selectorConfig = getBlock(block.type)?.subBlocks.find(
      (candidate) => candidate.id === subBlockId
    )
    const projected = buildSelectorContextFromBlock(block.type, merged, {
      selectorKey,
      dependsOn: dependsOnFields,
      canonicalModes: block.data?.canonicalModes,
      triggerMode: block.triggerMode,
      staticContext: {
        ...(selectorConfig?.mimeType ? { mimeType: selectorConfig.mimeType } : {}),
        ...(selectorExcludeSelf && activeWorkflowId ? { excludeWorkflowId: activeWorkflowId } : {}),
      },
    })
    return {
      ...projected,
      ...(activeWorkflowId ? { workflowId: activeWorkflowId } : {}),
      ...(workspaceId ? { workspaceId } : {}),
    }
  }, [
    activeWorkflowId,
    block,
    dependsOnFields,
    liveValues,
    selectorExcludeSelf,
    selectorKey,
    subBlockId,
    workspaceId,
  ])

  const surfaceId = `${blockId}:${subBlockId}`
  const hydrate = Boolean(
    valueToHydrate &&
      !valueToHydrate.startsWith('<') &&
      !hasLocalOption(localOptions, valueToHydrate)
  )
  const detailIds = useMemo(
    () =>
      (valuesToHydrate ?? []).filter(
        (id) => id && !id.startsWith('<') && !hasLocalOption(localOptions, id)
      ),
    [localOptions, valuesToHydrate]
  )
  const listInteractionEnabled = Boolean(selectorKey) && !isPreview && !disabled
  const listHydrationEnabled = Boolean(
    selectorKey &&
      !listInteractionEnabled &&
      !manifest.supportsDetail &&
      (hydrate || detailIds.length > 0)
  )
  const list = useSelectorOptions(effectiveKey, {
    context,
    ...(search !== undefined ? { search } : {}),
    enabled: listInteractionEnabled || listHydrationEnabled,
    surfaceId,
  })
  const detail = useSelectorOptionDetail(effectiveKey, {
    context,
    detailId: manifest.supportsDetail ? (valueToHydrate ?? undefined) : undefined,
    enabled: Boolean(selectorKey) && manifest.supportsDetail && hydrate,
    surfaceId,
  })
  const details = useSelectorOptionDetails(effectiveKey, {
    context,
    detailIds,
    enabled: Boolean(selectorKey) && manifest.supportsDetail && detailIds.length > 0,
    surfaceId,
  })

  if (useLegacyFetch) {
    return {
      fetchedOptions: legacyOptions,
      isDynamic: true,
      isLoadingOptions: legacyLoading,
      isFetchingMore: false,
      isLoadingAll: false,
      hasMore: false,
      truncated: false,
      hasLoadedOptions: legacyHasLoaded,
      fetchError: legacyError,
      hydratedOption: legacyHydrated,
      hydratedOptions: [],
      missingOptionId: legacyMissing,
      loadMore: noop,
      loadAll: noop,
      refetch: refetchLegacy,
    }
  }

  return {
    fetchedOptions: list.data ?? [],
    isDynamic: Boolean(selectorKey),
    isLoadingOptions: list.isLoading || details.isLoading,
    isFetchingMore: list.isFetchingMore,
    isLoadingAll: list.isLoadingAll,
    hasMore: list.hasMore,
    truncated: list.truncated,
    hasLoadedOptions: list.isSuccess,
    fetchError: list.error ? getErrorMessage(list.error, 'Failed to fetch options') : null,
    hydratedOption: detail.data ?? null,
    hydratedOptions: details.data,
    missingOptionId:
      hydrate && detail.isFetched && !detail.isLoading && detail.data === null
        ? (valueToHydrate ?? null)
        : null,
    loadMore: list.loadMore,
    loadAll: list.loadAll,
    refetch: list.refetch,
  }
}
