/**
 * Detects HTML *edit* follow-ups (vs analysis-only) and extracts grep tokens
 * so the orchestrator can soft-nudge read-paging turns toward grep → patch.
 */

/** Analysis-only asks should not force a write path. */
const HTML_ANALYSIS_ONLY_PATTERN =
  /\b((give|provide|share|list|what are|any)\b[\s\S]{0,60}\b(suggestion|suggestions|feedback|ideas|improvements|review)\b|\bux suggestions?\b|\bread\b[\s\S]{0,40}\bcarefully\b|\banaly[sz]e\b|\bcritique\b|\bwhat do you think\b|\bhow (does|do|is|would)\b)/i

/** Clear edit / implement signals (including "3rd point" follow-ups). */
const HTML_EDIT_SIGNAL_PATTERN =
  /\b(apply|change|update|fix|edit|implement|improve|enhance|rewrite|patch|modify|adjust|tweak|make (it|the|this)|let'?s (do|move|apply|implement|go)|go ahead|move to (the )?(point|\d)|do (the )?(point|\d|third|3rd|second|2nd|first|1st)|point\s*[#]?\s*\d+|suggestion\s*[#]?\s*\d+|take a look|look at (these|the) changes|these changes)\b/i

const HTML_MAKE_BETTER_PATTERN =
  /\bmake\b[\s\S]{0,40}\b(better|stronger|bigger|green|bold|clearer|more|prominent)\b/i

/**
 * Soft UI dissatisfaction / spacing follow-ups that still mean "edit the page"
 * even without an explicit improve/redesign verb ("UI is not good", padding).
 */
const HTML_UI_COMPLAINT_PATTERN =
  /\b(ui|ux|design|layout|look(s)?|visuals?|theme)\b[\s\S]{0,60}\b(not good|no good|bad|ugly|off|wrong|broken|poor|messy|cluttered|cramped|tight)|(\b(not good|no good|bad|ugly|poor)\b[\s\S]{0,40}\b(ui|ux|design|layout|look))|\b(spacing|padding|margin|gap|typography|whitespace|cards?)\b[\s\S]{0,40}\b(fix|improve|adjust|tweak|change|wrong|off|bad|tight|cramped)|(\b(fix|improve|adjust|tweak|change)\b[\s\S]{0,40}\b(spacing|padding|margin|gap|typography|whitespace|cards?))\b/i

/** Whole-UI polish (vs a single label/section micro-edit). */
const HTML_REDESIGN_PATTERN =
  /\b(improve|redesign|enhance|modernize|restyle|overhaul|revamp)\b[\s\S]{0,80}\b(ui|ux|html|page|design|theme|look|layout|style|stylesheet|css)\b|\b(ui|ux|page|html|theme|look|layout)\b[\s\S]{0,40}\b(improve|redesign|enhance|modernize|restyle|overhaul|revamp)\b|\bmake\b[\s\S]{0,40}\b(ui|page|html|design)\b[\s\S]{0,40}\b(better|modern|cleaner|prettier|nicer)\b|\b(ui|ux)\b[\s\S]{0,40}\b(not good|no good|bad|better)\b|\b(spacing|padding|layout|design system|cards?)\b[\s\S]{0,50}\b(fix|improve|adjust|tweak|change|wrong|off)\b/i

const HTML_MENTION_PATTERN =
  /\b(\.html?|html|the page|this page|the file|the ui|this ui|highlighted ui)\b/i

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

/**
 * True when the user is asking to change HTML (not only review / suggest).
 */
export function looksLikeHtmlEditIntent(message: string): boolean {
  const text = message.trim()
  if (!text) return false
  if (HTML_EDIT_SIGNAL_PATTERN.test(text) || HTML_MAKE_BETTER_PATTERN.test(text)) return true
  if (HTML_UI_COMPLAINT_PATTERN.test(text) || HTML_REDESIGN_PATTERN.test(text)) return true
  return false
}

/**
 * True when the ask is whole-UI improve/redesign (not a single button/label patch).
 */
export function looksLikeHtmlRedesignIntent(message: string): boolean {
  const text = message.trim()
  if (!text) return false
  if (looksLikeHtmlAnalysisOnly(text)) return false
  return HTML_REDESIGN_PATTERN.test(text) || HTML_UI_COMPLAINT_PATTERN.test(text)
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

const FILE_INSPECTION_TOOL_NAMES = new Set(['read', 'grep', 'glob', 'load_copilot_artifact'])

/** First-call tools that waste an HTML improve/redesign turn. */
const HTML_IMPROVE_BAD_FIRST_TOOLS = new Set([
  'list_file_folders',
  'create_file_folder',
  'function_execute',
  'run_function',
])

const SANDBOX_TOOL_NAMES = new Set(['function_execute', 'run_function'])

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
 * True when function_execute is dumping / browsing an HTML file instead of
 * doing real compute.
 */
export function isHtmlSandboxInspectCall(record: {
  name: string
  args?: Record<string, unknown>
}): boolean {
  if (!SANDBOX_TOOL_NAMES.has(record.name)) return false
  const args = record.args ?? {}
  const code = typeof args.code === 'string' ? args.code : ''
  const title = typeof args.title === 'string' ? args.title : ''
  const blob = `${title}\n${code}`.toLowerCase()

  if (sandboxInputsMountHtml(args.inputs)) return true
  if (/\.html?\b/.test(blob) && /\b(open|read|splitlines|print|inspect|lines)\b/.test(blob)) {
    return true
  }
  if (/\binspect\b/.test(title.toLowerCase()) && /\b(html|css|style|body|form|card)\b/.test(blob)) {
    return true
  }
  return false
}

/**
 * Counts successful sandbox HTML-inspection calls this turn.
 */
export function countHtmlSandboxInspects(
  records: ReadonlyArray<{ name: string; success: boolean; args?: Record<string, unknown> }>
): number {
  return records.filter((record) => record.success && isHtmlSandboxInspectCall(record)).length
}

/**
 * Counts HTML sandbox inspect attempts (success or reject) this turn.
 * Rejects must still steer the model onto read/grep + write.
 */
export function countHtmlSandboxInspectAttempts(
  records: ReadonlyArray<{ name: string; args?: Record<string, unknown> }>
): number {
  return records.filter((record) => isHtmlSandboxInspectCall(record)).length
}

/**
 * True when a VFS path is a leaf `.html` / `.htm` without the `/content` suffix.
 */
export function isHtmlLeafPathWithoutContent(path: string): boolean {
  const trimmed = path.trim()
  if (!trimmed) return false
  let decoded = trimmed
  try {
    decoded = decodeURIComponent(trimmed)
  } catch {
    // keep raw
  }
  if (/\/content$/i.test(decoded)) return false
  return /\.html?$/i.test(decoded)
}

/**
 * Content path for a leaf HTML file (idempotent if `/content` already present).
 */
export function toHtmlContentPath(path: string): string {
  const trimmed = path.trim().replace(/\/+$/, '')
  if (!trimmed) return trimmed
  if (/\/content$/i.test(trimmed)) return trimmed
  return `${trimmed}/content`
}

/**
 * True when a successful grep returned no useful hits (empty matches, leaf
 * metadata path, or a vacuous pattern).
 */
export function isEmptyOrUselessHtmlGrep(record: {
  name: string
  success: boolean
  args?: Record<string, unknown>
  result?: unknown
}): boolean {
  if (record.name !== 'grep' || !record.success) return false
  const path = typeof record.args?.path === 'string' ? record.args.path : ''
  if (path && isHtmlLeafPathWithoutContent(path)) return true
  const pattern = typeof record.args?.pattern === 'string' ? record.args.pattern.trim() : ''
  if (pattern === '.*' || pattern === '.' || pattern === '<' || /^html$/i.test(pattern)) {
    return true
  }
  return grepResultHasNoMatches(record.result)
}

/**
 * Counts empty/useless greps this turn for preferred-path write redirects.
 */
export function countEmptyOrUselessHtmlGreps(
  records: ReadonlyArray<{
    name: string
    success: boolean
    args?: Record<string, unknown>
    result?: unknown
  }>
): number {
  return records.filter((record) => isEmptyOrUselessHtmlGrep(record)).length
}

function grepResultHasNoMatches(result: unknown): boolean {
  if (result == null) return true
  if (typeof result !== 'object') return false
  const record = result as Record<string, unknown>
  if (Array.isArray(record.matches)) return record.matches.length === 0
  if (Array.isArray(record.files)) return record.files.length === 0
  if (Array.isArray(record.counts)) return record.counts.length === 0
  if (record.output && typeof record.output === 'object') {
    return grepResultHasNoMatches(record.output)
  }
  if (record.data && typeof record.data === 'object') {
    return grepResultHasNoMatches(record.data)
  }
  return false
}

/**
 * True when the turn already successfully read preferredPath/content.
 */
export function hasSuccessfulPreferredHtmlContentRead(
  records: ReadonlyArray<{
    name: string
    success: boolean
    args?: Record<string, unknown>
  }>,
  preferredPath: string | null | undefined
): boolean {
  const preferred = preferredPath?.trim()
  if (!preferred) return false
  const contentPath = toHtmlContentPath(preferred).toLowerCase()
  const leafPath = preferred.replace(/\/content$/i, '').toLowerCase()
  return records.some((record) => {
    if (record.name !== 'read' || !record.success) return false
    const path = typeof record.args?.path === 'string' ? record.args.path.trim() : ''
    if (!path) return false
    let decoded = path
    try {
      decoded = decodeURIComponent(path)
    } catch {
      // keep raw
    }
    const normalized = decoded.toLowerCase()
    return (
      normalized === contentPath ||
      normalized === `${leafPath}/content` ||
      (normalized.endsWith('/content') && normalized.replace(/\/content$/i, '') === leafPath)
    )
  })
}

function sandboxInputsMountHtml(inputs: unknown): boolean {
  if (!inputs || typeof inputs !== 'object' || Array.isArray(inputs)) return false
  const files = (inputs as Record<string, unknown>).files
  if (!Array.isArray(files)) return false
  return files.some((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false
    const row = entry as Record<string, unknown>
    const path =
      (typeof row.path === 'string' && row.path) ||
      (typeof row.sandboxPath === 'string' && row.sandboxPath) ||
      ''
    return /\.html?(?:\/content)?$/i.test(path) || /\/[^/]+\.html?\b/i.test(path)
  })
}

/**
 * True when the turn's early tools skipped preferredPath/files content and
 * went to folder listing or uploads/ discovery instead.
 */
export function shouldForceHtmlImproveFirstCallNudge(options: {
  postBuildToolMode: string
  forcedHtmlImproveFirstCallNudges: number
  maxForcedHtmlImproveFirstCallNudges: number
  round: number
  maxToolRounds: number
  userMessage: string
  hasHtmlContext: boolean
  preferredPath?: string | null
  turnToolRecords: ReadonlyArray<{
    name: string
    success: boolean
    args?: Record<string, unknown>
  }>
  hasFileMutationTools: boolean
  streamedUserFacingText: string
  roundDisplayText: string
}): boolean {
  if (options.postBuildToolMode !== 'all') return false
  if (options.forcedHtmlImproveFirstCallNudges >= options.maxForcedHtmlImproveFirstCallNudges) {
    return false
  }
  if (options.round >= options.maxToolRounds - 1) return false
  if (options.hasFileMutationTools) return false
  if (!options.hasHtmlContext) return false
  if (!looksLikeHtmlEditIntent(options.userMessage)) return false
  if (looksLikeHtmlAnalysisOnly(options.userMessage)) return false
  if (options.turnToolRecords.length === 0 || options.turnToolRecords.length > 3) return false

  const hasGoodContentRead = options.turnToolRecords.some((record) => {
    if (record.name !== 'read' && record.name !== 'grep') return false
    if (!record.success) return false
    const path = typeof record.args?.path === 'string' ? record.args.path : ''
    if (!path) return record.name === 'grep'
    if (path.startsWith('files/')) return true
    if (options.preferredPath && path.startsWith(options.preferredPath)) return true
    return false
  })
  if (hasGoodContentRead) return false

  const usedBadFirstTool = options.turnToolRecords.some((record) => {
    if (HTML_IMPROVE_BAD_FIRST_TOOLS.has(record.name)) return true
    if (record.name === 'read' || record.name === 'glob' || record.name === 'grep') {
      const path =
        typeof record.args?.path === 'string'
          ? record.args.path
          : typeof record.args?.pattern === 'string'
            ? record.args.pattern
            : ''
      if (path.startsWith('uploads/') || path.startsWith('uploads')) {
        const offset = typeof record.args?.offset === 'number' ? record.args.offset : undefined
        // Any uploads probe after preferredPath exists, or high-offset uploads read.
        if (options.preferredPath?.startsWith('files/') || (offset !== undefined && offset >= 50)) {
          return true
        }
        if (!record.success) return true
      }
    }
    return false
  })
  if (!usedBadFirstTool) return false

  // Do not gate on assistant narration — thinking-style prose used to block this.
  return true
}

/**
 * System nudge: stop folder/uploads discovery; read preferredPath or files content.
 */
export function buildHtmlImproveFirstCallNudgeMessage(options: {
  preferredPath?: string | null
}): string {
  const preferred = options.preferredPath?.trim()
  const pathHint = preferred
    ? preferred.startsWith('files/')
      ? `read("${preferred.replace(/\/content$/, '')}/content", offset: 0) or grep that path`
      : `materialize_file if still chat-scoped, then read files/…/content — preferredPath is ${preferred}`
    : 'read("files/<name>/content", offset: 0) or glob("files/**<name>*") / use preferredPath'

  return (
    `[System] HTML improve/redesign first-call policy: do NOT call list_file_folders, do not keep probing uploads/ (especially with a high offset), and do NOT use function_execute to inspect HTML. ` +
    `Next tool MUST be ${pathHint}. ` +
    'If uploads/ returned not found, the file was likely materialized — use files/ or preferredPath. For lean HTML under ~40KB prefer one workspace_file operation=update after reading. Do not dump HTML into chat.'
  )
}

/**
 * Soft orchestration: HTML edit turn is thrashing function_execute line dumps.
 */
export function shouldForceHtmlSandboxInspectNudge(options: {
  postBuildToolMode: string
  forcedHtmlSandboxInspectNudges: number
  maxForcedHtmlSandboxInspectNudges: number
  sandboxInspectsBeforeNudge: number
  sandboxInspectCount: number
  round: number
  maxToolRounds: number
  userMessage: string
  hasHtmlContext: boolean
  hasFileMutationTools: boolean
  streamedUserFacingText: string
  roundDisplayText: string
}): boolean {
  if (options.postBuildToolMode !== 'all') return false
  if (options.forcedHtmlSandboxInspectNudges >= options.maxForcedHtmlSandboxInspectNudges) {
    return false
  }
  if (options.round >= options.maxToolRounds - 1) return false
  if (options.hasFileMutationTools) return false
  if (!options.hasHtmlContext) return false
  if (!looksLikeHtmlEditIntent(options.userMessage)) return false
  if (looksLikeHtmlAnalysisOnly(options.userMessage)) return false
  if (options.sandboxInspectCount < options.sandboxInspectsBeforeNudge) return false

  // Sandbox HTML dumps are never the edit path — nudge even when the model
  // already wrote a short plan (bridge gate used to block the redirect).
  return true
}

/**
 * System nudge: stop function_execute HTML inspection; use read/grep + write.
 */
export function buildHtmlSandboxInspectNudgeMessage(options: {
  preferredPath?: string | null
  redesign: boolean
}): string {
  const pathHint = options.preferredPath?.trim() ? ` on ${options.preferredPath.trim()}` : ''
  const writeHint = options.redesign
    ? 'For whole-UI improve/redesign of lean HTML (<~40KB), call ONE workspace_file operation=update with the improved page (or patch if the file is larger).'
    : 'Call workspace_file operation=patch with a short unique live substring from read/grep, then edit_content with only the replacement.'

  return (
    `[System] HTML edit sandbox-inspect nudge: stop using function_execute to print/inspect HTML lines${pathHint}. ` +
    'Use read or grep on files/…/content instead. Do NOT call function_execute again for HTML inspection this turn. ' +
    writeHint
  )
}

/**
 * Immediate system nudge after a rejected HTML sandbox inspect — steer to write.
 */
export function buildHtmlSandboxInspectRejectNudgeMessage(options: {
  preferredPath?: string | null
  redesign: boolean
}): string {
  const preferred = options.preferredPath?.trim()
  const contentHint = preferred
    ? `read("${toHtmlContentPath(preferred)}", offset: 0)`
    : 'read("files/<name>/content", offset: 0)'
  const writeHint = options.redesign
    ? 'Then ONE workspace_file operation=update with the fixed page (lean HTML under ~40KB) or patch if larger.'
    : 'Then workspace_file operation=patch with a short unique live substring, then edit_content with only the replacement.'

  return (
    `[System] HTML sandbox inspect was rejected. Do NOT retry function_execute for HTML. ` +
    `Next tools MUST be ${contentHint}, then a write. ${writeHint} ` +
    'Do not dump HTML into chat.'
  )
}

/**
 * Soft orchestration: edit-intent turn inspected with read only (no grep yet).
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
  streamedUserFacingText: string
  roundDisplayText: string
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
  streamedUserFacingText: string
  roundDisplayText: string
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
 * Soft redirect when the model greps/reads a leaf `.html` without `/content`.
 */
export function shouldForceHtmlContentPathRedirect(options: {
  postBuildToolMode: string
  forcedHtmlContentPathRedirects: number
  maxForcedHtmlContentPathRedirects: number
  round: number
  maxToolRounds: number
  userMessage: string
  hasHtmlContext: boolean
  hasFileMutationTools: boolean
  lastToolName: string | null
  lastToolPath: string | null
  lastToolSuccess: boolean
}): boolean {
  if (options.postBuildToolMode !== 'all') return false
  if (options.forcedHtmlContentPathRedirects >= options.maxForcedHtmlContentPathRedirects) {
    return false
  }
  if (options.round >= options.maxToolRounds - 1) return false
  if (options.hasFileMutationTools) return false
  if (!options.hasHtmlContext) return false
  if (!looksLikeHtmlEditIntent(options.userMessage)) return false
  if (looksLikeHtmlAnalysisOnly(options.userMessage)) return false
  if (!options.lastToolSuccess) return false
  if (options.lastToolName !== 'grep' && options.lastToolName !== 'read') return false
  if (!options.lastToolPath || !isHtmlLeafPathWithoutContent(options.lastToolPath)) return false
  return true
}

/**
 * System nudge: use `/content` instead of the leaf HTML metadata path.
 */
export function buildHtmlContentPathRedirectMessage(leafPath: string): string {
  const contentPath = toHtmlContentPath(leafPath)
  return (
    `[System] HTML path redirect: "${leafPath.trim()}" is the leaf/metadata path. ` +
    `Next read/grep MUST use "${contentPath}". Then call workspace_file + edit_content. ` +
    'Do not grep the leaf path again.'
  )
}

/**
 * After empty/useless greps with a known preferredPath, force read → write.
 */
export function shouldForceHtmlPreferredPathWriteNudge(options: {
  postBuildToolMode: string
  forcedHtmlPreferredPathWriteNudges: number
  maxForcedHtmlPreferredPathWriteNudges: number
  emptyGrepsBeforeNudge: number
  emptyGrepCount: number
  round: number
  maxToolRounds: number
  userMessage: string
  hasHtmlContext: boolean
  preferredPath?: string | null
  hasFileMutationTools: boolean
}): boolean {
  if (options.postBuildToolMode !== 'all') return false
  if (options.forcedHtmlPreferredPathWriteNudges >= options.maxForcedHtmlPreferredPathWriteNudges) {
    return false
  }
  if (options.round >= options.maxToolRounds - 1) return false
  if (options.hasFileMutationTools) return false
  if (!options.hasHtmlContext) return false
  if (!options.preferredPath?.trim()) return false
  if (!looksLikeHtmlEditIntent(options.userMessage)) return false
  if (looksLikeHtmlAnalysisOnly(options.userMessage)) return false
  if (options.emptyGrepCount < options.emptyGrepsBeforeNudge) return false
  return true
}

/**
 * System nudge: stop empty greps; read preferredPath/content then write.
 */
export function buildHtmlPreferredPathWriteNudgeMessage(options: {
  preferredPath: string
  redesign: boolean
  hasPreferredContentRead: boolean
}): string {
  const contentPath = toHtmlContentPath(options.preferredPath)
  const readHint = options.hasPreferredContentRead
    ? `You already read ${contentPath} — do NOT grep again.`
    : `Next tool MUST be read("${contentPath}", offset: 0) (or a tight grep on that content path).`
  const writeHint = options.redesign
    ? 'Then ONE workspace_file operation=update with the fixed/improved page (lean HTML under ~40KB) or patch if larger.'
    : 'Then workspace_file operation=patch with a short unique live substring, then edit_content with only the replacement.'

  return (
    `[System] HTML edit preferred-path write nudge: empty/useless greps are not progress. ${readHint} ` +
    `${writeHint} Do not call function_execute. Do not dump HTML into chat.`
  )
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
  redesign?: boolean
}): string {
  const pathHint = options.preferredPath?.trim() ? ` on ${options.preferredPath.trim()}` : ''
  const tokenHint =
    options.tokens.length > 0
      ? `Reuse a short live substring involving: ${options.tokens
          .map((token) => JSON.stringify(token))
          .join(', ')}.`
      : 'Copy a short unique live substring from your last grep/read (id, class, function name, or button label) — never from a Thinking-only draft.'

  const lastAttempt =
    options.attempt >= options.maxAttempts
      ? options.redesign
        ? ' This is the last forced write attempt — if you still cannot write, stop and ask whether to continue with a lean full rewrite or a specific section.'
        : ' This is the last forced write attempt — if you still cannot patch, stop and ask the user which label/function to change.'
      : ''

  if (options.redesign) {
    return (
      `[System] HTML redesign write nudge (${options.attempt}/${options.maxAttempts}): you already inspected the file enough${pathHint}. ` +
      'Do NOT call read, grep, glob, function_execute, or load_copilot_artifact again this round. ' +
      'For lean HTML under ~40KB prefer ONE workspace_file operation=update with the improved page; otherwise patch with a short unique live substring from the latest read/grep. ' +
      'Do not invent CSS search strings from Thinking.' +
      lastAttempt
    )
  }

  return (
    `[System] HTML edit write nudge (${options.attempt}/${options.maxAttempts}): you already inspected the file enough${pathHint}. ` +
    'Do NOT call read, grep, glob, function_execute, or load_copilot_artifact again this round. ' +
    `Call workspace_file operation=patch with search_replace NOW (${tokenHint}), then edit_content with only the replacement. ` +
    'One targeted patch for the user ask (e.g. stepper clickability OR validation) — not a full rewrite.' +
    lastAttempt
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
  if (looksLikeHtmlRedesignIntent(options.userMessage)) {
    return (
      `I inspected the HTML${pathHint} but did not finish the redesign. ` +
      'The file was left unchanged — say whether to continue with a lean full rewrite ' +
      '(`workspace_file` operation=update if under ~40KB), or name a specific section to change.'
    )
  }
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
 * User-facing closer when patch/tool stagnation hits during an HTML redesign.
 */
export function buildHtmlRedesignStagnationUserMessage(options: {
  hadSuccessfulMutation: boolean
  count: number
}): string {
  if (options.hadSuccessfulMutation) {
    return (
      `I applied a partial theme update but stalled after ${options.count} similar patch attempts. ` +
      'Say whether to continue with a lean full rewrite (`workspace_file` operation=update if under ~40KB), ' +
      'or tell me the next specific section to change.'
    )
  }
  return (
    `I kept retrying HTML patches (${options.count} similar attempts) without finishing the redesign. ` +
    'Say whether to try a lean full rewrite (`workspace_file` operation=update if under ~40KB), ' +
    'or name a specific section/heading to change.'
  )
}

function summarizeHtmlEditAsk(message: string): string {
  const trimmed = message.replace(/\s+/g, ' ').trim()
  if (trimmed.length <= 80) return trimmed || 'your requested UX fix'
  return `${trimmed.slice(0, 77)}…`
}
