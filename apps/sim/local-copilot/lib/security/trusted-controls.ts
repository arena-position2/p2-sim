import {
  formatOAuthConnectBatch,
  formatOAuthConnectCredentialTag,
  type OAuthConnectBatchControl,
  type OAuthConnectControl,
} from '@/local-copilot/lib/oauth-connect-text'
import { LOCAL_OPS_COUNTERS, recordLocalOpsEvent } from '@/local-copilot/lib/ops/metrics'

const PRIVILEGED_TAG_NAMES = [
  'credential',
  'workspace_resource',
  'tool_confirmation',
  'workflow_patch',
] as const

export interface GeneratedApiKeyControl {
  type: 'sim_key'
  value: string
}

export type LocalTrustedControl =
  | OAuthConnectControl
  | OAuthConnectBatchControl
  | GeneratedApiKeyControl

/**
 * Builds a one-time API key control from a successful generate_api_key result.
 */
export function buildGeneratedApiKeyControl(result: unknown): GeneratedApiKeyControl | null {
  if (!result || typeof result !== 'object') return null
  const key = (result as Record<string, unknown>).key
  return typeof key === 'string' && key.trim() ? { type: 'sim_key', value: key } : null
}

/**
 * Converts application-attested control data into the legacy chat renderer format.
 */
export function formatTrustedControl(control: LocalTrustedControl): string {
  if (control.type === 'credential_link') {
    return formatOAuthConnectCredentialTag(control)
  }
  if (control.type === 'credential_links') {
    return formatOAuthConnectBatch(control.links)
  }
  return `<credential>${JSON.stringify({ type: 'sim_key', value: control.value })}</credential>`
}

function noteInjectionStrip(before: string, after: string): void {
  if (before !== after) {
    recordLocalOpsEvent({ counter: LOCAL_OPS_COUNTERS.injectionStripped })
  }
}

/**
 * Removes security-sensitive controls from model-authored text.
 *
 * Trusted application controls use structured stream events and do not pass
 * through this filter.
 */
export function stripUntrustedSecurityControls(content: string, isStreaming: boolean): string {
  let sanitized = content

  for (const tagName of PRIVILEGED_TAG_NAMES) {
    const completeTag = new RegExp(`<${tagName}>[\\s\\S]*?<\\/${tagName}>`, 'gi')
    sanitized = sanitized.replace(completeTag, '')
  }

  if (!isStreaming) {
    noteInjectionStrip(content, sanitized)
    return sanitized
  }

  const lastOpen = sanitized.lastIndexOf('<')
  if (lastOpen < 0) {
    noteInjectionStrip(content, sanitized)
    return sanitized
  }

  const tail = sanitized.slice(lastOpen).toLowerCase()
  const isPrivilegedTagPrefix = PRIVILEGED_TAG_NAMES.some((tagName) => {
    const opening = `<${tagName}`
    return opening.startsWith(tail) || tail.startsWith(opening)
  })

  const next = isPrivilegedTagPrefix ? sanitized.slice(0, lastOpen) : sanitized
  noteInjectionStrip(content, next)
  return next
}
