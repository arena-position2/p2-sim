/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import {
  EMPTY_GREPS_BEFORE_HTML_WRITE_NUDGE,
  HTML_EDIT_INSPECTIONS_BEFORE_WRITE_NUDGE,
  MAX_HTML_EDIT_GREP_NUDGE_ROUNDS,
  MAX_HTML_EDIT_WRITE_NUDGE_ROUNDS,
} from '@/local-copilot/lib/agent/limits'
import {
  buildHtmlEditEmptyGrepWriteNudgeMessage,
  buildHtmlEditGrepNudgeMessage,
  buildHtmlEditWriteGiveUpMessage,
  buildHtmlEditWriteNudgeMessage,
  countEmptyGreps,
  countSuccessfulFileInspections,
  extractHtmlEditGrepTokens,
  filterHtmlEditForcedTools,
  hasHtmlEditContext,
  isEmptyGrepResult,
  looksLikeHtmlAnalysisOnly,
  looksLikeHtmlEditIntent,
  resolveHtmlEditMidStreamSuppress,
  shouldForceHtmlEditGrepNudge,
  shouldForceHtmlEditWriteAfterEmptyGreps,
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

  it('treats short option-chip titles as edit intent', () => {
    expect(looksLikeHtmlEditIntent('Add format presets')).toBe(true)
    expect(looksLikeHtmlEditIntent('Enable dark mode toggle')).toBe(true)
    expect(looksLikeHtmlEditIntent('Widen the sidebar')).toBe(true)
    expect(looksLikeHtmlAnalysisOnly('Add format presets')).toBe(false)
  })

  it('does not treat long Add-prose or suggestion chips as short implement', () => {
    expect(
      looksLikeHtmlEditIntent(
        'Add more detail about every section of the layout and explain the tradeoffs for each choice'
      )
    ).toBe(false)
    expect(looksLikeHtmlEditIntent('Add more UX suggestions')).toBe(false)
    expect(looksLikeHtmlEditIntent('Share feedback?')).toBe(false)
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

  it('derives a grep token from short option-chip titles', () => {
    expect(extractHtmlEditGrepTokens('Add format presets')).toEqual(['format presets'])
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
  }

  it('nudges once when an HTML edit turn only read without grep', () => {
    expect(shouldForceHtmlEditGrepNudge(base)).toBe(true)
  })

  it('nudges even when the model already streamed non-bridge prose', () => {
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

describe('empty grep helpers', () => {
  it('detects empty match payloads', () => {
    expect(isEmptyGrepResult({ matches: [] })).toBe(true)
    expect(isEmptyGrepResult({ matches: [{ line: 1 }] })).toBe(false)
    expect(isEmptyGrepResult({ counts: [{ path: 'a.html', count: 0 }] })).toBe(true)
    expect(isEmptyGrepResult({ files: [] })).toBe(true)
  })

  it('counts empty greps in the turn', () => {
    expect(
      countEmptyGreps([
        { name: 'grep', success: true, result: { matches: [] } },
        { name: 'grep', success: true, result: { matches: [{ line: 1 }] } },
        { name: 'grep', success: false, result: { matches: [] } },
        { name: 'read', success: true, result: { content: 'x' } },
      ])
    ).toBe(1)
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

  it('forces write after repeated empty greps', () => {
    expect(
      shouldForceHtmlEditWriteAfterEmptyGreps({
        ...writeBase,
        emptyGrepCount: EMPTY_GREPS_BEFORE_HTML_WRITE_NUDGE,
        emptyGrepsBeforeWriteNudge: EMPTY_GREPS_BEFORE_HTML_WRITE_NUDGE,
      })
    ).toBe(true)
    expect(
      shouldForceHtmlEditWriteAfterEmptyGreps({
        ...writeBase,
        emptyGrepCount: EMPTY_GREPS_BEFORE_HTML_WRITE_NUDGE - 1,
        emptyGrepsBeforeWriteNudge: EMPTY_GREPS_BEFORE_HTML_WRITE_NUDGE,
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

    const emptyGrepMessage = buildHtmlEditEmptyGrepWriteNudgeMessage({
      tokens: ['CTA'],
      preferredPath: 'files/ad-generator.html',
      attempt: 1,
      maxAttempts: 2,
    })
    expect(emptyGrepMessage).toMatch(/no matches/i)
    expect(emptyGrepMessage).toContain('files/ad-generator.html/content')

    const giveUp = buildHtmlEditWriteGiveUpMessage({
      tokens: [],
      preferredPath: 'files/ad-generator.html',
      userMessage: 'Apply the validation and clickable-stepper fixes',
    })
    expect(giveUp).toMatch(/left unchanged/i)
    expect(giveUp).toMatch(/exact button label|function name/i)
  })

  it('strips inspect tools when write-forced and search tools when search-forced', () => {
    const tools = [
      { name: 'read' },
      { name: 'grep' },
      { name: 'workspace_file' },
      { name: 'edit_content' },
      { name: 'function_execute' },
    ]
    expect(filterHtmlEditForcedTools(tools, 'search').map((tool) => tool.name)).toEqual([
      'read',
      'workspace_file',
      'edit_content',
    ])
    expect(filterHtmlEditForcedTools(tools, 'write').map((tool) => tool.name)).toEqual([
      'workspace_file',
      'edit_content',
    ])
    expect(filterHtmlEditForcedTools(tools, 'none')).toEqual(tools)
  })
})

describe('resolveHtmlEditMidStreamSuppress', () => {
  const base = {
    turnJob: 'html_edit',
    currentMode: 'none' as const,
    inspectionCount: 0,
    inspectionsBeforeWriteNudge: HTML_EDIT_INSPECTIONS_BEFORE_WRITE_NUDGE,
    emptyGrepCount: 0,
    emptyGrepsBeforeWriteNudge: EMPTY_GREPS_BEFORE_HTML_WRITE_NUDGE,
    hasFileMutationTools: false,
  }

  it('escalates to write after enough inspections without waiting for text settle', () => {
    expect(
      resolveHtmlEditMidStreamSuppress({
        ...base,
        inspectionCount: HTML_EDIT_INSPECTIONS_BEFORE_WRITE_NUDGE,
      })
    ).toBe('write')
  })

  it('escalates empty greps to search first, then write', () => {
    expect(
      resolveHtmlEditMidStreamSuppress({
        ...base,
        emptyGrepCount: EMPTY_GREPS_BEFORE_HTML_WRITE_NUDGE,
      })
    ).toBe('search')
    expect(
      resolveHtmlEditMidStreamSuppress({
        ...base,
        currentMode: 'search',
        emptyGrepCount: EMPTY_GREPS_BEFORE_HTML_WRITE_NUDGE,
      })
    ).toBe('write')
  })

  it('does not escalate for summarize_upload or after a mutation', () => {
    expect(
      resolveHtmlEditMidStreamSuppress({
        ...base,
        turnJob: 'summarize_upload',
        inspectionCount: HTML_EDIT_INSPECTIONS_BEFORE_WRITE_NUDGE,
      })
    ).toBe('none')
    expect(
      resolveHtmlEditMidStreamSuppress({
        ...base,
        inspectionCount: HTML_EDIT_INSPECTIONS_BEFORE_WRITE_NUDGE,
        hasFileMutationTools: true,
      })
    ).toBe('none')
  })

  it('does not escalate before the inspection threshold', () => {
    expect(
      resolveHtmlEditMidStreamSuppress({
        ...base,
        inspectionCount: HTML_EDIT_INSPECTIONS_BEFORE_WRITE_NUDGE - 1,
      })
    ).toBe('none')
  })
})

describe('isHtmlEditJob gate', () => {
  it('skips write force when isHtmlEditJob is false (A5 fence)', () => {
    expect(
      shouldForceHtmlEditWriteNudge({
        postBuildToolMode: 'all',
        forcedHtmlEditWriteNudges: 0,
        maxForcedHtmlEditWriteNudges: MAX_HTML_EDIT_WRITE_NUDGE_ROUNDS,
        inspectionsBeforeWriteNudge: HTML_EDIT_INSPECTIONS_BEFORE_WRITE_NUDGE,
        inspectionCount: HTML_EDIT_INSPECTIONS_BEFORE_WRITE_NUDGE,
        round: 2,
        maxToolRounds: 10,
        userMessage: 'Update the header',
        hasHtmlContext: true,
        hasFileMutationTools: false,
        isHtmlEditJob: false,
      })
    ).toBe(false)
  })
})
