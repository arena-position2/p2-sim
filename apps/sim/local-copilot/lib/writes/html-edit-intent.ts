/**
 * Detects HTML *edit* follow-ups (vs analysis-only) and extracts grep tokens
 * so the orchestrator can soft-nudge read-paging turns toward grep → patch.
 */

import {
  isBridgingAssistantNarration,
  isFileInspectionBridgeNarration,
} from '@/local-copilot/lib/user-facing-text'

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

  const isBridge = (text: string) =>
    isFileInspectionBridgeNarration(text) || isBridgingAssistantNarration(text)
  const streamed = options.streamedUserFacingText.trim()
  if (streamed && !isBridge(streamed)) return false
  const roundDisplay = options.roundDisplayText.trim()
  if (roundDisplay && !isBridge(roundDisplay)) return false

  return true
}
