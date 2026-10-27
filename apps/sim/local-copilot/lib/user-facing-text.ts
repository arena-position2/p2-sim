/**
 * Helpers that keep Arena Copilot user-facing text clean and stop tool thrash
 * after a successful workflow build.
 */

import {
  MAX_PRE_POPULATE_DISCOVERY_CALLS,
  MAX_PRE_POPULATE_DISCOVERY_ROUND_REFUNDS,
} from '@/local-copilot/lib/agent/limits'
import { stripOptionsTagsForDisplay } from '@/local-copilot/lib/format-options-tag'
import { stripUntrustedSecurityControls } from '@/local-copilot/lib/security/trusted-controls'

/** Any UUID-shaped token (not only RFC version/variant nibbles). */
const UUID_PATTERN = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi

/** Anthropic / OpenAI / Responses API tool-call ids. */
const PROVIDER_TOOL_CALL_ID_PATTERN = /\b(?:toolu_|call_|fc_)[A-Za-z0-9_-]{6,}\b/g

/**
 * CamelCase id labels the model often echoes from tool JSON
 * (`workflowId: …`, `blockId=…`, `[messageId:…]`).
 */
const LABELED_ID_PATTERN =
  /\b(?:workflow|block|execution|message|patch|chat|conversation|tool(?:Call)?|start(?:Block)?|job|file|document)Id\b\s*[:=]\s*[`'"[]?[A-Za-z0-9_-]+[`'"\]]?/gi

const MESSAGE_ID_BRACKET_PATTERN = /\[messageId:[^\]]*\]/gi

/** Privileged tags that must keep embedded ids for Apply/Approve UI. */
const PRIVILEGED_CONTROL_TAG_PATTERN =
  /<(credential|workspace_resource|tool_confirmation|workflow_patch|options)>[\s\S]*?<\/\1>/gi

/** After a successful populate, restrict which tools the model may still call. */
export type PostBuildToolMode = 'all' | 'oauth_only' | 'final_only' | 'done'

/**
 * Tools to attach on a model round after a successful workflow populate.
 *
 * Bedrock requires `toolConfig` whenever the conversation already contains
 * toolUse/toolResult blocks — never return `[]` for `final_only`. Keep the
 * catalog and discard unwanted tool calls in the orchestrator instead.
 */
export function resolvePostBuildRoundTools<T extends { name: string }>(
  mode: PostBuildToolMode,
  tools: T[]
): T[] {
  if (mode === 'oauth_only') {
    const oauthOnly = tools.filter((tool) => tool.name === 'oauth_get_auth_link')
    return oauthOnly.length > 0 ? oauthOnly : tools
  }
  return tools
}

const COMPLETION_MARKERS = [
  'connect gmail',
  'connect google',
  'fully built',
  'built and wired',
  'structurally complete',
  'start → fetch',
  'start -> fetch',
  'start —',
  'start -',
  'fetch emails',
  'newer_than:',
  'one step left',
  'one thing left',
  'only remaining',
  'authorize gmail',
] as const

/**
 * True when earlier-round prose already delivered a post-build completion pitch
 * (workflow built + connect accounts). Used to suppress re-streaming duplicates.
 */
export function contentLooksLikeCompletion(text: string): boolean {
  const normalized = normalizeCompletionText(text)
  if (normalized.length < 80) return false
  const markers = COMPLETION_MARKERS.filter((marker) =>
    normalized.includes(normalizeCompletionText(marker))
  ).length
  return markers >= 2
}
/**
 * Removes internal ids from prose without destroying auth/callback URLs or
 * privileged control tags that need ids for Apply/Approve UI.
 */
