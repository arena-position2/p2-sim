'use client'

import * as React from 'react'
import { Button, cn, comboboxVariants } from '@sim/emcn'
import { Check, ChevronsUpDown } from 'lucide-react'
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { useSubBlockValue } from '@/app/workspace/[workspaceId]/w/[workflowId]/components/panel/components/editor/components/sub-block/hooks/use-sub-block-value'
import { useArenaClientsByUser } from '@/hooks/queries/arena-clients'

interface Client {
  clientId: string
  name: string
}

interface SlackClientSelectorProps {
  blockId: string
  subBlockId: string
  title: string
  layout?: 'full' | 'half'
  isPreview?: boolean
  subBlockValues?: Record<string, any>
  disabled?: boolean
}

export function SlackClientSelector({
  blockId,
  subBlockId,
  layout,
  isPreview = false,
  subBlockValues,
  disabled = false,
}: SlackClientSelectorProps) {
  const [storeValue, setStoreValue] = useSubBlockValue(blockId, subBlockId)

  const previewValue = isPreview && subBlockValues ? subBlockValues[subBlockId]?.value : undefined

  const selectedValue = isPreview ? previewValue : storeValue

  const { data: clientsFromApi = [], isLoading: loading, isError } = useArenaClientsByUser()
  const [open, setOpen] = React.useState(false)

  const clients = React.useMemo((): Client[] => {
    if (isError) return []
    if (clientsFromApi.length > 0) {
      return clientsFromApi
    }
    // If no clients from API, show a fallback for debugging
    return [
      { clientId: 'debug_client_1', name: 'Debug Client 1' },
      { clientId: 'debug_client_2', name: 'Debug Client 2' },
    ]
  }, [clientsFromApi, isError])

  const selectedLabel =
    clients?.find((client) => client.clientId === selectedValue?.clientId)?.name ||
    'Select client...'

  const handleSelect = (client: Client) => {
    if (!isPreview && !disabled) {
      setStoreValue({ ...client, customDisplayValue: client.name })
      setOpen(false)
    }
  }

  return (
    <div className={cn('flex flex-col gap-2 pt-1', layout === 'half' ? 'max-w-md' : 'w-full')}>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant='outline'
            role='combobox'
            aria-expanded={open}
            id={`client-${subBlockId}`}
            className={cn(
              comboboxVariants(),
              'relative w-full cursor-pointer items-center justify-between'
            )}
            disabled={disabled || loading}
          >
            <span className='max-w-[400px] truncate'>{selectedLabel}</span>
            <ChevronsUpDown className='ml-2 h-4 w-4 shrink-0 opacity-50' />
          </Button>
        </PopoverTrigger>
        <PopoverContent className='w-[var(--radix-popover-trigger-width)] rounded-[4px] p-0'>
          <Command
            filter={(value, search) => {
              const client = clients.find((cl) => cl.clientId === value || cl.name === value)
              if (!client) return 0

              return client.name.toLowerCase().includes(search.toLowerCase()) ||
                client.clientId.toLowerCase().includes(search.toLowerCase())
                ? 1
                : 0
            }}
          >
            <CommandInput placeholder='Search clients...' className='h-9' />
            <CommandList>
              <CommandEmpty>No client found.</CommandEmpty>
              <CommandGroup>
                {clients.map((client) => (
                  <CommandItem
                    key={client.clientId}
                    value={client.clientId}
                    onSelect={() => handleSelect(client)}
                    style={{ pointerEvents: 'auto' }}
                    className='max-w-full whitespace-normal break-words'
                  >
                    <span className='max-w-[400px] truncate'>{client.name}</span>
                    <Check
                      className={cn(
                        'ml-auto h-4 w-4',
                        selectedValue?.clientId === client.clientId ? 'opacity-100' : 'opacity-0'
                      )}
                    />
                  </CommandItem>
                ))}
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </div>
  )
}
