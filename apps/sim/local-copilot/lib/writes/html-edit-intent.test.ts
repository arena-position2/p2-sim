/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import {
  HTML_EDIT_INSPECTIONS_BEFORE_WRITE_NUDGE,
  MAX_HTML_EDIT_GREP_NUDGE_ROUNDS,
  MAX_HTML_EDIT_WRITE_NUDGE_ROUNDS,
} from '@/local-copilot/lib/agent/limits'
import {
  buildHtmlEditGrepNudgeMessage,
  buildHtmlEditWriteGiveUpMessage,
  buildHtmlEditWriteNudgeMessage,
  countSuccessfulFileInspections,
  extractHtmlEditGrepTokens,
  hasHtmlEditContext,
  looksLikeHtmlAnalysisOnly,
  looksLikeHtmlEditIntent,
  shouldForceHtmlEditGrepNudge,
  shouldForceHtmlEditWriteNudge,
  shouldStopHtmlEditWithoutWrite,
} from '@/local-copilot/lib/writes/html-edit-intent'

describe('looksLikeHtmlEditIntent / analysis-only', () => {
  it('treats suggestion-only asks as analysis, not edit', () => {
    const message = 'Read the HTML carefully, and give me the UX suggestions for this?'
    expect(looksLikeHtmlAnalysisOnly(message)).toBe(true)
    expect(looksLikeHtmlEditIntent(message)).toBe(false)
  })

  it('treats apply / 3rd-point follow-ups as edit intent', () => {
    expect(looksLikeHtmlEditIntent("Great let's move to the 3rd point.")).toBe(true)
    expect(looksLikeHtmlEditIntent('Apply suggestion 3 to the CTA')).toBe(true)
    expect(looksLikeHtmlEditIntent('Make the Generate Ad button stronger')).toBe(true)
    expect(looksLikeHtmlAnalysisOnly("Great let's move to the 3rd point.")).toBe(false)
  })
})

describe('extractHtmlEditGrepTokens', () => {
  it('pulls quoted labels and CTA keywords', () => {
    expect(extractHtmlEditGrepTokens('Change the "Generate Ad" CTA color')).toEqual(
      expect.arrayContaining(['Generate Ad', 'CTA'])
    )
  })

  it('returns empty when nothing distinctive is quoted', () => {
    expect(extractHtmlEditGrepTokens("Great let's move to the 3rd point.")).toEqual([])
  })
})

describe('hasHtmlEditContext', () => {
  it('detects html preferred paths and html mentions', () => {
    expect(
      hasHtmlEditContext({
        userMessage: 'change the title',
        preferredPath: 'files/ad-generator.html',
      })
    ).toBe(true)
    expect(
      hasHtmlEditContext({
        userMessage: 'update this page',
        preferredPath: null,
        candidatePaths: [],
      })
    ).toBe(true)
    expect(
      hasHtmlEditContext({
        userMessage: 'rename the workflow',
        preferredPath: 'files/notes.md',
      })
    ).toBe(false)
  })
})

describe('shouldForceHtmlEditGrepNudge', () => {
  const base = {
    postBuildToolMode: 'all',
    forcedHtmlEditGrepNudges: 0,
    maxForcedHtmlEditGrepNudges: MAX_HTML_EDIT_GREP_NUDGE_ROUNDS,
    round: 2,
    maxToolRounds: 10,
    userMessage: "Great let's move to the 3rd point.",
    hasHtmlContext: true,
    hasSuccessfulRead: true,
    hasSuccessfulGrep: false,
    hasFileMutationTools: false,
    streamedUserFacingText: 'Let me read the file first.',
    roundDisplayText: '',
  }

  it('nudges once when an HTML edit turn only read without grep', () => {
    expect(shouldForceHtmlEditGrepNudge(base)).toBe(true)
  })

  it('does not nudge after grep already ran or after a write', () => {
    expect(shouldForceHtmlEditGrepNudge({ ...base, hasSuccessfulGrep: true })).toBe(false)
    expect(shouldForceHtmlEditGrepNudge({ ...base, hasFileMutationTools: true })).toBe(false)
  })

  it('does not nudge pure analysis turns', () => {
    expect(
      shouldForceHtmlEditGrepNudge({
        ...base,
        userMessage: 'Read the HTML carefully, and give me the UX suggestions for this?',
      })
    ).toBe(false)
  })

  it('respects the one-nudge budget', () => {
    expect(
      shouldForceHtmlEditGrepNudge({
        ...base,
        forcedHtmlEditGrepNudges: MAX_HTML_EDIT_GREP_NUDGE_ROUNDS,
      })
    ).toBe(false)
  })
})