export function stripIdsFromUserFacingText(text: string): string {
  if (!text) return text

  const protectedSegments: string[] = []
  const protect = (segment: string): string => {
    protectedSegments.push(segment)
    return `<<PROT_${protectedSegments.length - 1}>>`
  }

  const withProtected = text
    .replace(PRIVILEGED_CONTROL_TAG_PATTERN, (tag) => protect(tag))
    .replace(/https?:\/\/\S+/gi, (url) => protect(url))

  const stripped = withProtected
    .replace(
      /\b(?:start\s+)?block\s+id(?:s)?\s*(?:is|are|=|:)\s*[0-9a-f-]{36}\b/gi,
      'the Start block'
    )
    .replace(MESSAGE_ID_BRACKET_PATTERN, '')
    .replace(LABELED_ID_PATTERN, '')
    .replace(
      /\b(?:an?\s+)?(?:workflow|block|execution|message|patch|tool|chat|conversation)\s+ids?\s*(?:is|are|=|:)\s*[`'"[]?[A-Za-z0-9_-]+[`'"\]]?/gi,
      ''
    )
    .replace(PROVIDER_TOOL_CALL_ID_PATTERN, '')
    .replace(UUID_PATTERN, '')
    .replace(/\(\s*IDs?\s*:?\s*\)/gi, '')
    .replace(/\bIDs?\s*:?\s*(?=[.,;)\]]|$)/gi, '')
    .replace(/\[\s*\]/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/ ?\n{3,}/g, '\n\n')
    .replace(/[ \t]+([.,;:])/g, '$1')

  return stripped.replace(/<<PROT_(\d+)>>/g, (_, index) => protectedSegments[Number(index)] ?? '')
}

/**
 * System nudge after a successful populate edit with no repair follow-up.
 */
export function buildWorkflowBuildCompleteSystemMessage(mode: PostBuildToolMode): string {
  if (mode === 'oauth_only') {
    return (
      '[System] Workflow populate succeeded. Call oauth_get_auth_link once for each missing provider in this response, ' +
      'then STOP. Do not validate, re-edit, or re-fetch metadata. ' +
      'The Connect control is shown automatically from the tool result — do not invent URLs.'
    )
  }
  return (
    '[System] Workflow populate succeeded. No further tools. ' +
    'Reply once: short summary of what was built (display names only), then at most one <options> block. ' +
    'Do not restate or re-verify.'
  )
}

/**
 * System nudge when block metadata was already fetched this turn.
 */
export function buildBlocksMetadataReuseSystemMessage(): string {
  return (
    '[System] Block metadata was already fetched this turn. ' +
    'Reuse that result. Do not call get_blocks_metadata or load_copilot_artifact again unless a specific field id is missing. ' +
    'Call edit_workflow now. A daily time trigger is block type "schedule" (scheduleType "daily", dailyTime "09:00", timezone "Asia/Kolkata" for IST) — never "schedule_trigger". ' +
    'Omit Agent model unless that metadata lists the exact current id.'
  )
}

/**
 * True when an edit_workflow LLM result still requires a repair edit.
 */
export function editResultNeedsFollowUp(llmFormattedJson: string): boolean {
  try {
    const parsed = JSON.parse(llmFormattedJson) as Record<string, unknown>
    return parsed.needsFollowUpEdit === true || parsed.needsFollowUpPopulate === true
  } catch {
    return false
  }
}

/**
 * Whether the workspace already has a usable Gmail/Google Email OAuth credential.
 */
export function workspaceHasGmailCredential(
  connected: Array<{ providerId: string }> | undefined
): boolean {
  if (!connected?.length) return false
  return connected.some((item) => {
    const id = item.providerId.toLowerCase()
    return (
      id.includes('google-email') ||
      id.includes('gmail') ||
      id === 'google-email' ||
      id.endsWith('/gmail')
    )
  })
}

