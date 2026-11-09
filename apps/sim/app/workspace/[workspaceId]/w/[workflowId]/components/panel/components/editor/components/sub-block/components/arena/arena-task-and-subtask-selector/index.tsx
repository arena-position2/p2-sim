'use client'

import * as React from 'react'
import { Combobox, type ComboboxOption, cn } from '@sim/emcn'
import { createLogger } from '@sim/logger'
import axios from 'axios'
import { getArenaToken } from '@/lib/arena-utils/cookie-utils'
import { getEnv } from '@/lib/core/config/env'
import { mergeArenaComboboxOptions } from '@/app/workspace/[workspaceId]/w/[workflowId]/components/panel/components/editor/components/sub-block/components/arena/arena-combobox-utils'
import { arenaSiblingSubBlockStoreKey } from '@/app/workspace/[workspaceId]/w/[workflowId]/components/panel/components/editor/components/sub-block/components/arena/arena-dependency-helpers'
import { useSubBlockValue } from '@/app/workspace/[workspaceId]/w/[workflowId]/components/panel/components/editor/components/sub-block/hooks/use-sub-block-value'
import { useWorkflowRegistry } from '@/stores/workflows/registry/store'
import { useSubBlockStore } from '@/stores/workflows/subblock/store'

const logger = createLogger('ArenaTaskAndSubtaskSelector')

interface Task {
  id: string
  name: string
  sysId: string
  taskType?: string
  projectId?: string
  taskNumber?: string
  archived?: boolean
}

function taskKey(task: Task): string {
  return task.sysId || task.id
}

interface ArenaTaskAndSubtaskSelectorProps {
  blockId: string
  subBlockId: string
  title: string
  layout?: 'full' | 'half'
  isPreview?: boolean
  subBlockValues?: Record<string, any>
  disabled?: boolean
}

export function ArenaTaskAndSubtaskSelector({
  blockId,
  subBlockId,
  layout,
  isPreview = false,
  subBlockValues,
  disabled = false,
}: ArenaTaskAndSubtaskSelectorProps) {
  const [storeValue, setStoreValue] = useSubBlockValue(blockId, subBlockId, true)
  const prevClientIdRef = React.useRef<string | undefined>(undefined)
  const prevProjectIdRef = React.useRef<string | undefined>(undefined)

  const activeWorkflowId = useWorkflowRegistry((state) => state.activeWorkflowId)
  const values = useSubBlockStore((state) => state.workflowValues)

  const clientKey = arenaSiblingSubBlockStoreKey(subBlockId, 'comment-client')
  const projectKey = arenaSiblingSubBlockStoreKey(subBlockId, 'comment-project')
  const clientRef = values?.[activeWorkflowId ?? '']?.[blockId]?.[clientKey] as
    | { clientId?: string }
    | undefined
  const clientId = clientRef?.clientId
  const projectValue = values?.[activeWorkflowId ?? '']?.[blockId]?.[projectKey]
  const projectId =
    typeof projectValue === 'string' ? projectValue : (projectValue as { sysId?: string })?.sysId

  const previewValue = isPreview && subBlockValues ? subBlockValues[subBlockId]?.value : undefined
  const selectedValue = isPreview ? previewValue : storeValue

  const [tasks, setTasks] = React.useState<Task[]>([])
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

        const url = `${arenaBackendBaseUrl}/list/projectservice/getalltaskslist?cid=${clientId}&projectType=STATUS&projectId=${projectId}`
        const response = await axios.get(url, {
          headers: {
            Authorisation: v2Token || '',
            accept: '*/*',
          },
        })

        const taskList = response.data?.response?.TaskList || response.data?.TaskList || []
        if (!cancelled) setTasks(taskList)
      } catch (error) {
        logger.error('Error fetching tasks and subtasks', { error })
        if (!cancelled) setTasks([])
      } finally {
        if (!cancelled) setIsLoading(false)
      }
    }

    fetchTasks()

    return () => {
      cancelled = true
    }
  }, [clientId, projectId])

  const selectedId =
    selectedValue && typeof selectedValue === 'object' && 'sysId' in selectedValue
      ? (selectedValue as Task).sysId || (selectedValue as Task).id
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

  const controlDisabled = disabled || !clientId || !projectId

  return (
    <div className={cn('w-full pt-1', layout === 'half' && 'max-w-md')} id={`task-${subBlockId}`}>
      <Combobox
        key={`${clientId ?? ''}::${projectId ?? ''}`}
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
            setStoreValue({
              id: v,
              sysId: v,
              name: fromOpt.label,
              customDisplayValue: fromOpt.label,
            })
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
