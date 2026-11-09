'use client'

import * as React from 'react'
import { Combobox, type ComboboxOption, cn } from '@sim/emcn'
import { createLogger } from '@sim/logger'
import axios from 'axios'
import { getArenaToken } from '@/lib/arena-utils/cookie-utils'
import { getEnv } from '@/lib/core/config/env'
import { mergeArenaComboboxOptions } from '@/app/workspace/[workspaceId]/w/[workflowId]/components/panel/components/editor/components/sub-block/components/arena/arena-combobox-utils'
import { useSubBlockValue } from '../../../hooks/use-sub-block-value'

interface ArenaState {
  id: string
  name: string
}

const logger = createLogger('ArenaStatesSelector')

interface ArenaStatesSelectorProps {
  blockId: string
  subBlockId: string
  title: string
  layout?: 'full' | 'half'
  isPreview?: boolean
  subBlockValues?: Record<string, any>
  disabled?: boolean
}

export function ArenaStatesSelector({
  blockId,
  subBlockId,
  layout,
  isPreview = false,
  subBlockValues,
  disabled = false,
}: ArenaStatesSelectorProps) {
  const [storeValue, setStoreValue] = useSubBlockValue(blockId, subBlockId, true)

  const previewValue = isPreview && subBlockValues ? subBlockValues[subBlockId]?.value : undefined
  const selectedValues: string[] = isPreview
    ? previewValue || []
    : Array.isArray(storeValue)
      ? storeValue
      : storeValue
        ? String(storeValue).split(',')
        : []

  const [states, setStates] = React.useState<ArenaState[]>([])
  const [isLoading, setIsLoading] = React.useState(false)

  React.useEffect(() => {
    const fetchStates = async () => {
      setIsLoading(true)
      setStates([])
      try {
        const v2Token = await getArenaToken()
        const arenaBackendBaseUrl = getEnv('NEXT_PUBLIC_ARENA_BACKEND_BASE_URL')

        const url = `${arenaBackendBaseUrl}/sol/v1/state-management/state`
        const response = await axios.get(url, {
          headers: {
            authorisation: v2Token || '',
          },
        })

        const payload = response.data
        const nextStates = Array.isArray(payload)
          ? payload
          : Array.isArray(payload?.states)
            ? payload.states
            : Array.isArray(payload?.data)
              ? payload.data
              : []

        setStates(nextStates)
      } catch (error) {
        logger.error('Failed to fetch Arena states', {
          error: error instanceof Error ? error.message : String(error),
        })
        setStates([])
      } finally {
        setIsLoading(false)
      }
    }

    fetchStates()
  }, [])

  const options: ComboboxOption[] = React.useMemo(() => {
    let base: ComboboxOption[] = states.map((s) => ({ label: s.name, value: s.name }))
    for (const sv of selectedValues) {
      base = mergeArenaComboboxOptions(base, sv, sv)
    }
    return base
  }, [states, selectedValues])

  const onMultiSelectChange = (values: string[]) => {
    if (isPreview || disabled) return
    setStoreValue(values)
  }

  return (
    <div className={cn('w-full pt-1', layout === 'half' && 'max-w-md')} id={`state-${subBlockId}`}>
      <Combobox
        options={options}
        multiSelect
        multiSelectValues={selectedValues}
        onMultiSelectChange={onMultiSelectChange}
        placeholder='Select states...'
        searchable
        searchPlaceholder='Search states...'
        emptyMessage='No state found.'
        isLoading={isLoading}
        maxHeight={240}
        dropdownWidth='trigger'
        disabled={disabled}
        className='w-full'
        overlayContent={
          selectedValues.length > 0 ? (
            <span className='truncate text-[var(--text-primary)]'>{selectedValues.join(', ')}</span>
          ) : undefined
        }
      />
    </div>
  )
}
