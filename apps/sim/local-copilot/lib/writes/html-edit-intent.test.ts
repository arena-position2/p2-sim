/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import {
  HTML_EDIT_INSPECTIONS_BEFORE_WRITE_NUDGE,
  HTML_EMPTY_GREPS_BEFORE_PREFERRED_WRITE_NUDGE,
  HTML_SANDBOX_INSPECTS_BEFORE_NUDGE,
  MAX_HTML_CONTENT_PATH_REDIRECT_ROUNDS,
  MAX_HTML_EDIT_GREP_NUDGE_ROUNDS,
  MAX_HTML_EDIT_WRITE_NUDGE_ROUNDS,
  MAX_HTML_IMPROVE_FIRST_CALL_NUDGE_ROUNDS,
  MAX_HTML_PREFERRED_PATH_WRITE_NUDGE_ROUNDS,
  MAX_HTML_SANDBOX_INSPECT_NUDGE_ROUNDS,
} from '@/local-copilot/lib/agent/limits'
import {
  buildHtmlContentPathRedirectMessage,
  buildHtmlEditGrepNudgeMessage,
  buildHtmlEditWriteGiveUpMessage,
  buildHtmlEditWriteNudgeMessage,
  buildHtmlImproveFirstCallNudgeMessage,
  buildHtmlPreferredPathWriteNudgeMessage,
  buildHtmlRedesignStagnationUserMessage,
  buildHtmlSandboxInspectNudgeMessage,
  buildHtmlSandboxInspectRejectNudgeMessage,
  countEmptyOrUselessHtmlGreps,
  countHtmlSandboxInspectAttempts,
  countHtmlSandboxInspects,
  countSuccessfulFileInspections,
  extractHtmlEditGrepTokens,
  hasHtmlEditContext,
  hasSuccessfulPreferredHtmlContentRead,
  isEmptyOrUselessHtmlGrep,
  isHtmlLeafPathWithoutContent,
  isHtmlSandboxInspectCall,
  looksLikeHtmlAnalysisOnly,
  looksLikeHtmlEditIntent,
  looksLikeHtmlRedesignIntent,
  shouldForceHtmlContentPathRedirect,
  shouldForceHtmlEditGrepNudge,
  shouldForceHtmlEditWriteNudge,
  shouldForceHtmlImproveFirstCallNudge,
  shouldForceHtmlPreferredPathWriteNudge,
  shouldForceHtmlSandboxInspectNudge,
  shouldStopHtmlEditWithoutWrite,
  toHtmlContentPath,
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

  it('detects whole-UI redesign asks', () => {
    expect(looksLikeHtmlRedesignIntent('Improve the UI of Final Todo.html')).toBe(true)
    expect(looksLikeHtmlRedesignIntent('Redesign this page theme')).toBe(true)
    expect(looksLikeHtmlEditIntent('Improve the UI of this HTML')).toBe(true)
    expect(looksLikeHtmlRedesignIntent('Change the Generate Ad button color')).toBe(false)
  })

  it('treats soft UI complaints and spacing follow-ups as redesign/edit', () => {
    const soft =
      'Still I feel that UI is not good. Can you please take a look at these changes as well'
    expect(looksLikeHtmlEditIntent(soft)).toBe(true)
    expect(looksLikeHtmlRedesignIntent(soft)).toBe(true)
    expect(looksLikeHtmlEditIntent('The padding and spacing still look off')).toBe(true)
    expect(looksLikeHtmlRedesignIntent('The padding and spacing still look off')).toBe(true)
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

describe('shouldForceHtmlImproveFirstCallNudge', () => {
  const base = {
    postBuildToolMode: 'all',
    forcedHtmlImproveFirstCallNudges: 0,
    maxForcedHtmlImproveFirstCallNudges: MAX_HTML_IMPROVE_FIRST_CALL_NUDGE_ROUNDS,
    round: 1,
    maxToolRounds: 10,
    userMessage: 'Improve the UI of this HTML',
    hasHtmlContext: true,
    preferredPath: 'files/Final Todo.html',
    turnToolRecords: [{ name: 'list_file_folders', success: true, args: {} }],
    hasFileMutationTools: false,
    streamedUserFacingText: '',
    roundDisplayText: '',
  }

  it('nudges when the first tool was list_file_folders', () => {
    expect(shouldForceHtmlImproveFirstCallNudge(base)).toBe(true)
  })

  it('nudges when the first tool was function_execute HTML inspect', () => {
    expect(
      shouldForceHtmlImproveFirstCallNudge({
        ...base,
        turnToolRecords: [
          {
            name: 'function_execute',
            success: true,
            args: {
              title: 'Inspect body styles',
              code: 'open("Final Todo.html")',
              language: 'python',
            },
          },
        ],
      })
    ).toBe(true)
  })

  it('nudges when uploads/ miss happens and preferredPath is files/', () => {
    expect(
      shouldForceHtmlImproveFirstCallNudge({
        ...base,
        turnToolRecords: [
          {
            name: 'read',
            success: false,
            args: { path: 'uploads/Final Todo.html', offset: 200 },
          },
        ],
      })
    ).toBe(true)
  })

  it('does not nudge after a successful files/ content read', () => {
    expect(
      shouldForceHtmlImproveFirstCallNudge({
        ...base,
        turnToolRecords: [
          { name: 'list_file_folders', success: true, args: {} },
          {
            name: 'read',
            success: true,
            args: { path: 'files/Final Todo.html/content', offset: 0 },
          },
        ],
      })
    ).toBe(false)
  })

  it('buildHtmlImproveFirstCallNudgeMessage points at preferredPath', () => {
    expect(
      buildHtmlImproveFirstCallNudgeMessage({ preferredPath: 'files/Final Todo.html' })
    ).toMatch(/files\/Final Todo\.html\/content/)
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

describe('HTML sandbox inspect nudge', () => {
  const sandboxArgs = {
    title: 'Inspect card and input styles',
    language: 'python',
    code: 'with open("/home/user/files/Final Todo.html") as f:\n  print(f.read().splitlines()[10:40])',
    inputs: {
      files: [{ path: 'files/Final%20Todo.html', sandboxPath: '/home/user/files/Final Todo.html' }],
    },
  }

  it('detects function_execute HTML inspects', () => {
    expect(isHtmlSandboxInspectCall({ name: 'function_execute', args: sandboxArgs })).toBe(true)
    expect(
      isHtmlSandboxInspectCall({
        name: 'function_execute',
        args: { title: 'sum numbers', code: 'print(1+1)', language: 'python' },
      })
    ).toBe(false)
  })

  it('counts successful sandbox HTML inspects', () => {
    expect(
      countHtmlSandboxInspects([
        { name: 'function_execute', success: true, args: sandboxArgs },
        { name: 'function_execute', success: true, args: sandboxArgs },
        { name: 'read', success: true, args: { path: 'files/Final Todo.html/content' } },
      ])
    ).toBe(2)
  })

  it('nudges after enough sandbox inspects with no mutation', () => {
    expect(
      shouldForceHtmlSandboxInspectNudge({
        postBuildToolMode: 'all',
        forcedHtmlSandboxInspectNudges: 0,
        maxForcedHtmlSandboxInspectNudges: MAX_HTML_SANDBOX_INSPECT_NUDGE_ROUNDS,
        sandboxInspectsBeforeNudge: HTML_SANDBOX_INSPECTS_BEFORE_NUDGE,
        sandboxInspectCount: HTML_SANDBOX_INSPECTS_BEFORE_NUDGE,
        round: 3,
        maxToolRounds: 20,
        userMessage: 'Improve the UI of Final Todo.html',
        hasHtmlContext: true,
        hasFileMutationTools: false,
        streamedUserFacingText: '',
        roundDisplayText: '',
      })
    ).toBe(true)
  })

  it('nudges even when the model already wrote a short plan', () => {
    expect(
      shouldForceHtmlSandboxInspectNudge({
        postBuildToolMode: 'all',
        forcedHtmlSandboxInspectNudges: 0,
        maxForcedHtmlSandboxInspectNudges: MAX_HTML_SANDBOX_INSPECT_NUDGE_ROUNDS,
        sandboxInspectsBeforeNudge: HTML_SANDBOX_INSPECTS_BEFORE_NUDGE,
        sandboxInspectCount: HTML_SANDBOX_INSPECTS_BEFORE_NUDGE,
        round: 2,
        maxToolRounds: 20,
        userMessage: 'Still I feel that UI is not good',
        hasHtmlContext: true,
        hasFileMutationTools: false,
        streamedUserFacingText: 'I will tighten spacing and typography next.',
        roundDisplayText: '',
      })
    ).toBe(true)
  })

  it('buildHtmlSandboxInspectNudgeMessage bans function_execute inspect', () => {
    const message = buildHtmlSandboxInspectNudgeMessage({
      preferredPath: 'files/Final Todo.html',
      redesign: true,
    })
    expect(message).toMatch(/function_execute/i)
    expect(message).toMatch(/operation=update/i)
  })

  it('buildHtmlRedesignStagnationUserMessage prefers rewrite over button labels', () => {
    expect(
      buildHtmlRedesignStagnationUserMessage({ hadSuccessfulMutation: true, count: 2 })
    ).toMatch(/partial theme|full rewrite/i)
    expect(
      buildHtmlRedesignStagnationUserMessage({ hadSuccessfulMutation: false, count: 2 })
    ).not.toMatch(/button label/i)
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

  it('forces a write nudge even with non-bridge thinking prose', () => {
    expect(
      shouldForceHtmlEditWriteNudge({
        ...writeBase,
        streamedUserFacingText: 'Finding actionable items\n\nI am focusing on the Add task card.',
      })
    ).toBe(true)
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

    const redesignGiveUp = buildHtmlEditWriteGiveUpMessage({
      tokens: [],
      preferredPath: 'files/Final Todo.html',
      userMessage: 'Improve the UI of Final Todo.html',
    })
    expect(redesignGiveUp).toMatch(/full rewrite|operation=update/i)
    expect(redesignGiveUp).not.toMatch(/button label/i)

    const redesignWrite = buildHtmlEditWriteNudgeMessage({
      tokens: [],
      preferredPath: 'files/Final Todo.html',
      attempt: 1,
      maxAttempts: 2,
      redesign: true,
    })
    expect(redesignWrite).toMatch(/operation=update/i)
    expect(redesignWrite).toMatch(/function_execute/i)
  })
})

describe('HTML leaf path + empty grep redirects', () => {
  it('detects leaf HTML paths without /content', () => {
    expect(isHtmlLeafPathWithoutContent('files/Final Todo.html')).toBe(true)
    expect(isHtmlLeafPathWithoutContent('files/Final%20Todo.html')).toBe(true)
    expect(isHtmlLeafPathWithoutContent('files/Final Todo.html/content')).toBe(false)
    expect(toHtmlContentPath('files/Final Todo.html')).toBe('files/Final Todo.html/content')
  })

  it('treats empty matches and leaf greps as useless', () => {
    expect(
      isEmptyOrUselessHtmlGrep({
        name: 'grep',
        success: true,
        args: { path: 'files/Final Todo.html/content', pattern: 'ASSIGN TO' },
        result: { matches: [] },
      })
    ).toBe(true)
    expect(
      isEmptyOrUselessHtmlGrep({
        name: 'grep',
        success: true,
        args: { path: 'files/Final Todo.html', pattern: 'PRIORITY' },
        result: { matches: [{ path: 'x', line: 1, content: 'meta' }] },
      })
    ).toBe(true)
    expect(
      isEmptyOrUselessHtmlGrep({
        name: 'grep',
        success: true,
        args: { path: 'files/Final Todo.html/content', pattern: 'form' },
        result: { matches: [{ path: 'x', line: 1, content: '<form' }] },
      })
    ).toBe(false)
  })

  it('counts sandbox inspect attempts including rejects', () => {
    const sandboxArgs = {
      title: 'Inspect',
      code: 'open("Final Todo.html"); print(lines)',
      inputs: { files: [{ path: 'files/Final Todo.html' }] },
    }
    expect(
      countHtmlSandboxInspectAttempts([
        { name: 'function_execute', args: sandboxArgs },
        { name: 'function_execute', args: sandboxArgs },
        { name: 'read', args: { path: 'files/Final Todo.html/content' } },
      ])
    ).toBe(2)
    expect(
      countHtmlSandboxInspects([
        { name: 'function_execute', success: false, args: sandboxArgs },
        { name: 'function_execute', success: true, args: sandboxArgs },
      ])
    ).toBe(1)
  })

  it('redirects leaf HTML grep/read to /content', () => {
    expect(
      shouldForceHtmlContentPathRedirect({
        postBuildToolMode: 'all',
        forcedHtmlContentPathRedirects: 0,
        maxForcedHtmlContentPathRedirects: MAX_HTML_CONTENT_PATH_REDIRECT_ROUNDS,
        round: 2,
        maxToolRounds: 20,
        userMessage: 'Here can you fix the highlighted UI, looks like UI is broken.',
        hasHtmlContext: true,
        hasFileMutationTools: false,
        lastToolName: 'grep',
        lastToolPath: 'files/Final%20Todo.html',
        lastToolSuccess: true,
      })
    ).toBe(true)
    expect(buildHtmlContentPathRedirectMessage('files/Final Todo.html')).toMatch(
      /Final Todo\.html\/content/
    )
  })

  it('forces preferred-path write after enough empty greps', () => {
    const greps = Array.from({ length: HTML_EMPTY_GREPS_BEFORE_PREFERRED_WRITE_NUDGE }, () => ({
      name: 'grep',
      success: true,
      args: { path: 'files/Final Todo.html/content', pattern: 'ASSIGN TO' },
      result: { matches: [] },
    }))
    expect(countEmptyOrUselessHtmlGreps(greps)).toBe(HTML_EMPTY_GREPS_BEFORE_PREFERRED_WRITE_NUDGE)
    expect(
      shouldForceHtmlPreferredPathWriteNudge({
        postBuildToolMode: 'all',
        forcedHtmlPreferredPathWriteNudges: 0,
        maxForcedHtmlPreferredPathWriteNudges: MAX_HTML_PREFERRED_PATH_WRITE_NUDGE_ROUNDS,
        emptyGrepsBeforeNudge: HTML_EMPTY_GREPS_BEFORE_PREFERRED_WRITE_NUDGE,
        emptyGrepCount: HTML_EMPTY_GREPS_BEFORE_PREFERRED_WRITE_NUDGE,
        round: 4,
        maxToolRounds: 20,
        userMessage: 'Here can you fix the highlighted UI, looks like UI is broken.',
        hasHtmlContext: true,
        preferredPath: 'files/Final Todo.html',
        hasFileMutationTools: false,
      })
    ).toBe(true)
    expect(
      hasSuccessfulPreferredHtmlContentRead(
        [{ name: 'read', success: true, args: { path: 'files/Final Todo.html/content' } }],
        'files/Final Todo.html'
      )
    ).toBe(true)
    expect(
      buildHtmlPreferredPathWriteNudgeMessage({
        preferredPath: 'files/Final Todo.html',
        redesign: true,
        hasPreferredContentRead: false,
      })
    ).toMatch(/Final Todo\.html\/content/)
    expect(
      buildHtmlSandboxInspectRejectNudgeMessage({
        preferredPath: 'files/Final Todo.html',
        redesign: true,
      })
    ).toMatch(/workspace_file operation=update/i)
  })
})
