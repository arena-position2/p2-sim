/**
 * @vitest-environment node
 *
 * Failure modes under test:
 * - VFS ↔ canonical folder path conversion (files/Reports ↔ /Reports)
 * - root aliases (files, files/, /)
 * - percent-encoded segments round-trip
 */
import { describe, expect, it } from 'vitest'
import {
  toCanonicalFolderPath,
  vfsFolderPathFromCanonical,
} from '@/local-copilot/lib/tools/vfs-file-folder-tools'

describe('toCanonicalFolderPath / vfsFolderPathFromCanonical', () => {
  it('maps files root aliases to /', () => {
    expect(toCanonicalFolderPath('files')).toBe('/')
    expect(toCanonicalFolderPath('files/')).toBe('/')
    expect(toCanonicalFolderPath('/')).toBe('/')
  })

  it('maps files/Reports to /Reports', () => {
    expect(toCanonicalFolderPath('files/Reports')).toBe('/Reports')
    expect(vfsFolderPathFromCanonical('/Reports')).toBe('files/Reports')
  })

  it('round-trips nested and encoded segments', () => {
    const canonical = toCanonicalFolderPath('files/Reports%20Q3/Draft')
    expect(canonical).toBe('/Reports%20Q3/Draft')
    expect(vfsFolderPathFromCanonical(canonical)).toBe('files/Reports%20Q3/Draft')
  })

  it('accepts already-canonical paths', () => {
    expect(toCanonicalFolderPath('/Archive')).toBe('/Archive')
  })
})
