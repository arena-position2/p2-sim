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

const logger = createLogger('ArenaProjectSelector')

interface Project {
  sysId: string
  name: string
}

interface ArenaProjectSelectorProps {
  blockId: string
  subBlockId: string
  title: string
  clientId?: string
  layout?: 'full' | 'half'
  isPreview?: boolean
  subBlockValues?: Record<string, any>
  disabled?: boolean
}

export function ArenaProjectSelector({
  blockId,
  subBlockId,
  layout,
  isPreview = false,
  subBlockValues,
  disabled = false,
}: ArenaProjectSelectorProps) {
  const [storeValue, setStoreValue] = useSubBlockValue(blockId, subBlockId, true)
  const prevClientIdRef = React.useRef<string | undefined>(undefined)

  const activeWorkflowId = useWorkflowRegistry((state) => state.activeWorkflowId)
  const values = useSubBlockStore((state) => state.workflowValues)
  const logicalId = arenaEffectiveSubBlockId(subBlockId)
  const clientKey =
    logicalId === 'task-project'
      ? arenaSiblingSubBlockStoreKey(subBlockId, 'task-client')
      : logicalId === 'comment-project'
        ? arenaSiblingSubBlockStoreKey(subBlockId, 'comment-client')
        : arenaSiblingSubBlockStoreKey(subBlockId, 'search-task-client')
  const clientRef = values?.[activeWorkflowId ?? '']?.[blockId]?.[clientKey] as
    | { clientId?: string }
    | undefined
  const clientId = clientRef?.clientId

  const previewValue = isPreview && subBlockValues ? subBlockValues[subBlockId]?.value : undefined
  const selectedValue = isPreview ? previewValue : storeValue

  const [projects, setProjects] = React.useState<Project[]>([])
  const [isLoading, setIsLoading] = React.useState(false)

  React.useEffect(() => {
    if (isPreview) return
    if (prevClientIdRef.current !== undefined && prevClientIdRef.current !== clientId) {
      setStoreValue(null)
    }
    prevClientIdRef.current = clientId
  }, [clientId, isPreview, setStoreValue])

  React.useEffect(() => {
    if (!clientId) {
      setProjects([])
      setIsLoading(false)
      return
    }

    let cancelled = false
    const fetchProjects = async () => {
      setIsLoading(true)
      setProjects([])
      try {
        const v2Token = await getArenaToken()
        const arenaBackendBaseUrl = getEnv('NEXT_PUBLIC_ARENA_BACKEND_BASE_URL')
        const url = `${arenaBackendBaseUrl}/sol/v1/projects?cid=${clientId}&projectType=STATUS&name=${''}`
        const response = await axios.get(url, {
          headers: {
            Authorisation: v2Token || '',
          },
        })
        if (!cancelled) setProjects(response.data.projectList || [])
      } catch (error) {
        logger.error('Error fetching projects', { error })
        if (!cancelled) setProjects([])
      } finally {
        if (!cancelled) setIsLoading(false)
      }
    }

    fetchProjects()

    return () => {
      cancelled = true
    }
  }, [clientId])

  const selectedId =
    typeof selectedValue === 'string'
      ? selectedValue
      : selectedValue && typeof selectedValue === 'object' && 'sysId' in selectedValue
        ? (selectedValue as Project).sysId
        : ''

  const fallbackLabel =
    selectedValue && typeof selectedValue === 'object' && 'sysId' in selectedValue
      ? (selectedValue as Project & { customDisplayValue?: string }).customDisplayValue ||
        (selectedValue as Project).name
      : undefined

  const options: ComboboxOption[] = React.useMemo(
    () =>
      mergeArenaComboboxOptions(
        projects.map((p) => ({ label: p.name, value: p.sysId })),
        selectedId || undefined,
        fallbackLabel
      ),
    [projects, selectedId, fallbackLabel]
  )

  const controlDisabled = disabled || !clientId

  return (
    <div
      className={cn('w-full pt-1', layout === 'half' && 'max-w-md')}
      id={`project-${subBlockId}`}
    >
      <Combobox
        key={clientId ?? 'no-client'}
        options={options}
        value={selectedId}
        selectedValue={selectedId}
        onChange={(v) => {
          if (isPreview || controlDisabled) return
          const fromList = projects.find((p) => p.sysId === v)
          const fromOpt = options.find((o) => o.value === v)
          if (fromList) {
            setStoreValue({ ...fromList, customDisplayValue: fromList.name })
          } else if (fromOpt) {
            setStoreValue({ sysId: v, name: fromOpt.label, customDisplayValue: fromOpt.label })
          }
        }}
        placeholder='Select project...'
        disabled={controlDisabled}
        searchable
        searchPlaceholder='Search projects...'
        emptyMessage='No project found.'
        isLoading={isLoading}
        maxHeight={240}
        dropdownWidth='trigger'
      />
    </div>
  )
}
