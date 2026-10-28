/**
 * Arena Copilot leaf names vs Cloud/server registry ids.
 *
 * The model only sees Arena names (`create_file`, `knowledge_base`,
 * `function_execute`, `search_online`, …). Shared handlers and generated JSON
 * schemas use Cloud catalog ids (`create_empty_file`, `manage_knowledge_base`,
 * `run_function`, `web_search`, …). Arena→server mapping lives in
 * `@/lib/mothership/tools/arena-server-tool-aliases` (shared with the server
 * router). This module adds Cloud→Arena remaps for hallucinated tool names.
 */

export {
  ARENA_ALIASED_SERVER_TOOL_NAMES,
  ARENA_DUAL_REGISTERED_SERVER_TOOL_NAMES,
  ARENA_FILE_PIPELINE_TOOL_NAMES,
  ARENA_SERVER_TOOL_SCHEMA_ALIASES,
  ARENA_TO_SERVER_REGISTRY_TOOL_NAME,
  isArenaAliasedServerTool,
  isArenaFilePipelineTool,
  toServerRegistryToolName,
} from '@/lib/mothership/tools/arena-server-tool-aliases'

/** Cloud/training names that should execute as Arena leaf tools. */
export const FILE_WRITE_ALIAS_NAMES = [
  'prepare_file_edit',
  'apply_file_edit',
  'edit_file',
  'file_edit',
  'create_empty_file',
] as const

export const FUNCTION_EXECUTE_ALIAS_NAMES = ['run_function'] as const

/** Cloud leaf names → Arena leaf names (what the model should keep calling). */
const CLOUD_TO_ARENA_TOOL_NAME: Readonly<Record<string, string>> = {
  prepare_file_edit: 'workspace_file',
  apply_file_edit: 'edit_content',
  edit_file: 'workspace_file',
  file_edit: 'workspace_file',
  create_empty_file: 'create_file',
  manage_knowledge_base: 'knowledge_base',
  web_search: 'search_online',
  run_function: 'function_execute',
  save_upload: 'materialize_file',
}

export type ResolvedLocalCopilotToolName =
  | { kind: 'ok'; name: string }
  | { kind: 'unsupported'; message: string }

/**
 * Remaps hallucinated Cloud tool names onto Arena leaf tools so they hit the
 * Arena executor — never "tool not found" for create_empty_file / web_search / …
 */
export function resolveLocalCopilotToolName(toolName: string): ResolvedLocalCopilotToolName {
  const fromCloud = CLOUD_TO_ARENA_TOOL_NAME[toolName]
  if (fromCloud) {
    return { kind: 'ok', name: fromCloud }
  }
  return { kind: 'ok', name: toolName }
}
