/**
 * @vitest-environment node
 *
 * Protects create-from-document: brief+prototype must not thrash as HTML edit
 * or settle without create_file.
 */
import { describe, expect, it } from 'vitest'
import { MAX_CREATE_FROM_DOCUMENT_CONTINUATION_ROUNDS } from '@/local-copilot/lib/agent/limits'
import {
  buildCreateFromDocumentContinuationMessage,
  buildCreateFromDocumentJobSystemMessage,
  filterCreateFromDocumentForcedTools,
  looksLikeCreateFromDocumentIntent,
  shouldForceCreateFromDocumentContinuation,
} from '@/local-copilot/lib/writes/create-from-document-intent'
import { resolveTurnJob } from '@/local-copilot/lib/writes/turn-job'

const BETA_PROMPT = `Create a visual design prototype of this page. considering this comments from client
. I would like to see a mock-up of a different layout that does not require the audience to scroll - ie. Keep the filters, add 6 category boxes/headers.
What do you think if we had 6 category boxes on this page?`

describe('looksLikeCreateFromDocumentIntent', () => {
  it('detects create/prototype/mock-up page asks', () => {
    expect(looksLikeCreateFromDocumentIntent(BETA_PROMPT)).toBe(true)
    expect(
      looksLikeCreateFromDocumentIntent('Build an HTML prototype from this research brief')
    ).toBe(true)
  })

  it('does not treat plain HTML edits as create-from-document', () => {
    expect(looksLikeCreateFromDocumentIntent('Update the header to Team To-Do List')).toBe(false)
    expect(looksLikeCreateFromDocumentIntent('Summarise the PDF content.')).toBe(false)
  })
})

describe('resolveTurnJob create_from_document', () => {
  it('classifies Beta-style prototype + docx upload as create_from_document', () => {
    expect(
      resolveTurnJob({
        userMessage: BETA_PROMPT,
        resolveReason: 'current_upload',
        preferredPath: 'files/BB Published_Research_Webpage_AgencyP2_Brief Nov2026.docx',
        currentTurnUploadPaths: [
          'uploads/BB Published_Research_Webpage_AgencyP2_Brief Nov2026.docx',
        ],
      })
    ).toBe('create_from_document')
  })

  it('does not steal summarize_upload or create_from_image', () => {
    expect(
      resolveTurnJob({
        userMessage: 'Summarise the PDF content.',
        resolveReason: 'preferred',
        preferredPath: 'files/Apps/Team To-Do.html',
        currentTurnUploadPaths: ['uploads/Arena.pdf'],
      })
    ).toBe('summarize_upload')

    expect(
      resolveTurnJob({
        userMessage: 'Build UI like this from the uploaded image',
        resolveReason: 'image_reference',
        preferredPath: null,
        currentTurnUploadPaths: ['uploads/shot.png'],
      })
    ).toBe('create_from_image')
  })

  it('keeps header edits as html_edit when preferred is HTML', () => {
    expect(
      resolveTurnJob({
        userMessage: 'Update the header name to Team To-Do List',
        resolveReason: 'preferred',
        preferredPath: 'files/Apps/Team To-Do.html',
        currentTurnUploadPaths: [],
      })
    ).toBe('html_edit')
  })
})

describe('shouldForceCreateFromDocumentContinuation', () => {
  const base = {
    postBuildToolMode: 'all',
    isCreateFromDocumentJob: true,
    forcedCreateFromDocumentContinuations: 0,
    maxForcedCreateFromDocumentContinuations: MAX_CREATE_FROM_DOCUMENT_CONTINUATION_ROUNDS,
    round: 1,
    maxToolRounds: 10,
    hasSuccessfulCreateFile: false,
  }

  it('forces create_file when the job has not created yet', () => {
    expect(shouldForceCreateFromDocumentContinuation(base)).toBe(true)
  })

  it('stops after create_file or budget exhaustion', () => {
    expect(
      shouldForceCreateFromDocumentContinuation({ ...base, hasSuccessfulCreateFile: true })
    ).toBe(false)
    expect(
      shouldForceCreateFromDocumentContinuation({
        ...base,
        forcedCreateFromDocumentContinuations: MAX_CREATE_FROM_DOCUMENT_CONTINUATION_ROUNDS,
      })
    ).toBe(false)
  })
})

describe('create-from-document tool filter + messages', () => {
  it('strips explore tools but keeps create_file and function_execute', () => {
    const tools = [
      { name: 'read' },
      { name: 'grep' },
      { name: 'function_execute' },
      { name: 'create_file' },
      { name: 'materialize_file' },
    ]
    expect(filterCreateFromDocumentForcedTools(tools, true).map((tool) => tool.name)).toEqual([
      'function_execute',
      'create_file',
      'materialize_file',
    ])
  })

  it('mentions create_file in job and continuation messages', () => {
    expect(buildCreateFromDocumentJobSystemMessage()).toMatch(/create_file/i)
    expect(buildCreateFromDocumentContinuationMessage()).toMatch(/create_file/i)
  })
})
