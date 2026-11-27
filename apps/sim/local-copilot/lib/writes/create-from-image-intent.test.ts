/**
 * @vitest-environment node
 *
 * Protects A1 create-from-image routing: screenshot+build must not be treated as
 * HTML-edit explore, and must force create_file instead of settling empty.
 */
import { describe, expect, it } from 'vitest'
import { MAX_CREATE_FROM_IMAGE_CONTINUATION_ROUNDS } from '@/local-copilot/lib/agent/limits'
import {
  buildCreateFromImageContinuationMessage,
  buildCreateFromImageJobSystemMessage,
  filterCreateFromImageForcedTools,
  isCreateFromImageJob,
  shouldForceCreateFromImageContinuation,
  turnHasSuccessfulCreateFile,
} from '@/local-copilot/lib/writes/create-from-image-intent'
import {
  shouldForceHtmlEditGrepNudge,
  shouldForceHtmlEditWriteNudge,
  shouldStopHtmlEditWithoutWrite,
} from '@/local-copilot/lib/writes/html-edit-intent'

describe('isCreateFromImageJob', () => {
  it('detects A1-style build-from-screenshot with image_reference', () => {
    expect(
      isCreateFromImageJob({
        resolveReason: 'image_reference',
        userMessage: 'Build UI like this from the uploaded image?',
      })
    ).toBe(true)
    expect(
      isCreateFromImageJob({
        resolveReason: 'image_reference',
        userMessage: 'Create a page based on this screenshot',
      })
    ).toBe(true)
  })

  it('rejects when resolveReason is not image_reference', () => {
    expect(
      isCreateFromImageJob({
        resolveReason: 'preferred',
        userMessage: 'Build UI like this from the uploaded image?',
      })
    ).toBe(false)
    expect(
      isCreateFromImageJob({
        resolveReason: 'explicit_name',
        userMessage: 'Build from this screenshot',
      })
    ).toBe(false)
  })

  it('rejects when the user names an HTML target', () => {
    expect(
      isCreateFromImageJob({
        resolveReason: 'image_reference',
        userMessage: 'Build UI like Final Todo.html from this screenshot',
      })
    ).toBe(false)
  })
})

describe('create-from-image vs HTML-edit caps', () => {
  const editBase = {
    postBuildToolMode: 'all',
    forcedHtmlEditGrepNudges: 0,
    maxForcedHtmlEditGrepNudges: 1,
    forcedHtmlEditWriteNudges: 0,
    maxForcedHtmlEditWriteNudges: 2,
    inspectionsBeforeWriteNudge: 3,
    inspectionCount: 5,
    round: 2,
    maxToolRounds: 10,
    userMessage: "Great let's move to the 3rd point.",
    hasHtmlContext: true,
    hasSuccessfulRead: true,
    hasSuccessfulGrep: false,
    hasFileMutationTools: false,
    isCreateFromImageJob: true,
  }

  it('never steers create-from-image into HTML edit grep/write/give-up', () => {
    expect(shouldForceHtmlEditGrepNudge(editBase)).toBe(false)
    expect(shouldForceHtmlEditWriteNudge(editBase)).toBe(false)
    expect(shouldStopHtmlEditWithoutWrite(editBase)).toBe(false)
  })
})

describe('shouldForceCreateFromImageContinuation', () => {
  const base = {
    postBuildToolMode: 'all',
    isCreateFromImageJob: true,
    forcedCreateFromImageContinuations: 0,
    maxForcedCreateFromImageContinuations: MAX_CREATE_FROM_IMAGE_CONTINUATION_ROUNDS,
    round: 1,
    maxToolRounds: 10,
    hasSuccessfulCreateFile: false,
  }

  it('forces when the job settled without create_file', () => {
    expect(shouldForceCreateFromImageContinuation(base)).toBe(true)
  })

  it('stops after create_file succeeds or budget is exhausted', () => {
    expect(shouldForceCreateFromImageContinuation({ ...base, hasSuccessfulCreateFile: true })).toBe(
      false
    )
    expect(
      shouldForceCreateFromImageContinuation({
        ...base,
        forcedCreateFromImageContinuations: MAX_CREATE_FROM_IMAGE_CONTINUATION_ROUNDS,
      })
    ).toBe(false)
    expect(shouldForceCreateFromImageContinuation({ ...base, isCreateFromImageJob: false })).toBe(
      false
    )
  })
})

describe('filterCreateFromImageForcedTools', () => {
  const tools = [
    { name: 'create_file' },
    { name: 'read' },
    { name: 'grep' },
    { name: 'list_file_folders' },
    { name: 'function_execute' },
    { name: 'open_resource' },
  ]

  it('strips explore/sandbox tools until create succeeds', () => {
    const filtered = filterCreateFromImageForcedTools(tools, true)
    expect(filtered.map((tool) => tool.name)).toEqual(['create_file', 'open_resource'])
  })

  it('leaves the catalog alone when inactive', () => {
    expect(filterCreateFromImageForcedTools(tools, false)).toEqual(tools)
  })
})

describe('turnHasSuccessfulCreateFile', () => {
  it('requires a successful create_file record', () => {
    expect(turnHasSuccessfulCreateFile([{ name: 'create_file', success: true }])).toBe(true)
    expect(turnHasSuccessfulCreateFile([{ name: 'create_file', success: false }])).toBe(false)
    expect(turnHasSuccessfulCreateFile([{ name: 'read', success: true }])).toBe(false)
  })
})

describe('create-from-image nudge copy', () => {
  it('tells the model to create_file and skip unrelated HTML explore', () => {
    expect(buildCreateFromImageJobSystemMessage()).toMatch(/create_file/i)
    expect(buildCreateFromImageJobSystemMessage()).toMatch(/image_reference/i)
    expect(buildCreateFromImageContinuationMessage()).toMatch(/create_file now/i)
  })
})
