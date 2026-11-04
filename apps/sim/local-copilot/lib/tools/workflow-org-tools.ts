import { createLogger } from '@sim/logger'
import { getErrorMessage, toError } from '@sim/utils/errors'
import { isRecordLike, toArray } from '@sim/utils/object'
import {
  executeCopilotWorkflowUseCase,
  messageForCopilotWorkflowError,
} from '@/lib/mothership/application/execute-workflow-use-case'
import { applyWorkflowOperations } from '@/lib/workflows/application/apply-workflow-operations'
import { deleteWorkflow } from '@/lib/workflows/application/delete-workflow'
import { moveWorkflowsBulk } from '@/lib/workflows/application/move-workflows-bulk'
import { updateWorkflow } from '@/lib/workflows/application/update-workflow'
import { applyWorkflowVariableOperations } from '@/lib/workflows/application/update-workflow-content'
import {
  createWorkflowFolder,
  deleteWorkflowFolder,
  listWorkflowFolders,
  relocateWorkflowFolder,
} from '@/lib/workflows/application/workflow-folders'
import { toCopilotServerToolContext } from '@/local-copilot/lib/tools/copilot-server-tool-context'
import type { ToolExecutionContext } from '@/local-copilot/lib/tools/executor'

const logger = createLogger('LocalCopilotWorkflowOrgTools')

export const WORKFLOW_ORG_TOOL_NAMES = [
  'rename_workflow',
  'move_workflow',
  'delete_workflow',
  'manage_folder',
  'set_global_workflow_variables',
  'set_block_enabled',
] as const

export type WorkflowOrgToolName = (typeof WORKFLOW_ORG_TOOL_NAMES)[number]

export function isWorkflowOrgToolName(toolName: string): toolName is WorkflowOrgToolName {
  return (WORKFLOW_ORG_TOOL_NAMES as readonly string[]).includes(toolName)
}

export interface WorkflowOrgToolResult {
  success: boolean
  output?: unknown
  error?: string
}

/**
 * Arena Local Copilot workflow organization tools (rename/move/delete/folders/
 * variables/block enable). Kept under local-copilot — Cloud mothership handlers
 * for these leaves are gone.
 */
export async function executeWorkflowOrgTool(
  toolName: WorkflowOrgToolName,
  rawParams: Record<string, unknown>,
  ctx: ToolExecutionContext
): Promise<WorkflowOrgToolResult> {
  try {
    switch (toolName) {
      case 'rename_workflow':
        return await executeRenameWorkflow(rawParams, ctx)
      case 'move_workflow':
        return await executeMoveWorkflow(rawParams, ctx)
      case 'delete_workflow':
        return await executeDeleteWorkflow(rawParams, ctx)
      case 'manage_folder':
        return await executeManageFolder(rawParams, ctx)
      case 'set_global_workflow_variables':
        return await executeSetGlobalWorkflowVariables(rawParams, ctx)
      case 'set_block_enabled':
        return await executeSetBlockEnabled(rawParams, ctx)
    }
  } catch (error) {
    logger.error(`local ${toolName} failed`, {
      error: toError(error).message,
      workspaceId: ctx.workspaceId,
    })
    return {
      success: false,
      error: messageForCopilotWorkflowError(error, getErrorMessage(error, `${toolName} failed`)),
    }
  }
}

async function executeRenameWorkflow(
  params: Record<string, unknown>,
  ctx: ToolExecutionContext
): Promise<WorkflowOrgToolResult> {
  const workflowId = stringArg(params, 'workflowId') ?? ctx.workflowId
  if (!workflowId) return { success: false, error: 'workflowId is required' }
  const name = stringArg(params, 'name')
  if (!name) return { success: false, error: 'name is required' }
  if (name.length > 200) {
    return { success: false, error: 'Workflow name must be 200 characters or less' }
  }

  const toolContext = toCopilotServerToolContext(ctx)
  await executeCopilotWorkflowUseCase(toolContext, updateWorkflow, {
    workflowId,
    assertedWorkspaceId: ctx.workspaceId,
    name,
  })
  return { success: true, output: { workflowId, name } }
}