function normalizeCompletionText(text: string): string {
  return text
    .toLowerCase()
    .replace(/<options>[\s\S]*?<\/options>/gi, '')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[^a-z0-9→\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * Detects repeated "workflow is built / connect Gmail" completion paragraphs.
 * Pass only text from *earlier rounds* as `previous` — never the current round's
 * own growing prefix (that falsely suppresses the first completion mid-stream).
 */
export function isNearDuplicateCompletion(previous: string, next: string): boolean {
  const a = normalizeCompletionText(previous)
  const b = normalizeCompletionText(next)
  if (!a || !b) return false

  // Earlier round already looked like a full completion — any new completion
  // pitch is a duplicate (do not wait for both sides to hit 100 chars).
  if (contentLooksLikeCompletion(previous) && b.length >= 40) {
    const bMarkers = COMPLETION_MARKERS.filter((marker) =>
      b.includes(normalizeCompletionText(marker))
    ).length
    if (bMarkers >= 1) return true
  }

  if (b.length < 100 || a.length < 100) return false

  const aMarkers = COMPLETION_MARKERS.filter((marker) =>
    a.includes(normalizeCompletionText(marker))
  ).length
  const bMarkers = COMPLETION_MARKERS.filter((marker) =>
    b.includes(normalizeCompletionText(marker))
  ).length
  if (aMarkers >= 2 && bMarkers >= 2) return true

  const probe = b.slice(0, Math.min(160, b.length))
  return probe.length >= 80 && a.includes(probe)
}

/**
 * Mid-turn scaffolding the model often emits alone ("Let me retry…") before the
 * next tool round. Streaming these leaves the settled bubble looking empty once
 * tool rows collapse — keep them in the LLM transcript only.
 */
const BRIDGING_NARRATION_PATTERN =
  /^(?:okay[,.]?\s+|ok[,.]?\s+|sure[,.]?\s+|alright[,.]?\s+)?(?:let me|i(?:'| a)?m going to|i(?:'| wi)?ll|i need to|now i(?:'| wi)?ll|one (?:sec|moment|second)|hang on|give me a (?:sec|moment|second))\b[\s\S]{0,160}$/i

/**
 * Model announced a mutation ("Now applying…") but produced no tool call.
 * Treat as bridging so the turn does not settle on intent-only prose.
 */
const MUTATION_INTENT_NARRATION_PATTERN =
  /^(?:okay[,.]?\s+|ok[,.]?\s+|sure[,.]?\s+|alright[,.]?\s+|now[,.]?\s+)?(?:(?:i(?:'| a)?m |i(?:'| wi)?ll |let me )+)?(?:now\s+)?(?:applying|editing|updating|fixing|redeploying|deploying|wiring|patching|saving|assembling|creating|ingesting|writing)\b[\s\S]{0,220}$/i

const POLITE_BRIDGING_PREFIX =
  /^(?:okay[,.]?\s+|ok[,.]?\s+|sure[,.]?\s+|alright[,.]?\s+|now[,.]?\s+)/i
const BARE_POLITE_TOKEN = /^(?:okay|ok|sure|alright|now)[,.]?$/i

/**
 * Known openers for tool-bridging narration. Used to hold incomplete streaming
 * prefixes (e.g. "Let") before the full "Let me…" phrase exists.
 */
const BRIDGING_OPENERS = [
  'let me',
  "i'm going to",
  'i am going to',
  "i'll",
  'i will',
  'i need to',
  "now i'll",
  'now i will',
  'one sec',
  'one moment',
  'one second',
  'hang on',
  'give me a sec',
  'give me a moment',
  'give me a second',
  'retrying',
  're-trying',
  'trying again',
  'applying',
  'editing',
  'updating',
  'fixing',
  'redeploying',
  'deploying',
  'wiring',
  'patching',
  'saving',
] as const

/**
 * True when text is only a partial opener for bridging narration (e.g. "Let").
 * Streaming these before tools creates orphan mothership bubbles.
 */
export function isIncompleteBridgingPrefix(text: string): boolean {
  const normalized = text.replace(/\s+/g, ' ').trim().toLowerCase()
  if (!normalized || normalized.length > 48) return false
  if (BARE_POLITE_TOKEN.test(normalized)) return true

  const body = normalized.replace(POLITE_BRIDGING_PREFIX, '').trim()
  if (!body) return true

  return BRIDGING_OPENERS.some((opener) => opener.startsWith(body))
}

/**
 * True for a single short token that is almost certainly mid-stream scaffolding
 * ("I", "So", "I'll") rather than a finished reply.
 */
export function isLikelyMidStreamToken(text: string): boolean {
  const normalized = text.replace(/\s+/g, ' ').trim()
  return /^[A-Za-z][A-Za-z']{0,11}$/.test(normalized)
}

/**
 * True when prose is only a short bridge into more tool work, not a real answer.
 */
export function isBridgingAssistantNarration(text: string): boolean {
  const normalized = text.replace(/\s+/g, ' ').trim()
  if (!normalized) return false
  if (normalized.length > 220) return false
  if (isIncompleteBridgingPrefix(normalized)) return true
  if (BRIDGING_NARRATION_PATTERN.test(normalized)) return true
  if (MUTATION_INTENT_NARRATION_PATTERN.test(normalized)) return true
  // Explicit retry / re-call lines without a substantive finding.
  return /^(?:retrying|re-?trying|trying again)\b[\s\S]{0,120}$/i.test(normalized)
}

/**
 * True when the model narrated an imminent edit/deploy/run but did not call a tool.
 */
export function isUnfulfilledMutationIntentNarration(text: string): boolean {
  const normalized = text.replace(/\s+/g, ' ').trim()
  if (!normalized || normalized.length > 220) return false
  return MUTATION_INTENT_NARRATION_PATTERN.test(normalized)
}

/**
 * System nudge when the model described a mutation without issuing the tool call.
 */
export function buildUnfulfilledIntentContinuationMessage(): string {
  return (
    '[System] You described applying/editing/deploying changes but did not call a tool. ' +
    'Call the required tool now (usually edit_workflow, or redeploy/deploy_chat if that was the next step). ' +
    'Do not only narrate the plan.'
  )
}

/**
 * System nudge when log/debug tools finished but the model returned no user-facing explanation.
 */
export function buildDebugExplanationContinuationMessage(): string {
  return (
    '[System] You already fetched execution logs / error analysis. ' +
    'Reply to the user NOW with a clear plain-language explanation of why the workflow failed, ' +
    'which block failed, and what to fix. Do not call more tools unless a critical detail is still missing.'
  )
}

/**
 * System nudge when block discovery finished but create/edit never ran.
 */
export function buildWorkflowBuildContinuationMessage(): string {
  return (
    '[System] You already called get_available_blocks / get_blocks_metadata (and maybe load_copilot_artifact) ' +
    'but have not created or edited a workflow yet. Call create_workflow (if needed) then edit_workflow NOW ' +
    'to add the blocks for the user request. Do not stop after discovery tools and do not only narrate the plan.'
  )
}

/**
 * System nudge when create_workflow succeeded but populate never started.
 */
export function buildIncompleteWorkflowPopulateContinuationMessage(): string {
  return (
    '[System] create_workflow already succeeded this turn but edit_workflow has not populated it yet. ' +
    'Call edit_workflow NOW. Do not call get_blocks_metadata or load_copilot_artifact again if metadata was already returned. ' +
    'A daily time trigger is block type "schedule" (scheduleType "daily", dailyTime "09:00", timezone "Asia/Kolkata" for IST) — never "schedule_trigger". ' +
    'Omit Agent model unless metadata lists that exact current id. Do not create another workflow.'
  )
}

/** Tools that only re-fetch block schemas and must not consume the populate budget. */
const PRE_POPULATE_DISCOVERY_TOOLS = new Set(['get_blocks_metadata', 'load_copilot_artifact'])

/**
 * True for metadata / artifact reloads that run before the first successful populate edit.
 */
export function isPrePopulateDiscoveryTool(toolName: string): boolean {
  return PRE_POPULATE_DISCOVERY_TOOLS.has(toolName)
}

/**
 * Whether a discovery call may run before the first successful populate edit.
 * `ignore` means the cap does not apply (not a discovery tool, or populate already started).
 */
export function admitPrePopulateDiscovery(options: {
  createdWorkflowThisTurn: boolean
  successfulPopulateEdits: number
  discoveryCallsSoFar: number
  toolName: string
}): 'allow' | 'reject' | 'ignore' {
  if (!isPrePopulateDiscoveryTool(options.toolName)) return 'ignore'
  if (!options.createdWorkflowThisTurn || options.successfulPopulateEdits > 0) return 'ignore'
  if (options.discoveryCallsSoFar >= MAX_PRE_POPULATE_DISCOVERY_CALLS) return 'reject'
  return 'allow'
}

/**
 * True when a discovery-only round should not consume a tool-iteration slot.
 * Rejected discovery rounds are not refunded, so a model that ignores the block cannot loop forever.
 */
export function shouldRefundPrePopulateDiscoveryRound(options: {
  createdWorkflowThisTurn: boolean
  successfulPopulateEdits: number
  roundToolNames: string[]
  refundsSoFar: number
  hadRejectedDiscovery: boolean
}): boolean {
  if (options.hadRejectedDiscovery) return false
  if (!options.createdWorkflowThisTurn || options.successfulPopulateEdits > 0) return false
  if (options.refundsSoFar >= MAX_PRE_POPULATE_DISCOVERY_ROUND_REFUNDS) return false
  if (options.roundToolNames.length === 0) return false
  return options.roundToolNames.every((name) => isPrePopulateDiscoveryTool(name))
}

/**
 * Instruction returned when further metadata / artifact reloads are blocked.
 */
export function buildPrePopulateDiscoveryBlockedMessage(): string {
  return (
    'Block metadata for this new workflow is already loaded. ' +
    'Do not call get_blocks_metadata or load_copilot_artifact again. Call edit_workflow now. ' +
    'A daily time trigger is block type "schedule" (scheduleType "daily", dailyTime "09:00", timezone "Asia/Kolkata" for IST) — never "schedule_trigger". ' +
    'Omit Agent model unless the metadata you already have lists that exact current id.'
  )
}

/**
 * Soft wrap-up nudge: populate edits hit the soft ceiling but tools stay available
 * until the model settles or the hard lock fires.
 */
export function buildWorkflowBuildSoftCompleteSystemMessage(): string {
  return (
    '[System] You have already made several successful edit_workflow populate calls this turn. ' +
    'If the graph still needs more blocks or wires for the user request, finish those edits now. ' +
    'Otherwise stop tools and reply once with a short summary (display names only) and at most one <options> block.'
  )
}

/**
 * True when prose only narrates inspecting a file (read/grep/see) without
 * claiming a completed fix — including multi-sentence bridges that exceed the
 * short {@link isBridgingAssistantNarration} length cap.
 */
export function isFileInspectionBridgeNarration(text: string): boolean {
  const normalized = text.replace(/\s+/g, ' ').trim()
  if (!normalized) return true
  if (isBridgingAssistantNarration(normalized)) return true
  if (/\b(fixed|patched|updated the|applied the|search[_ ]replace)\b/i.test(normalized)) {
    return false
  }
  return /\b(let me (see|read|grep|check|inspect|look)|need to see|looking at|grepping|inspect(?:ing|ion)|narrowly)\b/i.test(
    normalized
  )
}

/**
 * System nudge when file inspection finished but workspace_file / edit_content never ran.
 */
export function buildFileEditContinuationMessage(): string {
  return (
    '[System] You already read/grepped (and maybe load_copilot_artifact) but have not applied the fix. ' +
    'STOP paging the source with more offset/limit reads. Call workspace_file (patch/update) then ' +
    'edit_content NOW — one targeted patch into the destination (e.g. empty KPIs shell / insert anchor). ' +
    'Prefer a single fat edit with the needed markup/seed data over reassembling the standalone via many reads. ' +
    'Do not dump HTML/JS into chat. Do not end the turn on Thinking after inspection tools.'
  )
}

/**
 * True when file inspection ran without a write and the model stopped with no
 * real reply — force another round so toggle/HTML fixes do not stall on Thinking….
 */
export function shouldForceFileEditContinuation(options: {
  postBuildToolMode: PostBuildToolMode
  forcedFileEditContinuations: number
  maxForcedFileEditContinuations: number
  round: number
  maxToolRounds: number
  hasFileInspectionTools: boolean
  hasFileMutationTools: boolean
  streamedUserFacingText: string
  roundDisplayText: string
}): boolean {
  if (options.postBuildToolMode !== 'all') return false
  if (!options.hasFileInspectionTools || options.hasFileMutationTools) return false
  if (options.forcedFileEditContinuations >= options.maxForcedFileEditContinuations) return false
  if (options.round >= options.maxToolRounds - 1) return false

  const streamed = stripOptionsTagsForDisplay(options.streamedUserFacingText, false).trim()
  if (streamed && !isFileInspectionBridgeNarration(streamed)) return false

  const roundDisplay = stripOptionsTagsForDisplay(options.roundDisplayText, false).trim()
  if (roundDisplay && !isFileInspectionBridgeNarration(roundDisplay)) return false

  return true
}

/**
 * True when debug tools ran and the turn would otherwise settle with no real reply.
 */
export function shouldForceDebugExplanationContinuation(options: {
  postBuildToolMode: PostBuildToolMode
  forcedDebugExplanations: number
  maxForcedDebugExplanations: number
  round: number
  maxToolRounds: number
  hasDebugTools: boolean
  streamedUserFacingText: string
  roundDisplayText: string
}): boolean {
  if (options.postBuildToolMode !== 'all') return false
  if (!options.hasDebugTools) return false
  if (options.forcedDebugExplanations >= options.maxForcedDebugExplanations) return false
  if (options.round >= options.maxToolRounds - 1) return false

  const streamed = stripOptionsTagsForDisplay(options.streamedUserFacingText, false).trim()
  if (streamed && !isBridgingAssistantNarration(streamed)) return false

  const roundDisplay = stripOptionsTagsForDisplay(options.roundDisplayText, false).trim()
  if (roundDisplay && !isBridgingAssistantNarration(roundDisplay)) return false

  return true
}

/**
 * True when workflow discovery tools ran without create/edit and the model
 * stopped with no tools — force another round so chat does not settle empty.
 */
export function shouldForceWorkflowBuildContinuation(options: {
  postBuildToolMode: PostBuildToolMode
  forcedWorkflowBuildContinuations: number
  maxForcedWorkflowBuildContinuations: number
  round: number
  maxToolRounds: number
  hasDiscoveryTools: boolean
  hasMutationTools: boolean
  streamedUserFacingText: string
  roundDisplayText: string
}): boolean {
  if (options.postBuildToolMode !== 'all') return false
  if (!options.hasDiscoveryTools || options.hasMutationTools) return false
  if (options.forcedWorkflowBuildContinuations >= options.maxForcedWorkflowBuildContinuations) {
    return false
  }
  if (options.round >= options.maxToolRounds - 1) return false

  const streamed = stripOptionsTagsForDisplay(options.streamedUserFacingText, false).trim()
  if (streamed && !isBridgingAssistantNarration(streamed)) return false

  const roundDisplay = stripOptionsTagsForDisplay(options.roundDisplayText, false).trim()
  if (roundDisplay && !isBridgingAssistantNarration(roundDisplay)) return false

  return true
}

/**
 * True when create_workflow ran this turn but no successful populate edit yet —
 * and mandatory follow-ups are somehow empty — so the turn does not settle on
 * an empty shell.
 */
export function shouldForceIncompleteWorkflowPopulateContinuation(options: {
  postBuildToolMode: PostBuildToolMode
  createdWorkflowThisTurn: boolean
  successfulPopulateEdits: number
  pendingFollowUpCount: number
  forcedIncompletePopulateContinuations: number
  maxForcedIncompletePopulateContinuations: number
  round: number
  maxToolRounds: number
}): boolean {
  if (options.postBuildToolMode !== 'all') return false
  if (!options.createdWorkflowThisTurn) return false
  if (options.successfulPopulateEdits > 0) return false
  if (options.pendingFollowUpCount > 0) return false
  if (
    options.forcedIncompletePopulateContinuations >=
    options.maxForcedIncompletePopulateContinuations
  ) {
    return false
  }
  if (options.round >= options.maxToolRounds - 1) return false
  return true
}

/**
 * True when a workflow-build turn must leave a user-visible closing message —
 * incomplete create/populate, unresolved follow-ups, or empty/bridging prose
 * after discovery/mutation tools.
 */
export function shouldEnsureWorkflowBuildClosingMessage(options: {
  hasDiscoveryTools: boolean
  hasMutationTools: boolean
  createdWorkflowThisTurn: boolean
  successfulPopulateEdits: number
  pendingFollowUpCount: number
  streamedUserFacingText: string
}): boolean {
  if (!options.hasDiscoveryTools && !options.hasMutationTools) return false

  if (options.createdWorkflowThisTurn && options.successfulPopulateEdits === 0) return true
  if (options.pendingFollowUpCount > 0) return true

  const visible = stripOptionsTagsForDisplay(options.streamedUserFacingText, false).trim()
  if (!visible || isBridgingAssistantNarration(visible)) return true

  return false
}

/**
 * Closing copy when the turn still has unresolved mandatory follow-ups.
 */
export function buildUnresolvedFollowUpClosingMessage(
  pending: Array<{ hint: string }>
): string | null {
  if (pending.length === 0) return null
  const hint = pending[0]?.hint?.trim()
  if (hint) {
    return `I made partial progress but still need to finish: ${hint}`
  }
  return 'I made partial progress but still need another step to finish the request. Please continue in chat.'
}

/**
 * System nudge when research/factual intent settled without a live web search.
 */
export function buildResearchSearchContinuationMessage(): string {
  return (
    '[System] This is a real-world / current factual question. ' +
    'You must call search_online({ query, toolTitle }) OR ' +
    'invoke_integration_tool({ toolId: "exa_answer", params: { query } }) NOW ' +
    'before answering. Do not answer from training memory. ' +
    'After the tool returns, reply using only those live results.'
  )
}

/**
 * True when a tool call is a live Exa / web search (search_online or exa_* invoke).
 */
export function isLiveWebSearchToolCall(name: string, argumentsJson?: string): boolean {
  if (name === 'search_online') return true
  if (name !== 'invoke_integration_tool') return false
  if (!argumentsJson) return false
  try {
    const args = JSON.parse(argumentsJson) as { toolId?: unknown }
    const toolId = typeof args.toolId === 'string' ? args.toolId.trim() : ''
    return toolId === 'exa_search' || toolId === 'exa_answer'
  } catch {
    return false
  }
}

/**
 * True when research/factual intent tried to settle without calling a live search tool.
 * Forces even if the model already streamed a memory answer — that is the failure mode.
 */
export function shouldForceResearchSearchContinuation(options: {
  postBuildToolMode: PostBuildToolMode
  needsLiveSearch: boolean
  forcedResearchSearchContinuations: number
  maxForcedResearchSearchContinuations: number
  round: number
  maxToolRounds: number
  hasLiveWebSearch: boolean
}): boolean {
  if (options.postBuildToolMode !== 'all') return false
  if (!options.needsLiveSearch) return false
  if (options.hasLiveWebSearch) return false
  if (options.forcedResearchSearchContinuations >= options.maxForcedResearchSearchContinuations) {
    return false
  }
  if (options.round >= options.maxToolRounds - 1) return false
  return true
}

/**
 * Whether buffered model prose for this round should be streamed to the UI.
 * Tool rounds keep text in the LLM transcript only — streaming it between tool
 * batches creates repeated "Arena Copilot" mothership headers. Bridging
 * narration is also held back so a later synthesize/summary can own the bubble.
 */
export function shouldStreamAssistantRoundText(options: {
  hasToolCalls: boolean
  contentBeforeRound: string
  display: string
}): boolean {
  if (!options.display.trim()) return false
  if (options.hasToolCalls) return false
  if (isBridgingAssistantNarration(options.display)) return false
  // Prior round already delivered the post-build pitch — do not stream another.
  if (contentLooksLikeCompletion(options.contentBeforeRound)) return false
  if (
    options.contentBeforeRound.trim().length > 120 &&
    isNearDuplicateCompletion(options.contentBeforeRound, options.display)
  ) {
    return false
  }
  return true
}

export interface AssistantRoundTextStreamerOptions {
  /** When true, hold short bridging narration until it grows into a real reply. */
  toolsAvailable: boolean
  /** User-visible prose already streamed in earlier rounds of this turn. */
  contentBeforeRound: string
}

export interface AssistantRoundTextStreamer {
  /** Raw model text accumulated this round (including options tags). */
  readonly roundRawText: string
  /** True after a tool_call chunk was observed — further text stays transcript-only. */
  readonly sawToolCall: boolean
  /** Append a cleaned text chunk; returns a UI delta when live streaming is allowed. */
  pushText: (cleaned: string) => string | null
  /** Stop live streaming for the rest of the round (tool call observed). */
  markToolCall: () => void
  /**
   * Final display text + any remainder delta after options tags resolve.
   * `remainder` is null when the round should not show user-facing prose.
   */
  finalize: () => { display: string; remainder: string | null }
}

/**
 * Incremental assistant-text emitter for one model round.
 *
 * Streams token deltas live for real replies (holding incomplete `<options>` and
 * short bridging narration when tools are still available). Stops emitting once a
 * tool call appears so tool batches do not open repeated mothership headers.
 */
export function createAssistantRoundTextStreamer(
  options: AssistantRoundTextStreamerOptions
): AssistantRoundTextStreamer {
  let roundRawText = ''
  let emittedDisplay = ''
  let sawToolCall = false

  const toDisplay = (raw: string, isStreaming: boolean) =>
    stripIdsFromUserFacingText(
      stripOptionsTagsForDisplay(stripUntrustedSecurityControls(raw, isStreaming), isStreaming)
    )

  const deltaFrom = (display: string): string | null => {
    if (!display) return null
    if (display === emittedDisplay) return null
    if (display.startsWith(emittedDisplay)) {
      const delta = display.slice(emittedDisplay.length)
      if (!delta) return null
      emittedDisplay = display
      return delta
    }
    // Display rewrite shortened/replaced an earlier prefix (rare); emit the new tail only
    // when the previous emission is empty, otherwise skip to avoid duplicated prose.
    if (!emittedDisplay) {
      emittedDisplay = display
      return display
    }
    emittedDisplay = display
    return null
  }

  const streamer: AssistantRoundTextStreamer = {
    get roundRawText() {
      return roundRawText
    },
    get sawToolCall() {
      return sawToolCall
    },
    pushText(cleaned: string) {
      if (!cleaned) return null
      roundRawText += cleaned
      if (sawToolCall) return null

      const display = toDisplay(roundRawText, true)
      if (!display) return null

      // With tools available, hold "Let me…" scaffolding (and incomplete prefixes
      // like "Let" / "I" / "So") until it is clearly a real reply — otherwise
      // mothership opens orphan bubbles when tools interrupt mid-sentence.
      if (
        options.toolsAvailable &&
        (isBridgingAssistantNarration(display) || isLikelyMidStreamToken(display))
      ) {
        return null
      }

      if (contentLooksLikeCompletion(options.contentBeforeRound)) {
        return null
      }

      if (
        options.contentBeforeRound.trim().length > 120 &&
        isNearDuplicateCompletion(options.contentBeforeRound, display)
      ) {
        return null
      }

      return deltaFrom(display)
    },
    markToolCall() {
      sawToolCall = true
    },
    finalize() {
      const display = toDisplay(roundRawText, false)
      if (
        !shouldStreamAssistantRoundText({
          hasToolCalls: sawToolCall,
          contentBeforeRound: options.contentBeforeRound,
          display,
        })
      ) {
        return { display, remainder: null }
      }

      const remainder = deltaFrom(display)
      return { display, remainder }
    },
  }

  return streamer
}

/**
 * True when the only user-visible prose so far is empty or bridging, so a tool
 * turn should synthesize a real closing summary instead of settling on it.
 * Also true for incomplete workflow builds (create without populate, or
 * unresolved mandatory follow-ups) even when mid-progress prose already exists.
 */
export function shouldSynthesizeAssistantSummary(options: {
  streamedUserFacingText: string
  toolRecordCount: number
  /** create_workflow succeeded this turn but no clean populate edit yet. */
  createdWithoutPopulate?: boolean
  /** Mandatory follow-ups still pending when the tool loop exited. */
  unresolvedFollowUpCount?: number
}): boolean {
  if (options.toolRecordCount <= 0) return false
  if (options.createdWithoutPopulate) return true
  if ((options.unresolvedFollowUpCount ?? 0) > 0) return true
  const streamed = stripOptionsTagsForDisplay(options.streamedUserFacingText, false).trim()
  if (!streamed) return true
  return isBridgingAssistantNarration(streamed)
}

const EMPTY_ASSISTANT_TURN_FALLBACK =
  'I finished that step but had nothing to show. Please try again.'
const MALFORMED_FUNCTION_CALL_FALLBACK =
  'I tried to take an action, but the model returned an invalid tool call. Please try again.'

/**
 * True when the turn produced neither user-facing prose nor tools, so the chat
 * would otherwise persist a blank assistant row.
 */
export function shouldEmitEmptyAssistantFallback(options: {
  streamedUserFacingText: string
  toolRecordCount: number
}): boolean {
  return (
    options.toolRecordCount <= 0 &&
    stripOptionsTagsForDisplay(options.streamedUserFacingText, false).trim().length === 0
  )
}

/**
 * User-visible copy when a Local Copilot turn would otherwise settle empty.
 */
export function emptyAssistantTurnFallback(options?: { finishReason?: string }): string {
  return options?.finishReason === 'MALFORMED_FUNCTION_CALL'
    ? MALFORMED_FUNCTION_CALL_FALLBACK
    : EMPTY_ASSISTANT_TURN_FALLBACK
}

/**
 * True when every pending mandatory follow-up is OAuth connect (not an edit repair).
 */
export function pendingFollowUpsAreOauthOnly(pending: Array<{ resolveWith: string[] }>): boolean {
  return (
    pending.length > 0 &&
    pending.every(
      (item) =>
        item.resolveWith.length > 0 &&
        item.resolveWith.every((toolName) => toolName === 'oauth_get_auth_link')
    )
  )
}
