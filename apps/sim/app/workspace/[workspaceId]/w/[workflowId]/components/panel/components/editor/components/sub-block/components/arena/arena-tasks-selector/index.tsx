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

const logger = createLogger('ArenaTaskSelector')

interface Task {
  sysId: string
  id?: string
  name: string
}

interface ArenaTaskSelectorProps {
  blockId: string
  subBlockId: string
  title: string
  layout?: 'full' | 'half'
  isPreview?: boolean
  subBlockValues?: Record<string, any>
  disabled?: boolean
}

function taskKey(t: Task): string {
  return t.sysId || t.id || ''
}

export function ArenaTaskSelector({
  blockId,
  subBlockId,
  layout,
  isPreview = false,
  subBlockValues,
  disabled = false,
}: ArenaTaskSelectorProps) {
  const [storeValue, setStoreValue] = useSubBlockValue(blockId, subBlockId, true)
  const prevProjectIdRef = React.useRef<string | undefined>(undefined)

  const activeWorkflowId = useWorkflowRegistry((state) => state.activeWorkflowId)
  const values = useSubBlockStore((state) => state.workflowValues)
  const logicalId = arenaEffectiveSubBlockId(subBlockId)
  const projectKey =
    logicalId === 'comment-task'
      ? arenaSiblingSubBlockStoreKey(subBlockId, 'comment-project')
      : arenaSiblingSubBlockStoreKey(subBlockId, 'task-project')
  const projectValue = values?.[activeWorkflowId ?? '']?.[blockId]?.[projectKey]
  const projectId =
    typeof projectValue === 'string' ? projectValue : (projectValue as { sysId?: string })?.sysId

  const previewValue = isPreview && subBlockValues ? subBlockValues[subBlockId]?.value : undefined
  const selectedValue = isPreview ? previewValue : storeValue

  const [tasks, setTasks] = React.useState<Task[]>([])
  const [isLoading, setIsLoading] = React.useState(false)

  React.useEffect(() => {
    if (isPreview) return
    if (prevProjectIdRef.current !== undefined && prevProjectIdRef.current !== projectId) {
      setStoreValue(null)
    }
    prevProjectIdRef.current = projectId
  }, [projectId, isPreview, setStoreValue])

  React.useEffect(() => {
    if (!projectId) {
      setTasks([])
      setIsLoading(false)
      return
    }

    let cancelled = false
    const fetchTasks = async () => {
      setIsLoading(true)
      setTasks([])
      try {
        const v2Token = await getArenaToken()
        const arenaBackendBaseUrl = getEnv('NEXT_PUBLIC_ARENA_BACKEND_BASE_URL')

        const url = `${arenaBackendBaseUrl}/sol/v1/tasks/deliverable/list?projectId=${projectId}`
        const response = await axios.get(url, {
          headers: {
            Authorisation: v2Token || '',
          },
        })

        if (!cancelled) setTasks(response.data.deliverables || [])
      } catch (error) {
        logger.error('Error fetching tasks', { error })
        if (!cancelled) setTasks([])
      } finally {
        if (!cancelled) setIsLoading(false)
      }
    }

    fetchTasks()

    return () => {
      cancelled = true
    }
  }, [projectId])

  const selectedId =
    selectedValue && typeof selectedValue === 'object' && 'sysId' in selectedValue
      ? (selectedValue as Task).sysId || (selectedValue as Task).id || ''
      : typeof selectedValue === 'string'
        ? selectedValue
        : ''

  const fallbackLabel =
    selectedValue && typeof selectedValue === 'object' && 'sysId' in selectedValue
      ? (selectedValue as Task & { customDisplayValue?: string }).customDisplayValue ||
        (selectedValue as Task).name
      : undefined

  const options: ComboboxOption[] = React.useMemo(
    () =>
      mergeArenaComboboxOptions(
        tasks.map((t) => ({ label: t.name, value: taskKey(t) })),
        selectedId || undefined,
        fallbackLabel
      ),
    [tasks, selectedId, fallbackLabel]
  )

  const controlDisabled = disabled || !projectId

  return (
    <div className={cn('w-full pt-1', layout === 'half' && 'max-w-md')} id={`task-${subBlockId}`}>
      <Combobox
        key={projectId ?? 'no-project'}
        options={options}
        value={selectedId}
        selectedValue={selectedId}
        onChange={(v) => {
          if (isPreview || controlDisabled) return
          const fromList = tasks.find((t) => taskKey(t) === v)
          const fromOpt = options.find((o) => o.value === v)
          if (fromList) {
            setStoreValue({ ...fromList, customDisplayValue: fromList.name })
          } else if (fromOpt) {
            setStoreValue({ sysId: v, name: fromOpt.label, customDisplayValue: fromOpt.label })
          }
        }}
        placeholder='Select task...'
        disabled={controlDisabled}
        searchable
        searchPlaceholder='Search tasks...'
        emptyMessage='No task found.'
        isLoading={isLoading}
        maxHeight={240}
        dropdownWidth='trigger'
      />
    </div>
  )
}
