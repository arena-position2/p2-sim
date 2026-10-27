import type { HostedApiKeySupport } from '@/tools/hosted-api-key'
import type { ToolDefinition } from '@/tools/types'

const HOSTED_API_KEY_NOTE = '<note>API key is hosted by Arena.</note>'
const CONDITIONAL_HOSTED_API_KEY_NOTE =
  '<note>API key is hosted by Arena when hosted-key support applies to the selected configuration.</note>'
const EMAIL_TAGLINE_NOTE =
  '<important>Always add the footer "sent with Arena ai" to the end of the email body. Add 3 line breaks before the footer.</important>'
const EMAIL_TAGLINE_TOOL_IDS = new Set(['gmail_send', 'gmail_send_v2', 'outlook_send'])
const GOOGLE_DOCS_GFM_NOTE =
  '<important>google_docs_create accepts GitHub Flavored Markdown (GFM) in content — use it to store or import markdown. Pass GFM directly; Drive converts headings, tables, bold, lists, and code blocks automatically. When importing from a workspace file, pass the exact GFM from read() output without rewriting.</important>'
const GOOGLE_DOCS_GFM_TOOL_IDS = new Set(['google_docs_create'])

/**
 * `hostedApiKey` is an option rather than a field read off `tool` because the
 * two sources that can answer it differ: an executable `ToolConfig` carries the
 * `hosting` closure (project it with `deriveHostedApiKeySupport`), while the
 * generated tool metadata carries the derived answer directly. Taking it as an
 * argument keeps one branch here and lets either source supply it.
 */
export function getCopilotToolDescription(
  tool: Pick<ToolDefinition, 'description' | 'id' | 'name'>,
  options?: {
    isHosted?: boolean
    hostedApiKey?: HostedApiKeySupport
    fallbackName?: string
    appendEmailTagline?: boolean
  }
): string {
  const baseDescription = tool.description || tool.name || options?.fallbackName || ''
  const notes: string[] = []

  const hostedApiKey = options?.hostedApiKey ?? 'none'
  if (
    options?.isHosted &&
    hostedApiKey !== 'none' &&
    !baseDescription.includes(HOSTED_API_KEY_NOTE) &&
    !baseDescription.includes(CONDITIONAL_HOSTED_API_KEY_NOTE)
  ) {
    notes.push(
      hostedApiKey === 'conditional' ? CONDITIONAL_HOSTED_API_KEY_NOTE : HOSTED_API_KEY_NOTE
    )
  }

  if (
    options?.appendEmailTagline &&
    EMAIL_TAGLINE_TOOL_IDS.has(tool.id) &&
    !baseDescription.includes(EMAIL_TAGLINE_NOTE)
  ) {
    notes.push(EMAIL_TAGLINE_NOTE)
  }

  if (GOOGLE_DOCS_GFM_TOOL_IDS.has(tool.id) && !baseDescription.includes(GOOGLE_DOCS_GFM_NOTE)) {
    notes.push(GOOGLE_DOCS_GFM_NOTE)
  }

  if (notes.length === 0) {
    return baseDescription
  }

  return [baseDescription, ...notes].filter(Boolean).join(' ')
}
