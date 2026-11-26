/**
 * LLM catalog allows `path` for type=file; Zod openResourceInputSchema is
 * strict + id-only. Resolve path → id and strip unrecognized keys before
 * the mothership handler runs.
 */

import { createLogger } from '@sim/logger'
import { resolveWorkspaceFileReference } from '@/lib/uploads/contexts/workspace/workspace-file-manager'
import type { ToolExecutionContext, ToolExecutionResult } from '@/local-copilot/lib/tools/executor'

const logger = createLogger('LocalCopilotEnrichOpenResource')

const OPEN_RESOURCE_TYPES = new Set([
  'workflow',
  'table',
  'knowledgebase',
  'file',
  'dashboard',
  'log',
  'test',
])

/**
 * Normalizes open_resource args for the strict Zod contract.
 * Returns a ToolExecutionResult when a file path cannot be resolved.
 */
export async function enrichOpenResourceArgs(
  args: Record<string, unknown>,
  ctx: ToolExecutionContext
): Promise<ToolExecutionResult | null> {
  const rawResources = args.resources
  if (!Array.isArray(rawResources) || rawResources.length === 0) {
    return {
      toolName: 'open_resource',
      success: false,
      error:
        'open_resource requires resources: [{ type, id }] (or type "file" with path). Pass the file id from create_file, or path like files/Apps/Page.html.',
      result: { success: false, message: 'resources array required' },
    }
  }

  const next: Array<Record<string, unknown>> = []
  for (const item of rawResources) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return {
        toolName: 'open_resource',
        success: false,
        error: 'Each open_resource entry must be an object with type and id (or file path).',
        result: { success: false, message: 'invalid resource entry' },
      }
    }
    const resource = { ...(item as Record<string, unknown>) }
    const type = typeof resource.type === 'string' ? resource.type.trim() : ''
    if (!OPEN_RESOURCE_TYPES.has(type)) {
      return {
        toolName: 'open_resource',
        success: false,
        error: `Unsupported open_resource type "${type}". Use workflow, table, knowledgebase, file, dashboard, log, or test.`,
        result: { success: false, message: `unsupported type: ${type}` },
      }
    }

    // Zod uses viewId; LLM schema sometimes sends view (tables only).
    if (
      type === 'table' &&
      typeof resource.view === 'string' &&
      resource.view.trim() &&
      !resource.viewId
    ) {
      resource.viewId = resource.view.trim()
    }

    let id = typeof resource.id === 'string' ? resource.id.trim() : ''
    const path = typeof resource.path === 'string' ? resource.path.trim() : ''

    if (type === 'file' && !id && path) {
      const reference = path.replace(/\/content$/, '')
      const file = await resolveWorkspaceFileReference(ctx.workspaceId, reference, {
        includeChatUploads: true,
        includeOwnedFiles: true,
        chatId: ctx.chatId,
      })
      if (!file) {
        logger.info('open_resource path did not resolve', {
          workspaceId: ctx.workspaceId,
          path: reference,
        })
        return {
          toolName: 'open_resource',
          success: false,
          error: `No workspace file found for path "${reference}". Use the id from create_file, or a path under files/ or uploads/.`,
          result: { success: false, message: `file not found: ${reference}` },
        }
      }
      id = file.id
    }

    if (!id) {
      return {
        toolName: 'open_resource',
        success: false,
        error:
          type === 'file'
            ? 'open_resource file entries need id or path (e.g. files/Apps/Page.html).'
            : `open_resource ${type} entries require id.`,
        result: { success: false, message: 'id required' },
      }
    }

    const normalized: Record<string, unknown> = { type, id }
    if (type === 'table' && typeof resource.viewId === 'string' && resource.viewId.trim()) {
      normalized.viewId = resource.viewId.trim()
    }
    next.push(normalized)
  }

  args.resources = next
  // Optional workspaceId must match trusted context or the panel tool 404s.
  if (typeof args.workspaceId === 'string' && args.workspaceId.trim()) {
    args.workspaceId = ctx.workspaceId
  }
  return null
}
