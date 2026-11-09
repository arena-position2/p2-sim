'use client'

import Image from 'next/image'

export interface LoadingAgentProps {
  /**
   * Size of the loading agent
   * @default 'md'
   */
  size?: 'sm' | 'md' | 'lg'
}

export function LoadingAgentP2({ size = 'md' }: LoadingAgentProps) {
  const sizes = {
    sm: { width: 16, height: 18 },
    md: { width: 21, height: 24 },
    lg: { width: 30, height: 34 },
  }

  const { width, height } = sizes[size]

  return (
    <Image
      src={'https://arenav2image.s3.us-west-1.amazonaws.com/agentic_ui/agent_loader.gif'}
      alt='loading-gif'
      height={width}
      width={height}
    />
  )
}