async function executeMoveWorkflow(
  params: Record<string, unknown>,
  ctx: ToolExecutionContext
): Promise<WorkflowOrgToolResult> {
  const workflowIds = stringArrayArg(params, 'workflowIds')
  if (!workflowIds || workflowIds.length === 0) {
    return { success: false, error: 'workflowIds is required' }
  }
  if (!ctx.workspaceId) return { success: false, error: 'Workspace context is required' }

  const folderId =
    params.folderId === null
      ? null
      : typeof params.folderId === 'string'
        ? params.folderId.trim() || null
        : null

  const toolContext = toCopilotServerToolContext(ctx)
  const result = await executeCopilotWorkflowUseCase(toolContext, moveWorkflowsBulk, {
    workspaceId: ctx.workspaceId,
    workflowIds,
    folderId,
  })

  return {
    success: result.moved.length > 0,
    output: { moved: result.moved, failed: result.failed, folderId: result.folderId },
    ...(result.moved.length === 0 ? { error: 'No workflows were moved' } : {}),
  }
}

async function executeDeleteWorkflow(
  params: Record<string, unknown>,
  ctx: ToolExecutionContext
): Promise<WorkflowOrgToolResult> {
  const workflowIds = stringArrayArg(params, 'workflowIds')
  if (!workflowIds || workflowIds.length === 0) {
    const single = stringArg(params, 'workflowId')
    if (!single) return { success: false, error: 'workflowIds is required' }
    return deleteOneWorkflow(single, ctx)
  }

  const deleted: string[] = []
  const failed: Array<{ workflowId: string; error: string }> = []
  for (const workflowId of workflowIds) {
    const result = await deleteOneWorkflow(workflowId, ctx)
    if (result.success) deleted.push(workflowId)
    else failed.push({ workflowId, error: result.error ?? 'Failed to delete' })
  }

  return {
    success: deleted.length > 0,
    output: { deleted, failed },
    ...(deleted.length === 0 ? { error: 'No workflows were deleted' } : {}),
  }
}

async function deleteOneWorkflow(
  workflowId: string,
  ctx: ToolExecutionContext
): Promise<WorkflowOrgToolResult> {
  const toolContext = toCopilotServerToolContext(ctx)
  await executeCopilotWorkflowUseCase(toolContext, deleteWorkflow, {
    workflowId,
    assertedWorkspaceId: ctx.workspaceId,
  })
  return { success: true, output: { workflowId, deleted: true } }
}

async function executeManageFolder(
  params: Record<string, unknown>,
  ctx: ToolExecutionContext
): Promise<WorkflowOrgToolResult> {
  if (!ctx.workspaceId) return { success: false, error: 'Workspace context is required' }
  const operation = stringArg(params, 'operation')?.toLowerCase()
  if (!operation) {
    return { success: false, error: 'operation is required (create|list|rename|move|delete)' }
  }

  const toolContext = toCopilotServerToolContext(ctx)

  if (operation === 'list') {
    const listPath = stringArg(params, 'path')
    const result = await executeCopilotWorkflowUseCase(toolContext, listWorkflowFolders, {
      workspaceId: ctx.workspaceId,
      parentPath: listPath ? workflowFolderRelativePath(listPath) : undefined,
      sortBy: 'name',
      sortOrder: 'asc',
    })
    return {
      success: true,
      output: {
        folders: result.folders.map((folder) => ({
          id: folder.id,
          name: folder.name,
          parentId: folder.parentId,
        })),
        count: result.folders.length,
      },
    }
  }

  if (operation === 'create') {
    const path = stringArg(params, 'path')
    if (!path) {
      return { success: false, error: 'path is required for create (e.g. workflows/Marketing)' }
    }
    const result = await executeCopilotWorkflowUseCase(toolContext, createWorkflowFolder, {
      workspaceId: ctx.workspaceId,
      path: workflowFolderRelativePath(path),
    })
    return {
      success: true,
      output: { folderId: result.folder.id, name: result.folder.name, path },
    }
  }

  if (operation === 'rename' || operation === 'move') {
    const path = stringArg(params, 'path')
    if (!path) return { success: false, error: 'path is required for rename/move' }
    const destinationPath = stringArg(params, 'destinationPath') ?? stringArg(params, 'newPath')
    if (!destinationPath) {
      return { success: false, error: 'destinationPath is required for rename/move' }
    }
    const result = await executeCopilotWorkflowUseCase(toolContext, relocateWorkflowFolder, {
      workspaceId: ctx.workspaceId,
      path: workflowFolderRelativePath(path),
      destinationPath: workflowFolderRelativePath(destinationPath),
    })
    return {
      success: true,
      output: {
        folderId: result.folder.id,
        name: result.folder.name,
        path,
        destinationPath,
      },
    }
  }

  if (operation === 'delete') {
    const path = stringArg(params, 'path')
    if (!path) return { success: false, error: 'path is required for delete' }
    const result = await executeCopilotWorkflowUseCase(toolContext, deleteWorkflowFolder, {
      workspaceId: ctx.workspaceId,
      path: workflowFolderRelativePath(path),
      recursive: booleanArg(params, 'recursive') ?? true,
    })
    return {
      success: true,
      output: {
        path: result.path,
        folderId: result.folderId,
        folderName: result.folderName,
        deletedItems: result.deletedItems,
      },
    }
  }

  return {
    success: false,
    error: `Unsupported manage_folder operation: ${operation}`,
  }
}

