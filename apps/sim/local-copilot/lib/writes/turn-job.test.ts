/**
 * @vitest-environment node
 *
 * Protects A5 intent bleed: summarize PDF must not mutate preferred HTML.
 * Dual-intent (summarize + edit header) must stay allowed.
 */
import { describe, expect, it } from 'vitest'
import {
  filterSummarizeUploadForcedTools,
  hasDocumentUploadFocus,
  looksLikeSummarizeAndHtmlEditDualIntent,
  looksLikeSummarizeUploadIntent,
  rejectOutOfJobToolCall,
  resolveTurnJob,
  SUMMARIZE_UPLOAD_OUT_OF_SCOPE_ERROR,
} from '@/local-copilot/lib/writes/turn-job'

describe('looksLikeSummarizeUploadIntent', () => {
  it('detects A5-style summarize asks', () => {
    expect(looksLikeSummarizeUploadIntent('Summarise the PDF content.')).toBe(true)
    expect(looksLikeSummarizeUploadIntent('Summarize the uploaded document')).toBe(true)
    expect(looksLikeSummarizeUploadIntent('Give me a TL;DR of this PDF')).toBe(true)
  })

  it('does not treat plain HTML edits as summarize', () => {
    expect(looksLikeSummarizeUploadIntent('Update the header to Team To-Do List')).toBe(false)
  })
})

describe('resolveTurnJob', () => {
  it('classifies A5 summarize PDF with upload + preferred HTML as summarize_upload', () => {
    expect(
      resolveTurnJob({
        userMessage: 'Summarise the PDF content.',
        resolveReason: 'preferred',
        preferredPath: 'files/Apps/Team To-Do.html',
        candidatePaths: ['files/Apps/Team To-Do.html'],
        currentTurnUploadPaths: ['uploads/Arena Authentication Architecture.pdf'],
      })
    ).toBe('summarize_upload')
  })

  it('classifies summarize without doc focus as general (not mute HTML forever)', () => {
    expect(
      resolveTurnJob({
        userMessage: 'Summarise what we discussed',
        resolveReason: 'preferred',
        preferredPath: 'files/Apps/Team To-Do.html',
        currentTurnUploadPaths: [],
      })
    ).toBe('general')
  })

  it('keeps dual summarize+HTML-edit as general so HTML patch stays allowed', () => {
    expect(
      looksLikeSummarizeAndHtmlEditDualIntent({
        userMessage: 'Summarise the PDF and update the header on the page',
        preferredPath: 'files/Apps/Team To-Do.html',
      })
    ).toBe(true)
    expect(
      resolveTurnJob({
        userMessage: 'Summarise the PDF and update the header on the page',
        resolveReason: 'preferred',
        preferredPath: 'files/Apps/Team To-Do.html',
        currentTurnUploadPaths: ['uploads/doc.pdf'],
      })
    ).toBe('general')
  })

  it('still detects create_from_image and html_edit', () => {
    expect(
      resolveTurnJob({
        userMessage: 'Build UI like this from the uploaded image',
        resolveReason: 'image_reference',
        preferredPath: null,
        currentTurnUploadPaths: ['uploads/shot.png'],
      })
    ).toBe('create_from_image')

    expect(
      resolveTurnJob({
        userMessage: 'Update the header name to Team To-Do List',
        resolveReason: 'preferred',
        preferredPath: 'files/Apps/Team To-Do.html',
        currentTurnUploadPaths: ['uploads/shot.png'],
      })
    ).toBe('html_edit')
  })

  it('promotes short option-chip titles to html_edit when preferred is HTML', () => {
    expect(
      resolveTurnJob({
        userMessage: 'Add format presets',
        resolveReason: 'preferred',
        preferredPath: 'files/Apps/Ad Generator.html',
        candidatePaths: ['files/Apps/Ad Generator.html'],
        currentTurnUploadPaths: [],
      })
    ).toBe('html_edit')
  })

  it('does not promote short Add titles without HTML context', () => {
    expect(
      resolveTurnJob({
        userMessage: 'Add format presets',
        resolveReason: 'none',
        preferredPath: 'files/notes.md',
        candidatePaths: [],
        currentTurnUploadPaths: [],
      })
    ).toBe('general')
  })
})

describe('hasDocumentUploadFocus', () => {
  it('accepts this-turn PDF uploads or PDF mention in text', () => {
    expect(
      hasDocumentUploadFocus({
        userMessage: 'Summarise it',
        currentTurnUploadPaths: ['uploads/Arena.pdf'],
      })
    ).toBe(true)
    expect(
      hasDocumentUploadFocus({
        userMessage: 'Summarise the PDF',
        currentTurnUploadPaths: [],
      })
    ).toBe(true)
  })
})

describe('filterSummarizeUploadForcedTools', () => {
  it('strips mutation tools but keeps read/grep', () => {
    const tools = [
      { name: 'read' },
      { name: 'grep' },
      { name: 'workspace_file' },
      { name: 'edit_content' },
      { name: 'create_file' },
      { name: 'open_resource' },
    ]
    expect(filterSummarizeUploadForcedTools(tools, true).map((t) => t.name)).toEqual([
      'read',
      'grep',
      'open_resource',
    ])
  })
})

describe('rejectOutOfJobToolCall', () => {
  it('rejects HTML mutate/inspect on summarize_upload', () => {
    const patch = rejectOutOfJobToolCall({
      turnJob: 'summarize_upload',
      toolName: 'workspace_file',
      args: { operation: 'patch', target: { kind: 'path', path: 'files/Apps/Team To-Do.html' } },
    })
    expect(patch?.success).toBe(false)
    expect(patch?.error).toBe(SUMMARIZE_UPLOAD_OUT_OF_SCOPE_ERROR)

    const htmlGrep = rejectOutOfJobToolCall({
      turnJob: 'summarize_upload',
      toolName: 'grep',
      args: { path: 'files/Apps/Team%20To-Do.html/content', pattern: 'Team To-Do List' },
    })
    expect(htmlGrep?.success).toBe(false)

    const pdfRead = rejectOutOfJobToolCall({
      turnJob: 'summarize_upload',
      toolName: 'read',
      args: { path: 'uploads/Arena Authentication Architecture.pdf' },
    })
    expect(pdfRead).toBeNull()
  })

  it('does not reject when job is html_edit or general', () => {
    expect(
      rejectOutOfJobToolCall({
        turnJob: 'html_edit',
        toolName: 'workspace_file',
        args: { operation: 'patch' },
      })
    ).toBeNull()
  })
})
