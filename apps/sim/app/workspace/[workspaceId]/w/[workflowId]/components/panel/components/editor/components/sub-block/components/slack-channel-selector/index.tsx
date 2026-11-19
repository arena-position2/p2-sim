'use client'

import * as React from 'react'
import { Button, cn, comboboxVariants } from '@sim/emcn'
import axios from 'axios'
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
import { useDependsOnGate } from '@/app/workspace/[workspaceId]/w/[workflowId]/components/panel/components/editor/components/sub-block/hooks/use-depends-on-gate'
import { useSubBlockValue } from '@/app/workspace/[workspaceId]/w/[workflowId]/components/panel/components/editor/components/sub-block/hooks/use-sub-block-value'

interface Channel {
  channel_id: string
  channel_name: string
}

interface SlackChannelSelectorProps {
  blockId: string
  subBlockId: string
  title: string
  layout?: 'full' | 'half'
  isPreview?: boolean
  subBlockValues?: Record<string, any>
  disabled?: boolean
  dependsOn?: string[]
}

export function SlackChannelSelector({
  blockId,
  subBlockId,
  layout,
  isPreview = false,
  subBlockValues,
  disabled = false,
  dependsOn,
}: SlackChannelSelectorProps) {
  const [storeValue, setStoreValue] = useSubBlockValue(blockId, subBlockId)
  const [clientValue] = useSubBlockValue(blockId, 'clientId')

  const previewValue = isPreview && subBlockValues ? subBlockValues[subBlockId]?.value : undefined

  const selectedValue = isPreview ? previewValue : storeValue

  const [channels, setChannels] = React.useState<Channel[]>([])
  const [open, setOpen] = React.useState(false)
  const [loading, setLoading] = React.useState(false)

  const { finalDisabled } = useDependsOnGate(
    blockId,
    { id: subBlockId, type: 'channel-selector', dependsOn },
    {
      isPreview,
      previewContextValues: subBlockValues,
      disabled,
    }
  )

  React.useEffect(() => {
    const fetchChannels = async () => {
      // Only fetch if we have a selected client
      if (!clientValue?.clientId) {
        setChannels([])
        return
      }

      try {
        setLoading(true)
        setChannels([])

        // Fetch channels for the selected client from our local API
        const response = await axios.get(
          `/api/client-channel-mapping/${clientValue.clientId}/channels`
        )

        const channelsData = response.data.channels || []

        setChannels(channelsData)
      } catch {
        setChannels([])
      } finally {
        setLoading(false)
      }
    }

    fetchChannels()
  }, [clientValue?.clientId])

  const selectedLabel =
    channels?.find((channel) => channel.channel_id === selectedValue?.channel_id)?.channel_name ||
    'Select channel...'

  const handleSelect = (channel: Channel) => {
    if (!isPreview && !finalDisabled) {
      setStoreValue({ ...channel, customDisplayValue: channel.channel_name })
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
            className={comboboxVariants()}
            disabled={finalDisabled || loading || !clientValue?.clientId}
          >
            {selectedLabel}
            <ChevronsUpDown className='ml-2 h-4 w-4 shrink-0 opacity-50' />
          </Button>
        </PopoverTrigger>
        <PopoverContent className='w-[var(--radix-popover-trigger-width)] rounded-[4px] p-0'>
          <Command
            filter={(value, search) => {
              const channel = channels.find(
                (ch) => ch.channel_id === value || ch.channel_name === value
              )
              if (!channel) return 0

              return channel.channel_name.toLowerCase().includes(search.toLowerCase()) ||
                channel.channel_id.toLowerCase().includes(search.toLowerCase())
                ? 1
                : 0
            }}
          >
            <CommandInput placeholder='Search channels...' />
            <CommandList>
              <CommandEmpty>
                {!clientValue?.clientId ? 'Select a client first' : 'No channels found.'}
              </CommandEmpty>
              <CommandGroup>
                {channels.map((channel, index) => (
                  <CommandItem
                    key={`channel-${channel.channel_id}-${index}`}
                    value={channel.channel_id}
                    onSelect={() => handleSelect(channel)}
                    style={{ pointerEvents: 'auto' }}
                    className='max-w-full whitespace-normal break-words'
                  >
                    <span className='max-w-[400px] truncate'>{channel.channel_name}</span>
                    <Check
                      className={cn(
                        'ml-auto h-4 w-4',
                        selectedValue?.channel_id === channel.channel_id
                          ? 'opacity-100'
                          : 'opacity-0'
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
