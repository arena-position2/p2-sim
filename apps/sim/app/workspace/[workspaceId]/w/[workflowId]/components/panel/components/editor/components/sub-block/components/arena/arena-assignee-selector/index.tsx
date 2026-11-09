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

const logger = createLogger('ArenaAssigneeSelector')

interface Assignee {
  value: string
  label: string
}

interface ArenaAssigneeSelectorProps {
  blockId: string
  subBlockId: string
  title: string
  layout?: 'full' | 'half'
  isPreview?: boolean
  subBlockValues?: Record<string, any>
  disabled?: boolean
}

export function ArenaAssigneeSelector({
  blockId,
  subBlockId,
  layout,
  isPreview = false,
  subBlockValues,
  disabled = false,
}: ArenaAssigneeSelectorProps) {
  const [storeValue, setStoreValue] = useSubBlockValue(blockId, subBlockId, true)
  const prevClientIdRef = React.useRef<string | undefined>(undefined)
  const prevProjectIdRef = React.useRef<string | undefined>(undefined)

  const activeWorkflowId = useWorkflowRegistry((state) => state.activeWorkflowId)
  const values = useSubBlockStore((state) => state.workflowValues)
  const logicalId = arenaEffectiveSubBlockId(subBlockId)
  const isSearchTask = logicalId === 'search-task-assignee'
  const isCreateTask = logicalId === 'task-assignee'
  const clientKey = isCreateTask
    ? arenaSiblingSubBlockStoreKey(subBlockId, 'task-client')
    : arenaSiblingSubBlockStoreKey(subBlockId, 'search-task-client')
  const projectKey = isCreateTask
    ? arenaSiblingSubBlockStoreKey(subBlockId, 'task-project')
    : arenaSiblingSubBlockStoreKey(subBlockId, 'search-task-project')
  const clientRef = values?.[activeWorkflowId ?? '']?.[blockId]?.[clientKey] as
    | { clientId?: string }
    | undefined
  const clientId = clientRef?.clientId
  const projectValue = values?.[activeWorkflowId ?? '']?.[blockId]?.[projectKey]
  const projectId =
    typeof projectValue === 'string' ? projectValue : (projectValue as { sysId?: string })?.sysId

  const previewValue = isPreview && subBlockValues ? subBlockValues[subBlockId]?.value : undefined
  const selectedValue = isPreview ? previewValue : storeValue

  const [assignees, setAssignees] = React.useState<Assignee[]>([])
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
    if (!clientId || (isCreateTask && !projectId)) {
      setAssignees([])
      setIsLoading(false)
      return
    }

    let cancelled = false
    const fetchAssignees = async () => {
      setIsLoading(true)
      setAssignees([])
      try {
        const v2Token = await getArenaToken()
        const arenaBackendBaseUrl = getEnv('NEXT_PUBLIC_ARENA_BACKEND_BASE_URL')

        let url = `${arenaBackendBaseUrl}/sol/v1/users/list?cId=${clientId}&pId=${projectId}`
        if (isSearchTask) {
          url = `${url}&allUsers=true&includeClientUsers=true`
        }
        const response = await axios.get(url, {
          headers: {
            Authorisation: v2Token || '',
          },
        })

        const users = response.data?.userList || []

        const formattedAssignees: Assignee[] = users.map(
          (user: { sysId: string; name: string }) => ({
            value: user.sysId,
            label: user.name,
          })
        )

        if (!cancelled) setAssignees(formattedAssignees)
      } catch (error) {
        logger.error('Error fetching assignees', { error })
        if (!cancelled) setAssignees([])
      } finally {
        if (!cancelled) setIsLoading(false)
      }
    }

    fetchAssignees()
    return () => {
      cancelled = true
    }
  }, [clientId, projectId, isCreateTask, isSearchTask])

  const selectedId =
    selectedValue && typeof selectedValue === 'object' && 'value' in selectedValue
      ? (selectedValue as Assignee).value
      : typeof selectedValue === 'string'
        ? selectedValue
        : ''

  const fallbackLabel =
    selectedValue && typeof selectedValue === 'object' && 'value' in selectedValue
      ? (selectedValue as Assignee & { customDisplayValue?: string }).customDisplayValue ||
        (selectedValue as Assignee).label
      : undefined

  const options: ComboboxOption[] = React.useMemo(
    () =>
      mergeArenaComboboxOptions(
        assignees.map((a) => ({ label: a.label, value: a.value })),
        selectedId || undefined,
        fallbackLabel
      ),
    [assignees, selectedId, fallbackLabel]
  )

  const controlDisabled = disabled || isLoading || !clientId || (isCreateTask && !projectId)

  return (
    <div
      className={cn('w-full pt-1', layout === 'half' && 'max-w-md')}
      id={`assignee-${subBlockId}`}
    >
      <Combobox
        key={`${clientId ?? ''}::${projectId ?? ''}`}
        options={options}
        value={selectedId}
        selectedValue={selectedId}
        onChange={(v) => {
          if (isPreview || controlDisabled) return
          const fromList = assignees.find((a) => a.value === v)
          const fromOpt = options.find((o) => o.value === v)
          if (fromList) {
            setStoreValue({ ...fromList, customDisplayValue: fromList.label })
          } else if (fromOpt) {
            setStoreValue({ value: v, label: fromOpt.label, customDisplayValue: fromOpt.label })
          }
        }}
        placeholder='Select assignee...'
        disabled={controlDisabled}
        searchable
        searchPlaceholder='Search assignee...'
        emptyMessage='No assignees found.'
        isLoading={isLoading}
        maxHeight={240}
        dropdownWidth='trigger'
      />
    </div>
  )
}
