'use client'

import { Button, StatusPageContent } from '@sim/emcn'
import Image from 'next/image'
import { useRouter } from 'next/navigation'
import { APP_ENTRY_PATH } from '@/lib/navigation/paths'
import arenaLogo from '@/app/(interfaces)/chat/components/message/components/ArenaLogo.svg'

interface ChatErrorStateProps {
  error: string
}

export function ChatErrorState({ error }: ChatErrorStateProps) {
  const router = useRouter()

  return (
    <div className='flex flex-1 flex-col items-center justify-center gap-3 px-4 py-16 text-center'>
      <Image src={arenaLogo} alt='Arena' width={48} height={48} />
      <StatusPageContent title='Chat Unavailable' description={error}>
        <Button
          type='button'
          variant='primary'
          className='h-[32px] w-full gap-2 px-2.5 text-sm'
          onClick={() => router.push(APP_ENTRY_PATH)}
        >
          Open Arena AI
        </Button>
      </StatusPageContent>
    </div>
  )
}
