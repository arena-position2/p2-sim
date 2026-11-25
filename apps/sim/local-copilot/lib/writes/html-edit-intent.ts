/**
 * Detects HTML *edit* follow-ups (vs analysis-only) and extracts grep tokens
 * so the orchestrator can force grep → patch (and strip inspect tools once
 * write-forced) instead of endless search thrash.
 */

/** Analysis-only asks should not force a write path. */
const HTML_ANALYSIS_ONLY_PATTERN =
  /\b((give|provide|share|list|what are|any)\b[\s\S]{0,60}\b(suggestion|suggestions|feedback|ideas|improvements|review)\b|\bux suggestions?\b|\bread\b[\s\S]{0,40}\bcarefully\b|\banaly[sz]e\b|\bcritique\b|\bwhat do you think\b|\bhow (does|do|is|would)\b)/i

/** Clear edit / implement signals (including "3rd point" follow-ups). */
const HTML_EDIT_SIGNAL_PATTERN =
  /\b(apply|change|update|fix|edit|implement|improve|enhance|rewrite|patch|modify|adjust|tweak|make (it|the|this)|let'?s (do|move|apply|implement|go)|go ahead|move to (the )?(point|\d)|do (the )?(point|\d|third|3rd|second|2nd|first|1st)|point\s*[#]?\s*\d+|suggestion\s*[#]?\s*\d+)\b/i

const HTML_MAKE_BETTER_PATTERN =
  /\bmake\b[\s\S]{0,40}\b(better|stronger|bigger|green|bold|clearer|more|prominent)\b/i

const HTML_MENTION_PATTERN = /\b(\.html?\b|html\b|the page|this page|the file)\b/i

const TOKEN_STOPWORDS = new Set([
  'the',
  'a',
  'an',
  'and',
  'or',
  'to',
  'of',
  'for',
  'with',
  'this',
  'that',
  'please',
  'just',
  'also',
  'html',
  'file',
  'page',
  'point',
  'suggestion',
  'suggestions',
])

/** After empty greps: ban more search/sandbox thrash; keep `read` for one live excerpt. */
export const HTML_EDIT_SEARCH_SUPPRESSED_TOOLS = new Set([
  'grep',
  'glob',
  'function_execute',
  'manage_sandbox',
])

/** After inspection-threshold write force: ban all inspect/sandbox tools. */
export const HTML_EDIT_WRITE_SUPPRESSED_TOOLS = new Set([
  'read',
  'grep',
  'glob',
  'load_copilot_artifact',
  'function_execute',
  'manage_sandbox',
])

export type HtmlEditToolSuppressMode = 'none' | 'search' | 'write'

const FILE_INSPECTION_TOOL_NAMES = new Set(['read', 'grep', 'glob', 'load_copilot_artifact'])

/**
 * True when the user is asking to change HTML (not only review / suggest).
 */
export function looksLikeHtmlEditIntent(message: string): boolean {
  const text = message.trim()
  if (!text) return false
  if (HTML_EDIT_SIGNAL_PATTERN.test(text) || HTML_MAKE_BETTER_PATTERN.test(text)) return true
  return false
}

/**
 * True when the message is analysis/suggestions only (no implement signal).
 */
export function looksLikeHtmlAnalysisOnly(message: string): boolean {
  const text = message.trim()
  if (!text) return false
  return HTML_ANALYSIS_ONLY_PATTERN.test(text) && !looksLikeHtmlEditIntent(text)
}

/**
 * True when the turn context is HTML (active doc path or user mentioned HTML/page).
 */
export function hasHtmlEditContext(options: {
  userMessage: string
  preferredPath?: string | null
  candidatePaths?: readonly string[]
}): boolean {
  if (HTML_MENTION_PATTERN.test(options.userMessage)) return true
  const paths = [options.preferredPath, ...(options.candidatePaths ?? [])].filter(
    (path): path is string => typeof path === 'string' && path.trim().length > 0
  )
  return paths.some((path) => /\.html?(?:\/content)?$/i.test(path.trim()))
}

/**
 * Pulls quoted phrases and a few UI keywords from the user message for grep.
 */
export function extractHtmlEditGrepTokens(message: string): string[] {
  const tokens: string[] = []
  const seen = new Set<string>()
  const add = (raw: string) => {
    const token = raw.replace(/\s+/g, ' ').trim()
    if (token.length < 2 || token.length > 80) return
    const key = token.toLowerCase()
    if (TOKEN_STOPWORDS.has(key) || seen.has(key)) return
    seen.add(key)
    tokens.push(token)
  }

  for (const match of message.matchAll(/["“”']([^"'“”]{2,80})["“”']/g)) {
    add(match[1] ?? '')
  }
  for (const match of message.matchAll(
    /\b(Generate Ad|Call to Action|CTA|Brand Logo|template|headline|subtitle)\b/gi
  )) {
    add(match[1] ?? '')
  }

  return tokens.slice(0, 6)
}

/**
 * System nudge: stop blind read paging; grep user tokens then patch once.
 */
export function buildHtmlEditGrepNudgeMessage(tokens: string[]): string {
  const tokenHint =
    tokens.length > 0
      ? `Call grep first for these tokens from the user/context: ${tokens
          .map((token) => JSON.stringify(token))
          .join(', ')}`
      : 'Call grep first for a distinctive label of the change (button text, heading, id, or class from your earlier suggestions) — not a blind large offset/limit read'

  return (
    `[System] HTML edit follow-up: ${tokenHint}. ` +
    'Then ONE workspace_file operation=patch with a short unique live substring (max 600 chars), then edit_content with only the replacement. ' +
    'Do not keep paging with read offset/limit before grepping. Do not dump HTML into chat.'
  )
}

/**
 * Counts successful file-inspection tool calls this turn.
 */
export function countSuccessfulFileInspections(
  records: ReadonlyArray<{ name: string; success: boolean }>
): number {
  return records.filter((record) => record.success && FILE_INSPECTION_TOOL_NAMES.has(record.name))
    .length
}

/**
 * True when a successful grep result has zero matches / zero hit counts.
 */
export function isEmptyGrepResult(result: unknown): boolean {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return false
  const record = result as Record<string, unknown>
  const payload =
    record.output && typeof record.output === 'object' && !Array.isArray(record.output)
      ? (record.output as Record<string, unknown>)
      : record

  if (Array.isArray(payload.matches)) return payload.matches.length === 0
  if (Array.isArray(payload.files)) return payload.files.length === 0
  if (Array.isArray(payload.counts)) {
    if (payload.counts.length === 0) return true
    return payload.counts.every((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return true
      const count = (entry as Record<string, unknown>).count
      return typeof count === 'number' ? count === 0 : true
    })
  }
  return false
}

/**
 * Counts successful greps this turn that returned no hits.
 */
export function countEmptyGreps(
  records: ReadonlyArray<{ name: string; success: boolean; result?: unknown }>
): number {
  return records.filter(
    (record) => record.name === 'grep' && record.success && isEmptyGrepResult(record.result)
  ).length
}

/**
 * Soft orchestration: edit-intent turn inspected with read only (no grep yet).
 * Bridge narration is intentionally ignored — prose must not block the force.
 */
export function shouldForceHtmlEditGrepNudge(options: {
  postBuildToolMode: string
  forcedHtmlEditGrepNudges: number
  maxForcedHtmlEditGrepNudges: number
  round: number
  maxToolRounds: number
  userMessage: string
  hasHtmlContext: boolean
  hasSuccessfulRead: boolean
  hasSuccessfulGrep: boolean
  hasFileMutationTools: boolean
}): boolean {
  if (options.postBuildToolMode !== 'all') return false
  if (options.forcedHtmlEditGrepNudges >= options.maxForcedHtmlEditGrepNudges) return false
  if (options.round >= options.maxToolRounds - 1) return false
  if (options.hasFileMutationTools) return false
  if (!options.hasHtmlContext) return false
  if (!looksLikeHtmlEditIntent(options.userMessage)) return false
  if (looksLikeHtmlAnalysisOnly(options.userMessage)) return false
  if (!options.hasSuccessfulRead || options.hasSuccessfulGrep) return false
  return true
}

/**
 * After enough inspections on an HTML edit turn, force workspace_file instead of more paging.
 */
export function shouldForceHtmlEditWriteNudge(options: {
  postBuildToolMode: string
  forcedHtmlEditWriteNudges: number
  maxForcedHtmlEditWriteNudges: number
  inspectionsBeforeWriteNudge: number
  inspectionCount: number
  round: number
  maxToolRounds: number
  userMessage: string
  hasHtmlContext: boolean
  hasFileMutationTools: boolean
}): boolean {
  if (options.postBuildToolMode !== 'all') return false
  if (options.forcedHtmlEditWriteNudges >= options.maxForcedHtmlEditWriteNudges) return false
  if (options.round >= options.maxToolRounds - 1) return false
  if (options.hasFileMutationTools) return false
  if (!options.hasHtmlContext) return false
  if (!looksLikeHtmlEditIntent(options.userMessage)) return false
  if (looksLikeHtmlAnalysisOnly(options.userMessage)) return false
  if (options.inspectionCount < options.inspectionsBeforeWriteNudge) return false
  return true
}

/**
 * After repeated empty greps, stop searching and force preferred-path read+write.
 */
export function shouldForceHtmlEditWriteAfterEmptyGreps(options: {
  postBuildToolMode: string
  forcedHtmlEditWriteNudges: number
  maxForcedHtmlEditWriteNudges: number
  emptyGrepCount: number
  emptyGrepsBeforeWriteNudge: number
  round: number
  maxToolRounds: number
  userMessage: string
  hasHtmlContext: boolean
  hasFileMutationTools: boolean
}): boolean {
  if (options.postBuildToolMode !== 'all') return false
  if (options.forcedHtmlEditWriteNudges >= options.maxForcedHtmlEditWriteNudges) return false
  if (options.round >= options.maxToolRounds - 1) return false
  if (options.hasFileMutationTools) return false
  if (!options.hasHtmlContext) return false
  if (!looksLikeHtmlEditIntent(options.userMessage)) return false
  if (looksLikeHtmlAnalysisOnly(options.userMessage)) return false
  if (options.emptyGrepCount < options.emptyGrepsBeforeWriteNudge) return false
  return true
}

/**
 * True when write nudges are exhausted and the turn should stop without more explore.
 */
export function shouldStopHtmlEditWithoutWrite(options: {
  forcedHtmlEditWriteNudges: number
  maxForcedHtmlEditWriteNudges: number
  inspectionsBeforeWriteNudge: number
  inspectionCount: number
  userMessage: string
  hasHtmlContext: boolean
  hasFileMutationTools: boolean
}): boolean {
  if (options.hasFileMutationTools) return false
  if (!options.hasHtmlContext) return false
  if (!looksLikeHtmlEditIntent(options.userMessage)) return false
  if (looksLikeHtmlAnalysisOnly(options.userMessage)) return false
  if (options.inspectionCount < options.inspectionsBeforeWriteNudge) return false
  return options.forcedHtmlEditWriteNudges >= options.maxForcedHtmlEditWriteNudges
}

/**
 * System nudge: stop inspecting; call workspace_file patch now.
 */
export function buildHtmlEditWriteNudgeMessage(options: {
  tokens: string[]
  preferredPath?: string | null
  attempt: number
  maxAttempts: number
}): string {
  const pathHint = options.preferredPath?.trim() ? ` on ${options.preferredPath.trim()}` : ''
  const tokenHint =
    options.tokens.length > 0
      ? `Reuse a short live substring involving: ${options.tokens
          .map((token) => JSON.stringify(token))
          .join(', ')}.`
      : 'Copy a short unique live substring from your last grep/read (id, class, function name, or button label).'

  const lastAttempt =
    options.attempt >= options.maxAttempts
      ? ' This is the last forced write attempt — if you still cannot patch, stop and ask the user which label/function to change.'
      : ''

  return (
    `[System] HTML edit write nudge (${options.attempt}/${options.maxAttempts}): you already inspected the file enough${pathHint}. ` +
    'Do NOT call read, grep, glob, load_copilot_artifact, or function_execute — those tools are unavailable this round. ' +
    `Call workspace_file operation=patch with search_replace NOW (${tokenHint}), then edit_content with only the replacement. ` +
    'One targeted patch for the user ask — not a full rewrite.' +
    lastAttempt
  )
}

/**
 * System nudge after empty greps: one preferred-path read (if needed) then patch.
 */
export function buildHtmlEditEmptyGrepWriteNudgeMessage(options: {
  tokens: string[]
  preferredPath?: string | null
  attempt: number
  maxAttempts: number
}): string {
  const preferred = options.preferredPath?.trim()
  const contentPath = preferred
    ? preferred.endsWith('/content')
      ? preferred
      : `${preferred}/content`
    : null
  const readHint = contentPath
    ? `If you still lack a live substring, call read("${contentPath}") once with a tight offset/limit, then `
    : 'If you still lack a live substring, call read on the preferred HTML /content path once with a tight offset/limit, then '
  const tokenHint =
    options.tokens.length > 0
      ? `Prefer tokens: ${options.tokens.map((token) => JSON.stringify(token)).join(', ')}.`
      : 'Use a distinctive label from the user ask.'

  return (
    `[System] HTML edit empty-grep write nudge (${options.attempt}/${options.maxAttempts}): ` +
    'recent greps returned no matches — stop inventing new search patterns. ' +
    `${readHint}call workspace_file operation=patch with search_replace (${tokenHint}). ` +
    'Do NOT call grep/glob/function_execute again this round.'
  )
}

/**
 * User-facing closer when HTML edit write nudges are exhausted with no mutation.
 */
export function buildHtmlEditWriteGiveUpMessage(options: {
  tokens: string[]
  preferredPath?: string | null
  userMessage: string
}): string {
  const pathHint = options.preferredPath?.trim() ? ` in ${options.preferredPath.trim()}` : ''
  const focus =
    options.tokens.length > 0
      ? options.tokens.slice(0, 3).join(', ')
      : summarizeHtmlEditAsk(options.userMessage)
  return (
    `I inspected the HTML${pathHint} but did not finish applying the edit for: ${focus}. ` +
    'The file was left unchanged — reply with the exact button label, heading, or function name to patch ' +
    '(for example `go` / stepper tabs / Next button), or ask me to apply only one of those fixes.'
  )
}

/**
 * Strips search and/or inspect tools once an HTML edit turn is forced forward.
 * Never returns an empty list (Bedrock requires toolConfig when history has tools).
 */
export function filterHtmlEditForcedTools<T extends { name: string }>(
  tools: T[],
  mode: HtmlEditToolSuppressMode
): T[] {
  if (mode === 'none') return tools
  const suppressed =
    mode === 'write' ? HTML_EDIT_WRITE_SUPPRESSED_TOOLS : HTML_EDIT_SEARCH_SUPPRESSED_TOOLS
  const filtered = tools.filter((tool) => !suppressed.has(tool.name))
  return filtered.length > 0 ? filtered : tools
}

function summarizeHtmlEditAsk(message: string): string {
  const trimmed = message.replace(/\s+/g, ' ').trim()
  if (trimmed.length <= 80) return trimmed || 'your requested UX fix'
  return `${trimmed.slice(0, 77)}…`
}
