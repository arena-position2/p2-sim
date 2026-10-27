import type {
  LocalCopilotCloudSpecialistDomain,
  LocalCopilotIntent,
  LocalCopilotSpecialistDomain,
} from '@/local-copilot/lib/agent/specialists/domains'
import { MAX_PARALLEL_SUBAGENTS } from '@/local-copilot/lib/agent/specialists/domains'

export { MAX_PARALLEL_SUBAGENTS }

/**
 * Ordering for optional parallel specialist pre-pass (prep domains first).
 * Not used for message classification — routing is prompt + tool calling.
 */
export const PARALLEL_SUBAGENT_PRIORITY: LocalCopilotCloudSpecialistDomain[] = [
  'research',
  'workflow',
  'deploy',
  'run',
  'auth',
  'knowledge',
  'table',
  'file',
  'agent',
  'superagent',
  'media',
  'scheduled_task',
]

/**
 * Turn intent for Local Copilot.
 *
 * No message heuristics: the parent always gets the full tool catalog and full
 * system prompt. The model chooses leaf tools (`create_file`, `knowledge_base`,
 * …) or specialist entry tools (`file`, `knowledge`, …) from the prompt.
 */
export function classifyLocalCopilotIntent(_message?: string): LocalCopilotIntent {
  return { primary: 'general', secondary: [], useFullCatalog: true }
}

/** Auto specialist pre-pass is off — the model invokes specialists via tools. */
export function shouldRunSpecialistPass(_intent: LocalCopilotIntent): boolean {
  return false
}

export function specialistPassDomain(
  _intent: LocalCopilotIntent
): LocalCopilotSpecialistDomain | null {
  return null
}

/**
 * Turn-start parallel fan-out is off. Parent tool calls to specialist entry
 * tools can still run specialists in parallel later.
 */
export function selectParallelSubagentDomains(
  _intent: LocalCopilotIntent
): LocalCopilotCloudSpecialistDomain[] {
  return []
}

/**
 * Scopes an auto-fan-out specialist to its domain so a shared user prompt
 * cannot make every specialist recreate the whole request.
 */
export function buildAutoFanoutSpecialistUserMessage(
  domain: LocalCopilotCloudSpecialistDomain,
  userMessage: string
): string {
  const scope =
    domain === 'file'
      ? 'Handle ONLY file/document work. Do not create or edit workflows. Do not call create_workflow.'
      : domain === 'workflow'
        ? 'Handle ONLY workflow work. Do not create workspace files. Do not call create_file.'
        : `Handle ONLY the ${domain} parts of this request. Do not create resources for other domains.`
  return `${scope}\n\nUser request:\n${userMessage.trim()}`
}