describe('buildHtmlEditGrepNudgeMessage', () => {
  it('includes tokens when present', () => {
    const message = buildHtmlEditGrepNudgeMessage(['Generate Ad', 'CTA'])
    expect(message).toMatch(/grep first/i)
    expect(message).toContain('"Generate Ad"')
    expect(message).toContain('"CTA"')
    expect(message).toMatch(/operation=patch/i)
  })

  it('falls back when no tokens were extracted', () => {
    expect(buildHtmlEditGrepNudgeMessage([])).toMatch(/distinctive label/i)
  })
})

describe('HTML edit write nudge', () => {
  const writeBase = {
    postBuildToolMode: 'all',
    forcedHtmlEditWriteNudges: 0,
    maxForcedHtmlEditWriteNudges: MAX_HTML_EDIT_WRITE_NUDGE_ROUNDS,
    inspectionsBeforeWriteNudge: HTML_EDIT_INSPECTIONS_BEFORE_WRITE_NUDGE,
    inspectionCount: HTML_EDIT_INSPECTIONS_BEFORE_WRITE_NUDGE,
    round: 3,
    maxToolRounds: 20,
    userMessage: 'Apply the validation and clickable-stepper fixes',
    hasHtmlContext: true,
    hasFileMutationTools: false,
    streamedUserFacingText: 'Let me grep the go() handler next.',
    roundDisplayText: '',
  }

  it('counts successful file inspections only', () => {
    expect(
      countSuccessfulFileInspections([
        { name: 'read', success: true },
        { name: 'grep', success: true },
        { name: 'grep', success: false },
        { name: 'workspace_file', success: true },
        { name: 'glob', success: true },
      ])
    ).toBe(3)
  })

  it('forces a write nudge after enough inspections with no mutation', () => {
    expect(shouldForceHtmlEditWriteNudge(writeBase)).toBe(true)
  })

  it('does not force before the inspection threshold', () => {
    expect(
      shouldForceHtmlEditWriteNudge({
        ...writeBase,
        inspectionCount: HTML_EDIT_INSPECTIONS_BEFORE_WRITE_NUDGE - 1,
      })
    ).toBe(false)
  })

  it('does not force after a successful file mutation or on analysis-only asks', () => {
    expect(shouldForceHtmlEditWriteNudge({ ...writeBase, hasFileMutationTools: true })).toBe(false)
    expect(
      shouldForceHtmlEditWriteNudge({
        ...writeBase,
        userMessage: 'Read the HTML carefully, and give me the UX suggestions for this?',
      })
    ).toBe(false)
  })

  it('stops with a give-up closer after write nudges are exhausted', () => {
    expect(
      shouldStopHtmlEditWithoutWrite({
        forcedHtmlEditWriteNudges: MAX_HTML_EDIT_WRITE_NUDGE_ROUNDS,
        maxForcedHtmlEditWriteNudges: MAX_HTML_EDIT_WRITE_NUDGE_ROUNDS,
        inspectionsBeforeWriteNudge: HTML_EDIT_INSPECTIONS_BEFORE_WRITE_NUDGE,
        inspectionCount: HTML_EDIT_INSPECTIONS_BEFORE_WRITE_NUDGE,
        userMessage: 'Apply the validation and clickable-stepper fixes',
        hasHtmlContext: true,
        hasFileMutationTools: false,
      })
    ).toBe(true)

    const message = buildHtmlEditWriteNudgeMessage({
      tokens: ['stepper'],
      preferredPath: 'files/ad-generator.html',
      attempt: 1,
      maxAttempts: 2,
    })
    expect(message).toMatch(/workspace_file operation=patch/i)
    expect(message).toMatch(/Do NOT call read, grep/i)
    expect(message).toContain('files/ad-generator.html')

    const giveUp = buildHtmlEditWriteGiveUpMessage({
      tokens: [],
      preferredPath: 'files/ad-generator.html',
      userMessage: 'Apply the validation and clickable-stepper fixes',
    })
    expect(giveUp).toMatch(/left unchanged/i)
    expect(giveUp).toMatch(/exact button label|function name/i)
  })
})
