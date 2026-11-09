'use client'

import * as React from 'react'
import { Combobox, type ComboboxOption, cn } from '@sim/emcn'
import { mergeArenaComboboxOptions } from '@/app/workspace/[workspaceId]/w/[workflowId]/components/panel/components/editor/components/sub-block/components/arena/arena-combobox-utils'
import { useSubBlockValue } from '@/app/workspace/[workspaceId]/w/[workflowId]/components/panel/components/editor/components/sub-block/hooks/use-sub-block-value'
import { useArenaClientsByUser } from '@/hooks/queries/arena-clients'

interface Client {
  clientId: string
  name: string
}

interface ArenaClientsSelectorProps {
  blockId: string
  subBlockId: string
  title: string
  layout?: 'full' | 'half'
  isPreview?: boolean
  subBlockValues?: Record<string, any>
  disabled?: boolean
}

export function ArenaClientsSelector({
  blockId,
  subBlockId,
  layout,
  isPreview = false,
  subBlockValues,
  disabled = false,
}: ArenaClientsSelectorProps) {
  const [storeValue, setStoreValue] = useSubBlockValue(blockId, subBlockId)

  const previewValue = isPreview && subBlockValues ? subBlockValues[subBlockId]?.value : undefined

  const selectedValue = isPreview ? previewValue : storeValue

  const { data: clients = [], isLoading: isLoadingClients } = useArenaClientsByUser()
  const isLoading = isLoadingClients

  const selectedId =
    selectedValue && typeof selectedValue === 'object' && 'clientId' in selectedValue
      ? (selectedValue as Client).clientId
      : ''

  const fallbackLabel =
    selectedValue && typeof selectedValue === 'object' && 'clientId' in selectedValue
      ? (selectedValue as Client & { customDisplayValue?: string }).customDisplayValue ||
        (selectedValue as Client).name
      : undefined

  const options: ComboboxOption[] = React.useMemo(
    () =>
      mergeArenaComboboxOptions(
        clients.map((c) => ({ label: c.name, value: c.clientId })),
        selectedId || undefined,
        fallbackLabel
      ),
    [clients, selectedId, fallbackLabel]
  )

  return (
    <div className={cn('w-full pt-1', layout === 'half' && 'max-w-md')} id={`client-${subBlockId}`}>
      <Combobox
        options={options}
        value={selectedId}
        selectedValue={selectedId}
        onChange={(v) => {
          if (isPreview || disabled) return
          const fromList = clients.find((cl) => cl.clientId === v)
          const fromOpt = options.find((o) => o.value === v)
          if (fromList) {
            setStoreValue({ ...fromList, customDisplayValue: fromList.name })
          } else if (fromOpt) {
            setStoreValue({ clientId: v, name: fromOpt.label, customDisplayValue: fromOpt.label })
          }
        }}
        placeholder='Select client...'
        disabled={disabled}
        searchable
        searchPlaceholder='Search clients...'
        emptyMessage='No client found.'
        isLoading={isLoading}
        maxHeight={240}
        dropdownWidth='trigger'
      />
    </div>
  )
}