async function executeSetGlobalWorkflowVariables(
  params: Record<string, unknown>,
  ctx: ToolExecutionContext
): Promise<WorkflowOrgToolResult> {
  const workflowId = stringArg(params, 'workflowId') ?? ctx.workflowId
  if (!workflowId) return { success: false, error: 'workflowId is required' }

  const operations = toArray(params.operations).filter(isRecordLike)
  if (operations.length === 0) {
    return { success: false, error: 'operations array is required' }
  }

  const normalized = operations.flatMap((entry) => {
    const name = typeof entry.name === 'string' ? entry.name.trim() : ''
    const op = typeof entry.operation === 'string' ? entry.operation.trim().toLowerCase() : 'edit'
    if (!name) return []
    if (op === 'delete') return [{ operation: 'delete' as const, name }]
    return [
      {
        operation: (op === 'add' ? 'add' : 'edit') as 'add' | 'edit',
        name,
        ...(typeof entry.type === 'string' ? { type: entry.type } : {}),
        ...(entry.value !== undefined ? { value: entry.value } : {}),
      },
    ]
  })
  if (normalized.length === 0) {
    return { success: false, error: 'operations must include at least one named variable op' }
  }

  const toolContext = toCopilotServerToolContext(ctx)
  const result = await executeCopilotWorkflowUseCase(toolContext, applyWorkflowVariableOperations, {
    workflowId,
    assertedWorkspaceId: ctx.workspaceId,
    operations: normalized,
  })

  return { success: true, output: { updated: result.updated, changed: result.changed } }
}

async function executeSetBlockEnabled(
  params: Record<string, unknown>,
  ctx: ToolExecutionContext
): Promise<WorkflowOrgToolResult> {
  const workflowId = stringArg(params, 'workflowId') ?? ctx.workflowId
  if (!workflowId) return { success: false, error: 'workflowId is required' }
  const blockId = stringArg(params, 'blockId')
  if (!blockId) return { success: false, error: 'blockId is required' }
  if (typeof params.enabled !== 'boolean') {
    return { success: false, error: 'enabled must be a boolean' }
  }

  const toolContext = toCopilotServerToolContext(ctx)
  const result = await executeCopilotWorkflowUseCase(toolContext, applyWorkflowOperations, {
    workflowId,
    assertedWorkspaceId: ctx.workspaceId,
    operations: [],
    blockEnabledChanges: [{ blockId, enabled: params.enabled }],
  })

  return {
    success: true,
    output: {
      workflowId,
      blockId,
      enabled: params.enabled,
      success: result.success,
    },
  }
}

function workflowFolderRelativePath(rawPath: string): string {
  const trimmed = rawPath.trim().replace(/^\/+|\/+$/g, '')
  if (!trimmed || trimmed === 'workflows') return ''
  return trimmed.startsWith('workflows/') ? trimmed.slice('workflows/'.length) : trimmed
}

function stringArg(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key]
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function stringArrayArg(params: Record<string, unknown>, key: string): string[] | undefined {
  const value = params[key]
  if (!Array.isArray(value)) return undefined
  const items = value
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim())
    .filter(Boolean)
  return items.length > 0 ? items : undefined
}

function booleanArg(params: Record<string, unknown>, key: string): boolean | undefined {
  const value = params[key]
  return typeof value === 'boolean' ? value : undefined
}
