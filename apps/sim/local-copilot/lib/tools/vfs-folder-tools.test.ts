/**
 * @vitest-environment node
 *
 * Protects A1 folder thrash: list/create_file_folder must not return
 * "Tool not found" — stubs redirect to create_file with path prefixes.
 */
import { describe, expect, it } from 'vitest'
import type { ToolExecutionContext } from '@/local-copilot/lib/tools/executor'
import {
  executeLocalFileFolderTool,
  isLocalFileFolderToolName,
} from '@/local-copilot/lib/tools/vfs-folder-tools'

const ctx: ToolExecutionContext = {
  userId: 'user-1',
  workspaceId: 'workspace-1',
  structuredContext: {},
}

describe('isLocalFileFolderToolName', () => {
  it('matches the folder leaf set', () => {
    expect(isLocalFileFolderToolName('list_file_folders')).toBe(true)
    expect(isLocalFileFolderToolName('create_file_folder')).toBe(true)
    expect(isLocalFileFolderToolName('create_file')).toBe(false)
  })
})

describe('executeLocalFileFolderTool', () => {
  it('list/create succeed with create_file redirect (not Tool not found)', async () => {
    const listed = await executeLocalFileFolderTool('list_file_folders', {}, ctx)
    expect(listed.success).toBe(true)
    expect(listed.error).toBeUndefined()
    expect(JSON.stringify(listed.result)).toMatch(/create_file/i)
    expect(JSON.stringify(listed.result)).not.toMatch(/Tool not found/i)

    const created = await executeLocalFileFolderTool('create_file_folder', { name: 'Apps' }, ctx)
    expect(created.success).toBe(true)
    expect(JSON.stringify(created.result)).toMatch(/create_file/i)
    expect(JSON.stringify(created.result)).toMatch(/files\/Apps/i)
  })

  it('rename/move/delete fail closed with file-tool guidance', async () => {
    for (const toolName of [
      'rename_file_folder',
      'move_file_folder',
      'delete_file_folder',
    ] as const) {
      const result = await executeLocalFileFolderTool(toolName, {}, ctx)
      expect(result.success).toBe(false)
      expect(result.error).toMatch(/not available/i)
      expect(result.error).not.toMatch(/Tool not found/i)
    }
  })
})
