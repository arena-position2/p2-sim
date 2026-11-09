'use client'

import * as React from 'react'
import { Combobox, type ComboboxOption, cn } from '@sim/emcn'
import { createLogger } from '@sim/logger'
import axios from 'axios'
import { getArenaToken } from '@/lib/arena-utils/cookie-utils'
import { getEnv } from '@/lib/core/config/env'
import { mergeArenaComboboxOptions } from '@/app/workspace/[workspaceId]/w/[workflowId]/components/panel/components/editor/components/sub-block/components/arena/arena-combobox-utils'
import {
  arenaEffectiveSubBlockId,
  arenaSiblingSubBlockStoreKey,
} from '@/app/workspace/[workspaceId]/w/[workflowId]/components/panel/components/editor/components/sub-block/components/arena/arena-dependency-helpers'
import { useSubBlockValue } from '@/app/workspace/[workspaceId]/w/[workflowId]/components/panel/components/editor/components/sub-block/hooks/use-sub-block-value'
import { useWorkflowRegistry } from '@/stores/workflows/registry/store'
import { useSubBlockStore } from '@/stores/workflows/subblock/store'

const logger = createLogger('ArenaGroupSelector')

interface Group {
  id: string
  name: string
}

interface ArenaGroupSelectorProps {
  blockId: string
  subBlockId: string
  title: string
  layout?: 'full' | 'half'
  isPreview?: boolean
  subBlockValues?: Record<string, any>
  disabled?: boolean
}

export function ArenaGroupSelector({
  blockId,
  subBlockId,
  layout,
  isPreview = false,
  subBlockValues,
  disabled = false,
}: ArenaGroupSelectorProps) {
  const [storeValue, setStoreValue] = useSubBlockValue(blockId, subBlockId, true)
  const prevClientIdRef = React.useRef<string | undefined>(undefined)
  const prevProjectIdRef = React.useRef<string | undefined>(undefined)

  const activeWorkflowId = useWorkflowRegistry((state) => state.activeWorkflowId)
  const values = useSubBlockStore((state) => state.workflowValues)
  const logicalId = arenaEffectiveSubBlockId(subBlockId)
  const clientKey =
    logicalId === 'comment-group'
      ? arenaSiblingSubBlockStoreKey(subBlockId, 'comment-client')
      : arenaSiblingSubBlockStoreKey(subBlockId, 'task-client')
  const projectKey =
    logicalId === 'comment-group'
      ? arenaSiblingSubBlockStoreKey(subBlockId, 'comment-project')
      : arenaSiblingSubBlockStoreKey(subBlockId, 'task-project')
  const clientRef = values?.[activeWorkflowId ?? '']?.[blockId]?.[clientKey] as
    | { clientId?: string }
    | undefined
  const clientId = clientRef?.clientId
  const projectValue = values?.[activeWorkflowId ?? '']?.[blockId]?.[projectKey]
  const projectId =
    typeof projectValue === 'string' ? projectValue : (projectValue as { sysId?: string })?.sysId

  const previewValue = isPreview && subBlockValues ? subBlockValues[subBlockId]?.value : undefined
  const selectedValue = isPreview ? previewValue : storeValue

  const [groups, setGroups] = React.useState<Group[]>([])
  const [isLoading, setIsLoading] = React.useState(false)

  React.useEffect(() => {
    if (isPreview) return
    const clientChanged =
      prevClientIdRef.current !== undefined && prevClientIdRef.current !== clientId
    const projectChanged =
      prevProjectIdRef.current !== undefined && prevProjectIdRef.current !== projectId
    if (clientChanged || projectChanged) {
      setStoreValue(null)
    }
    prevClientIdRef.current = clientId
    prevProjectIdRef.current = projectId
  }, [clientId, projectId, isPreview, setStoreValue])

  React.useEffect(() => {
    if (!clientId || !projectId) {
      setGroups([])
      setIsLoading(false)
      return
    }

    let cancelled = false
    const fetchGroups = async () => {
      setIsLoading(true)
      setGroups([])
      try {
        const v2Token = await getArenaToken()
        const arenaBackendBaseUrl = getEnv('NEXT_PUBLIC_ARENA_BACKEND_BASE_URL')
        const url = `${arenaBackendBaseUrl}/sol/v1/tasks/epic?cid=${clientId}&pid=${projectId}`

        const response = await axios.get(url, {
          headers: {
            Authorisation: v2Token || '',
          },
        })

        const epics = response.data?.epics || []
        const formattedGroups = epics.map((epic: { id: string; name: string }) => ({
          id: epic.id,
          name: epic.name,
        }))
        if (!cancelled) setGroups(formattedGroups)
      } catch (error) {
        logger.error('Error fetching groups', { error })
        if (!cancelled) setGroups([])
      } finally {
        if (!cancelled) setIsLoading(false)
      }
    }

    fetchGroups()
    return () => {
      cancelled = true
    }
  }, [clientId, projectId])

  const selectedId =
    typeof selectedValue === 'object' && selectedValue !== null && 'id' in selectedValue
      ? (selectedValue as Group).id
      : typeof selectedValue === 'string'
        ? selectedValue
        : ''

  const fallbackLabel =
    selectedValue && typeof selectedValue === 'object' && 'id' in selectedValue
      ? (selectedValue as Group & { customDisplayValue?: string }).customDisplayValue ||
        (selectedValue as Group).name
      : undefined

  const options: ComboboxOption[] = React.useMemo(
    () =>
      mergeArenaComboboxOptions(
        groups.map((g) => ({ label: g.name, value: g.id })),
        selectedId || undefined,
        fallbackLabel
      ),
    [groups, selectedId, fallbackLabel]
  )

  const controlDisabled = disabled || !clientId || !projectId

  return (
    <div className={cn('w-full pt-1', layout === 'half' && 'max-w-md')} id={`group-${subBlockId}`}>
      <Combobox
        key={`${clientId ?? ''}::${projectId ?? ''}`}
        options={options}
        value={selectedId}
        selectedValue={selectedId}
        onChange={(v) => {
          if (isPreview || controlDisabled) return
          const fromList = groups.find((g) => g.id === v)
          const fromOpt = options.find((o) => o.value === v)
          if (fromList) {
            setStoreValue({ ...fromList, customDisplayValue: fromList.name })
          } else if (fromOpt) {
            setStoreValue({ id: v, name: fromOpt.label, customDisplayValue: fromOpt.label })
          }
        }}
        placeholder='Select group...'
        disabled={controlDisabled}
        searchable
        searchPlaceholder='Search groups...'
        emptyMessage='No groups found.'
        isLoading={isLoading}
        maxHeight={240}
        dropdownWidth='trigger'
      />
    </div>
  )
}
