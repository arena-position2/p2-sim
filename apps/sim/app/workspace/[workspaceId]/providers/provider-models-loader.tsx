'use client'

/**
 * Loads provider model lists into the workspace providers store.
 *
 * Also hydrates PROVIDER_DEFINITIONS from GET /api/llm-catalog (active DB rows)
 * so static model pickers automatically exclude deactive models without changing
 * each call site. Dynamic providers (Ollama, OpenRouter, …) still sync from
 * their own APIs afterward.
 */

import { useEffect } from 'react'
import { createLogger } from '@sim/logger'
import { useParams, usePathname } from 'next/navigation'
import { useActiveLlmCatalog } from '@/hooks/queries/llm-catalog'
import { useProviderModels } from '@/hooks/queries/providers'
import { getBaseModelProviders } from '@/providers/models'
import {
  applyActiveLlmCatalogToProviders,
  updateBasetenProviderModels,
  updateFireworksProviderModels,
  updateLiteLLMProviderModels,
  updateOllamaCloudProviderModels,
  updateOllamaProviderModels,
  updateOpenRouterProviderModels,
  updateTogetherProviderModels,
  updateVLLMProviderModels,
} from '@/providers/utils'
import { useSearchModalStore } from '@/stores/modals/search/store'
import { type ProviderName, useProvidersStore } from '@/stores/providers'

const logger = createLogger('ProviderModelsLoader')

function shouldLoadProviderModels(
  pathname: string | null,
  workspaceId: string | undefined,
  isSearchModalOpen: boolean
): boolean {
  if (!workspaceId) return false
  if (isSearchModalOpen) return true

  const workspaceBase = `/workspace/${workspaceId}`
  return (
    pathname === workspaceBase ||
    pathname === `${workspaceBase}/home` ||
    pathname === `${workspaceBase}/w` ||
    pathname?.startsWith(`${workspaceBase}/w/`) === true ||
    pathname === `${workspaceBase}/chat` ||
    pathname?.startsWith(`${workspaceBase}/chat/`) === true
  )
}

function useSyncProvider(provider: ProviderName, enabled: boolean, workspaceId?: string) {
  const setProviderModels = useProvidersStore((state) => state.setProviderModels)
  const setProviderLoading = useProvidersStore((state) => state.setProviderLoading)
  const setOpenRouterModelInfo = useProvidersStore((state) => state.setOpenRouterModelInfo)
  const { data, isLoading, isFetching, error } = useProviderModels(provider, workspaceId, {
    enabled,
  })

  useEffect(() => {
    setProviderLoading(provider, isLoading || isFetching)
  }, [provider, isLoading, isFetching, setProviderLoading])

  useEffect(() => {
    if (!data) return

    try {
      if (provider === 'base') {
        // After catalog hydrate, definitions are the source of truth for base models.
        // Fall back to /api/providers/base/models if hydrate has not run yet.
        const fromDefinitions = Object.keys(getBaseModelProviders())
        setProviderModels('base', fromDefinitions.length > 0 ? fromDefinitions : data.models)
        return
      }
      if (provider === 'ollama') {
        updateOllamaProviderModels(data.models)
      } else if (provider === 'ollama-cloud') {
        void updateOllamaCloudProviderModels(data.models)
      } else if (provider === 'vllm') {
        updateVLLMProviderModels(data.models)
      } else if (provider === 'litellm') {
        updateLiteLLMProviderModels(data.models)
      } else if (provider === 'openrouter') {
        void updateOpenRouterProviderModels(data.models)
        if (data.modelInfo) {
          setOpenRouterModelInfo(data.modelInfo)
        }
      } else if (provider === 'fireworks') {
        void updateFireworksProviderModels(data.models)
      } else if (provider === 'together') {
        void updateTogetherProviderModels(data.models)
      } else if (provider === 'baseten') {
        void updateBasetenProviderModels(data.models)
      }
    } catch (syncError) {
      logger.warn(`Failed to sync provider definitions for ${provider}`, syncError as Error)
    }

    setProviderModels(provider, data.models)
  }, [provider, data, setProviderModels, setOpenRouterModelInfo])

  useEffect(() => {
    if (error) {
      logger.error(`Failed to load ${provider} models`, error)
    }
  }, [provider, error])
}

export function ProviderModelsLoader({
  workspaceId: scopedWorkspaceId,
}: {
  workspaceId?: string
} = {}) {
  const params = useParams()
  const pathname = usePathname()
  const workspaceId = scopedWorkspaceId ?? (params?.workspaceId as string | undefined)
  const isSearchModalOpen = useSearchModalStore((state) => state.isOpen)
  const shouldLoad =
    Boolean(scopedWorkspaceId) || shouldLoadProviderModels(pathname, workspaceId, isSearchModalOpen)

  useSyncActiveCatalog(shouldLoad)
  useSyncProvider('base', shouldLoad)
  useSyncProvider('ollama', shouldLoad)
  useSyncProvider('ollama-cloud', shouldLoad, workspaceId)
  useSyncProvider('vllm', shouldLoad)
  useSyncProvider('litellm', shouldLoad)
  useSyncProvider('openrouter', shouldLoad)
  useSyncProvider('fireworks', shouldLoad, workspaceId)
  useSyncProvider('together', shouldLoad, workspaceId)
  useSyncProvider('baseten', shouldLoad, workspaceId)
  return null
}

/** Fetches active DB catalog and writes it into PROVIDER_DEFINITIONS + base store. */
function useSyncActiveCatalog(enabled: boolean) {
  const setProviderModels = useProvidersStore((state) => state.setProviderModels)
  const { data, error } = useActiveLlmCatalog({ enabled })

  useEffect(() => {
    if (!data) return
    try {
      // Mutate PROVIDER_DEFINITIONS so getProviderModels / pickers see active only.
      applyActiveLlmCatalogToProviders(data)
      // Keep the Zustand base list aligned with the hydrated definitions.
      setProviderModels('base', Object.keys(getBaseModelProviders()))
    } catch (syncError) {
      logger.warn('Failed to apply active LLM catalog to PROVIDER_DEFINITIONS', syncError as Error)
    }
  }, [data, setProviderModels])

  useEffect(() => {
    if (error) {
      logger.error('Failed to load active LLM catalog', error)
    }
  }, [error])
}
