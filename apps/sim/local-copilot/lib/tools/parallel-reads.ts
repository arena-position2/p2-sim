/**
 * Read-only tools that are safe to execute concurrently within one model round.
 *
 * Exclusion rules (keep serial instead):
 * - Any mutation / write / deploy / delete / media generation
 * - Operation-polymorphic tools (`user_memory`, `user_table`, `knowledge_base`, …)
 * - File pipeline writers (`create_file`, `workspace_file`, `edit_content`, …)
 * - Tools that may require confirmation
 * - `open_resource` (UI side effects)
 * - `invoke_integration_tool` (may write to third parties)
 */
export const PARALLEL_READ_TOOL_NAMES = new Set<string>([
  'get_workflow_context',
  'get_workflow_data',
  'get_workflow_run_options',
  'get_available_blocks',
  'get_available_integrations',
  'get_blocks_metadata',
  'get_block_outputs',
  'get_block_upstream_references',
  'get_deployed_workflow_state',
  'get_deployment_log',
  'check_deployment_status',
  'get_platform_actions',
  'list_workspaces',
  'list_user_workspaces',
  'list_integration_tools',
  'list_workspace_mcp_servers',
  'list_file_folders',
  'search_docs',
  'search_documentation',
  'search_online',
  'explain_error',
  'read',
  'glob',
  'grep',
  'load_copilot_artifact',
  'load_user_skill',
  'query_logs',
  'get_execution_logs',
  'get_scheduled_task_logs',
  'diff_workflows',
])

/** Cap concurrent read executions to avoid stampeding the app / providers. */
export const MAX_PARALLEL_READ_TOOLS = 8

export function isParallelReadTool(toolName: string): boolean {
  return PARALLEL_READ_TOOL_NAMES.has(toolName)
}

export type LeafToolExecutionBatch<T extends { name: string }> =
  | { mode: 'parallel'; calls: T[] }
  | { mode: 'serial'; call: T }

/**
 * Groups consecutive parallel-read tools into batches while preserving order.
 * Non-read tools (and lone reads) stay serial so write/read ordering from
 * `sortToolCallsForExecution` is unchanged.
 */
export function partitionLeafToolCallsForExecution<T extends { name: string }>(
  calls: T[],
  options?: { maxParallel?: number; isSpecialist?: (name: string) => boolean }
): LeafToolExecutionBatch<T>[] {
  const maxParallel = options?.maxParallel ?? MAX_PARALLEL_READ_TOOLS
  const isSpecialist = options?.isSpecialist ?? (() => false)
  const batches: LeafToolExecutionBatch<T>[] = []
  let index = 0

  while (index < calls.length) {
    const call = calls[index]
    if (isSpecialist(call.name) || !isParallelReadTool(call.name)) {
      batches.push({ mode: 'serial', call })
      index += 1
      continue
    }

    const parallel: T[] = [call]
    let lookAhead = index + 1
    while (
      lookAhead < calls.length &&
      parallel.length < maxParallel &&
      !isSpecialist(calls[lookAhead].name) &&
      isParallelReadTool(calls[lookAhead].name)
    ) {
      parallel.push(calls[lookAhead])
      lookAhead += 1
    }

    if (parallel.length >= 2) {
      batches.push({ mode: 'parallel', calls: parallel })
      index = lookAhead
    } else {
      batches.push({ mode: 'serial', call })
      index += 1
    }
  }

  return batches
}
