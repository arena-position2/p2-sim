/**
 * Arena Copilot leaf names ↔ shared server-registry / schema ids.
 *
 * Local Copilot and the server router both consume this map so dual registry
 * keys and AJV schema ids cannot drift. Do not duplicate these entries.
 */

/** Arena leaf names → Cloud/server registry + generated schema ids. */
export const ARENA_TO_SERVER_REGISTRY_TOOL_NAME = {
  create_file: 'create_empty_file',
  workspace_file: 'prepare_file_edit',
  edit_content: 'apply_file_edit',
  knowledge_base: 'manage_knowledge_base',
  search_online: 'web_search',
  function_execute: 'run_function',
  /** Promotes chat `uploads/…` into workspace `files/…` (Cloud id: save_upload). */
  materialize_file: 'save_upload',
} as const

export type ArenaAliasedServerToolName = keyof typeof ARENA_TO_SERVER_REGISTRY_TOOL_NAME

/** File pipeline tools that must never fall through to the app-tool executor. */
export const ARENA_FILE_PIPELINE_TOOL_NAMES = [
  'create_file',
  'workspace_file',
  'edit_content',
] as const satisfies readonly ArenaAliasedServerToolName[]

/**
 * Arena tools that must resolve via the mapped server/handler id (schema +
 * execution). Missing a mapping here yields empty LLM schemas and "Tool not found".
 */
export const ARENA_ALIASED_SERVER_TOOL_NAMES = [
  ...ARENA_FILE_PIPELINE_TOOL_NAMES,
  'knowledge_base',
  'search_online',
  'function_execute',
  'materialize_file',
] as const satisfies readonly ArenaAliasedServerToolName[]

/**
 * Arena leaf names that are dual-registered on the server tool router (same
 * handler as the Cloud id). `function_execute` / `materialize_file` are
 * intentionally excluded — they execute via `executeTool('run_function' |
 * 'save_upload')`, not ServerToolAdapter.
 */
export const ARENA_DUAL_REGISTERED_SERVER_TOOL_NAMES = [
  'create_file',
  'workspace_file',
  'edit_content',
  'knowledge_base',
  'search_online',
] as const satisfies readonly ArenaAliasedServerToolName[]

/** Schema-id aliases for AJV validation of Arena leaf payloads. */
export const ARENA_SERVER_TOOL_SCHEMA_ALIASES: Readonly<
  Record<(typeof ARENA_DUAL_REGISTERED_SERVER_TOOL_NAMES)[number], string>
> = {
  create_file: ARENA_TO_SERVER_REGISTRY_TOOL_NAME.create_file,
  workspace_file: ARENA_TO_SERVER_REGISTRY_TOOL_NAME.workspace_file,
  edit_content: ARENA_TO_SERVER_REGISTRY_TOOL_NAME.edit_content,
  knowledge_base: ARENA_TO_SERVER_REGISTRY_TOOL_NAME.knowledge_base,
  search_online: ARENA_TO_SERVER_REGISTRY_TOOL_NAME.search_online,
}

/** Maps an Arena-facing tool name to the in-process server/handler/schema id. */
export function toServerRegistryToolName(toolName: string): string {
  return ARENA_TO_SERVER_REGISTRY_TOOL_NAME[toolName as ArenaAliasedServerToolName] ?? toolName
}

export function isArenaFilePipelineTool(toolName: string): boolean {
  return (ARENA_FILE_PIPELINE_TOOL_NAMES as readonly string[]).includes(toolName)
}

export function isArenaAliasedServerTool(toolName: string): boolean {
  return (ARENA_ALIASED_SERVER_TOOL_NAMES as readonly string[]).includes(toolName)
}
