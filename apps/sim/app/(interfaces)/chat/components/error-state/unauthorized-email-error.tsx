'use client'

import { useEffect, useState } from 'react'
import { Button } from '@sim/emcn'
import { X } from 'lucide-react'
import Image from 'next/image'
import arenaLogo from '@/app/(interfaces)/chat/components/message/components/ArenaLogo.svg'
import { useBrandConfig } from '@/ee/whitelabeling/branding'

interface UnauthorizedEmailErrorProps {
  message?: string
}

/**
 * Error component displayed when user's email is not authorized for the chat
 */
export function UnauthorizedEmailError({
  message = 'Email is not authorized for this chat',
}: UnauthorizedEmailErrorProps) {
  const [buttonClass, setButtonClass] = useState('auth-button-gradient')
  const brandConfig = useBrandConfig()

  useEffect(() => {
    // Check if CSS variable has been customized
    const checkCustomBrand = () => {
      const computedStyle = getComputedStyle(document.documentElement)
      const brandAccent = computedStyle.getPropertyValue('--brand-accent-hex').trim()

      // Check if the CSS variable exists and is different from the default
      if (brandAccent && brandAccent !== '#6f3dfa') {
        setButtonClass('auth-button-custom')
      } else {
        setButtonClass('auth-button-gradient')
      }
    }

    checkCustomBrand()

    // Also check on window resize or theme changes
    window.addEventListener('resize', checkCustomBrand)
    const observer = new MutationObserver(checkCustomBrand)
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['style', 'class'],
    })

    return () => {
      window.removeEventListener('resize', checkCustomBrand)
      observer.disconnect()
    }
  }, [])

  const handleExit = () => {
    function getRedirectUrl(hostname: string) {
      let redirectUrl = ''
      if (hostname === 'dev-agent.thearena.ai') {
        redirectUrl = 'https://dev.thearena.ai/agents'
      } else if (hostname === 'test-agent.thearena.ai') {
        redirectUrl = 'https://test.thearena.ai/agents'
      } else if (hostname === 'test-v1-agent.thearena.ai') {
        redirectUrl = 'https://test.thearena.ai/agents'
      } else if (hostname === 'sandbox-agent.thearena.ai') {
        redirectUrl = 'https://sandbox.thearena.ai/agents'
      } else if (hostname === 'agent.thearena.ai') {
        redirectUrl = 'https://app.thearena.ai/agents'
      } else {
        redirectUrl = 'https://app.thearena.ai/agents'
      }
      return redirectUrl
    }
    const hostname = window.location.hostname
    const redirectUrl = getRedirectUrl(hostname)

    window.location.href = redirectUrl
  }

  return (
    <div className='min-h-screen bg-white'>
      <div className='flex min-h-screen items-center justify-center px-4'>
        <div className='w-full max-w-[410px]'>
          <div className='flex flex-col items-center justify-center'>
            <div className='mb-6 flex items-center justify-center'>
              <Image src={arenaLogo} alt='Arena Logo' width={68} height={68} />
            </div>

            <div className='space-y-1 text-center'>
              <h1 className='font-medium text-[32px] text-black tracking-tight'>Access Denied</h1>
              <p className='font-normal text-[16px] text-muted-foreground'>{message}</p>
            </div>

            <div className='mt-8 w-full'>
              <Button
                type='button'
                onClick={handleExit}
                className={`${buttonClass} flex w-full items-center justify-center gap-2 rounded-[10px] border font-medium text-[15px] text-white transition-all duration-200`}
              >
                <X className='h-4 w-4' />
                Go Back
              </Button>
            </div>
          </div>
        </div>
      </div>
      <div className='auth-text-muted fixed right-0 bottom-0 left-0 z-50 pb-8 text-center text-[13px] leading-relaxed'>
        Need help?{' '}
        <a
          href={`mailto:${brandConfig.supportEmail}`}
          className='auth-link underline-offset-4 transition hover:underline'
        >
          Contact support
        </a>
      </div>
    </div>
  )
}
