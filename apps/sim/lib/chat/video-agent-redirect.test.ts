/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import {
  isVideoBuilderAgentUrl,
  withLoggedInEmailOnVideoAgentUrl,
} from '@/lib/chat/video-agent-redirect'

describe('withLoggedInEmailOnVideoAgentUrl', () => {
  it('sets emailId on the video builder app and replaces a saved email', () => {
    const result = withLoggedInEmailOnVideoAgentUrl(
      'https://video-builder-agent.vercel.app/?emailId=dhruv.bhambani@position2.com',
      'akshay.poojary@position2.com'
    )
    const url = new URL(result)
    expect(url.hostname).toBe('video-builder-agent.vercel.app')
    expect(url.searchParams.get('emailId')).toBe('akshay.poojary@position2.com')
  })

  it('leaves other agent redirect URLs unchanged', () => {
    const saved = 'https://abm-signal-dashboard.vercel.app/'
    expect(withLoggedInEmailOnVideoAgentUrl(saved, 'akshay.poojary@position2.com')).toBe(saved)
  })

  it('recognises only the video builder host, including a URL with no email', () => {
    expect(isVideoBuilderAgentUrl('https://video-builder-agent.vercel.app/')).toBe(true)
    expect(isVideoBuilderAgentUrl('https://abm-signal-dashboard.vercel.app/')).toBe(false)
    expect(isVideoBuilderAgentUrl(null)).toBe(false)
  })

  it('leaves the video URL unchanged when the viewer email is missing', () => {
    const saved = 'https://video-builder-agent.vercel.app/'
    expect(withLoggedInEmailOnVideoAgentUrl(saved, '  ')).toBe(saved)
  })
})
