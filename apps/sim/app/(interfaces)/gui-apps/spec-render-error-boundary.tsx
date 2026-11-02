'use client'

import { Component, type ErrorInfo, type ReactNode } from 'react'
import { getErrorMessage } from '@sim/utils/errors'

interface SpecRenderErrorBoundaryProps {
  children: ReactNode
  /** Called once per throw so preview can offer copy-as-edit-instructions. */
  onError?: (message: string) => void
  fallbackTitle?: string
}

interface SpecRenderErrorBoundaryState {
  message: string
}

/**
 * Catches a throw inside SpecRenderer so a bad generated element cannot blank
 * the whole host. Preview uses `onError` to turn the message into an edit prompt.
 */
export class SpecRenderErrorBoundary extends Component<
  SpecRenderErrorBoundaryProps,
  SpecRenderErrorBoundaryState
> {
  state: SpecRenderErrorBoundaryState = { message: '' }

  static getDerivedStateFromError(error: unknown): SpecRenderErrorBoundaryState {
    return { message: getErrorMessage(error, 'This page failed to render') }
  }

  componentDidCatch(error: unknown, _info: ErrorInfo): void {
    this.props.onError?.(getErrorMessage(error, 'This page failed to render'))
  }

  render(): ReactNode {
    if (!this.state.message) {
      return this.props.children
    }
    return (
      <div
        role='alert'
        data-testid='spec-render-error'
        className='p-8 text-(--gui-text,var(--text-error)) text-sm'
      >
        <p className='font-medium'>{this.props.fallbackTitle ?? 'This page failed to render'}</p>
        <p className='mt-2 text-(--gui-text-muted,var(--color-ds-grey-500,#8a8d99))'>
          {this.state.message}
        </p>
        <button
          type='button'
          data-testid='spec-render-error-retry'
          className='mt-4 font-medium text-(--gui-brand,#1a73e8) hover:underline'
          onClick={() => this.setState({ message: '' })}
        >
          Retry
        </button>
      </div>
    )
  }
}
