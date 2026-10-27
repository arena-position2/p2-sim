/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import {
  ACTIVE_DOCUMENTS_SYSTEM_PREFIX,
  clampActiveDocumentsState,
  extractActiveDocumentTouch,
  formatActiveDocumentsSystemMessage,
  parseActiveDocumentsState,
  pathsFromCurrentTurnUploads,
  resolveActiveEditTarget,
  touchActiveDocument,
  updateActiveDocumentsFromTurn,
} from '@/local-copilot/lib/context/active-documents'

describe('parseActiveDocumentsState', () => {
  it('parses and clamps preferredPath to known documents', () => {
    const state = parseActiveDocumentsState({
      preferredPath: 'files/missing.html',
      documents: [
        {
          path: 'files/a.html',
          role: 'generated',
          lastTouchedAt: '2026-01-01T00:00:00.000Z',
          name: 'a.html',
        },
      ],
    })
    expect(state?.preferredPath).toBe('files/a.html')
    expect(state?.documents).toHaveLength(1)
  })
})

describe('resolveActiveEditTarget', () => {
  const state = {
    preferredPath: 'files/old.html',
    documents: [
      {
        path: 'files/old.html',
        role: 'edited' as const,
        lastTouchedAt: '2026-01-01T00:00:00.000Z',
        name: 'old.html',
      },
      {
        path: 'files/other.html',
        role: 'generated' as const,
        lastTouchedAt: '2026-01-02T00:00:00.000Z',
        name: 'other.html',
      },
    ],
  }

  it('lets a new current-turn upload win over preferred', () => {
    const resolved = resolveActiveEditTarget({
      state,
      currentTurnPaths: ['uploads/new.html'],
      message: 'change the title',
    })
    expect(resolved).toEqual({
      preferredPath: 'uploads/new.html',
      reason: 'current_upload',
      candidates: ['uploads/new.html'],
    })
  })

  it('honors an explicit filename in the message', () => {
    const resolved = resolveActiveEditTarget({
      state,
      currentTurnPaths: [],
      message: 'Update other.html heading to Done',
    })
    expect(resolved.reason).toBe('explicit_name')
    expect(resolved.preferredPath).toBe('files/other.html')
  })

  it('uses preferred on vague follow-ups even when older docs remain', () => {
    const resolved = resolveActiveEditTarget({
      state,
      currentTurnPaths: [],
      message: 'make the title bigger',
    })
    expect(resolved.reason).toBe('preferred')
    expect(resolved.preferredPath).toBe('files/old.html')
  })

  it('is ambiguous when multiple docs exist and preferred is unset', () => {
    const resolved = resolveActiveEditTarget({
      state: {
        preferredPath: null,
        documents: state.documents,
      },
      currentTurnPaths: [],
      message: 'make the title bigger',
    })
    expect(resolved.reason).toBe('ambiguous')
    expect(resolved.preferredPath).toBeNull()
    expect(resolved.candidates).toEqual(
      expect.arrayContaining(['files/old.html', 'files/other.html'])
    )
  })

  it('is ambiguous when multiple new uploads arrive together', () => {
    const resolved = resolveActiveEditTarget({
      state,
      currentTurnPaths: ['uploads/a.html', 'uploads/b.html'],
      message: 'fix the layout',
    })
    expect(resolved.reason).toBe('ambiguous')
    expect(resolved.preferredPath).toBeNull()
  })
})

describe('updateActiveDocumentsFromTurn', () => {
  it('tracks uploads and successful create/edit tools', () => {
    const next = updateActiveDocumentsFromTurn({
      previous: null,
      currentTurnUploadPaths: ['uploads/shot.png'],
      now: '2026-03-01T00:00:00.000Z',
      toolRecords: [
        {
          name: 'create_file',
          success: true,
          result: {
            success: true,
            data: { vfsPath: 'files/Care_Plan.html', name: 'Care_Plan.html' },
          },
        },
        {
          name: 'workspace_file',
          success: true,
          result: {
            success: true,
            data: { vfsPath: 'files/Care_Plan.html', operation: 'patch' },
          },
        },
      ],
    })

    expect(next?.preferredPath).toBe('files/Care_Plan.html')
    expect(next?.documents.map((doc) => doc.path)).toEqual(
      expect.arrayContaining(['uploads/shot.png', 'files/Care_Plan.html'])
    )
    expect(next?.documents.find((doc) => doc.path === 'files/Care_Plan.html')?.role).toBe('edited')
  })

  it('ignores failed patch tools', () => {
    const previous = touchActiveDocument(null, {
      path: 'files/page.html',
      role: 'generated',
      lastTouchedAt: '2026-01-01T00:00:00.000Z',
    })
    const next = updateActiveDocumentsFromTurn({
      previous,
      currentTurnUploadPaths: [],
      toolRecords: [
        {
          name: 'workspace_file',
          success: false,
          result: { success: false, errorType: 'search_not_found', recoverable: true },
        },
      ],
    })
    expect(next?.preferredPath).toBe('files/page.html')
  })
})

describe('extractActiveDocumentTouch', () => {
  it('maps materialize message paths', () => {
    const touch = extractActiveDocumentTouch('materialize_file', true, {
      success: true,
      message: 'File "a.html" materialized. It is now available at files/a.html and will persist.',
    })
    expect(touch?.path).toBe('files/a.html')
    expect(touch?.role).toBe('upload')
  })
})

describe('pathsFromCurrentTurnUploads', () => {
  it('collects attachment and context upload paths', () => {
    expect(
      pathsFromCurrentTurnUploads({
        fileAttachments: [{ filename: 'a.html' }],
        contexts: [
          {
            type: 'uploaded_file',
            content: 'File "b.html" (text/html, 10 bytes) uploaded.',
          },
        ],
      })
    ).toEqual(['uploads/a.html', 'uploads/b.html'])
  })
})

describe('formatActiveDocumentsSystemMessage', () => {
  it('emits the active-documents prefix and resolution', () => {
    const state = clampActiveDocumentsState({
      preferredPath: 'files/a.html',
      documents: [
        {
          path: 'files/a.html',
          role: 'generated',
          lastTouchedAt: '2026-01-01T00:00:00.000Z',
          name: 'a.html',
        },
      ],
    })
    const message = formatActiveDocumentsSystemMessage(state, {
      preferredPath: 'files/a.html',
      reason: 'preferred',
      candidates: ['files/a.html'],
    })
    expect(message.content).toContain(ACTIVE_DOCUMENTS_SYSTEM_PREFIX)
    expect(message.content).toContain('files/a.html')
    expect(message.content).toContain('Current-turn uploads win')
  })
})
