/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import {
  isArenaAliasedServerTool,
  isArenaFilePipelineTool,
  resolveLocalCopilotToolName,
  toServerRegistryToolName,
} from '@/local-copilot/lib/tools/resolve-tool-name-alias'

describe('toServerRegistryToolName', () => {
  it('maps Arena file tools onto Cloud server registry ids', () => {
    expect(toServerRegistryToolName('create_file')).toBe('create_empty_file')
    expect(toServerRegistryToolName('workspace_file')).toBe('prepare_file_edit')
    expect(toServerRegistryToolName('edit_content')).toBe('apply_file_edit')
  })

  it('maps KB, search, sandbox, and upload Arena names onto Cloud ids', () => {
    expect(toServerRegistryToolName('knowledge_base')).toBe('manage_knowledge_base')
    expect(toServerRegistryToolName('search_online')).toBe('web_search')
    expect(toServerRegistryToolName('function_execute')).toBe('run_function')
    expect(toServerRegistryToolName('materialize_file')).toBe('save_upload')
  })

  it('leaves other tools unchanged', () => {
    expect(toServerRegistryToolName('create_file_folder')).toBe('create_file_folder')
    expect(toServerRegistryToolName('user_table')).toBe('user_table')
    expect(toServerRegistryToolName('run_workflow')).toBe('run_workflow')
  })
})

describe('resolveLocalCopilotToolName', () => {
  it('remaps Cloud tool names onto Arena leaf tools', () => {
    for (const [cloud, arena] of [
      ['prepare_file_edit', 'workspace_file'],
      ['apply_file_edit', 'edit_content'],
      ['create_empty_file', 'create_file'],
      ['manage_knowledge_base', 'knowledge_base'],
      ['web_search', 'search_online'],
      ['run_function', 'function_execute'],
      ['save_upload', 'materialize_file'],
    ] as const) {
      expect(resolveLocalCopilotToolName(cloud)).toEqual({ kind: 'ok', name: arena })
    }
  })

  it('keeps Arena create_file as create_file', () => {
    expect(resolveLocalCopilotToolName('create_file')).toEqual({
      kind: 'ok',
      name: 'create_file',
    })
  })
})

describe('isArenaFilePipelineTool / isArenaAliasedServerTool', () => {
  it('recognizes the office write pipeline', () => {
    expect(isArenaFilePipelineTool('create_file')).toBe(true)
    expect(isArenaFilePipelineTool('function_execute')).toBe(false)
  })

  it('recognizes all aliased Arena server tools', () => {
    expect(isArenaAliasedServerTool('create_file')).toBe(true)
    expect(isArenaAliasedServerTool('knowledge_base')).toBe(true)
    expect(isArenaAliasedServerTool('search_online')).toBe(true)
    expect(isArenaAliasedServerTool('function_execute')).toBe(true)
    expect(isArenaAliasedServerTool('materialize_file')).toBe(true)
    expect(isArenaAliasedServerTool('user_table')).toBe(false)
  })
})
