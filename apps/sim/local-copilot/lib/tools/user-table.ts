import { createLogger } from '@sim/logger'
import { getErrorMessage, toError } from '@sim/utils/errors'
import { isRecordLike, toArray, toRecord } from '@sim/utils/object'
import { executeCopilotTableUseCase } from '@/lib/mothership/application/execute-table-use-case'
import {
  executeCopilotWorkflowUseCase,
  messageForCopilotWorkflowError,
} from '@/lib/mothership/application/execute-workflow-use-case'
import { messageForCopilotTableError } from '@/lib/mothership/auth/table-delegation'
import {
  addTableColumnUseCase,
  deleteTableColumnUseCase,
  updateTableColumnUseCase,
} from '@/lib/table/application/columns'
import { createTableGroupUseCase } from '@/lib/table/application/groups'
import {
  createTableRows,
  deleteTableRow,
  queryTableRows,
  readTableRow,
  updateTableRow,
} from '@/lib/table/application/rows'
import {
  createTableUseCase,
  deleteTableUseCase,
  readTableUseCase,
  updateTableUseCase,
} from '@/lib/table/application/tables'
import { columnTypeForLeaf, deriveOutputColumnName } from '@/lib/table/column-naming'
import type { ColumnDefinition, RowData, TablePredicate, TableSchema } from '@/lib/table/types'
import { resolveWorkflowOutputs } from '@/lib/workflows/application/resolve-workflow-outputs'
import { toCopilotServerToolContext } from '@/local-copilot/lib/tools/copilot-server-tool-context'
import type { ToolExecutionContext, ToolExecutionResult } from '@/local-copilot/lib/tools/executor'

const logger = createLogger('LocalCopilotUserTable')

/** Catalog id — Cloud implements this as a sim-route Go tool; Arena runs it locally. */
export const USER_TABLE_TOOL_NAME = 'user_table' as const

const SUPPORTED_OPERATIONS = new Set([
  'create',
  'get',
  'get_schema',
  'rename',
  'insert_row',
  'batch_insert_rows',
  'get_row',
  'query_rows',
  'update_row',
  'delete_row',
  'add_column',
  'rename_column',
  'delete_column',
  'update_column',
  'add_workflow_group',
  'list_workflow_outputs',
  'delete',
])

type UserTableSuccess = {
  success: true
  message: string
  data: unknown
}

type UserTableFailure = {
  success: false
  message: string
  data?: unknown
}

function ok(message: string, data: unknown): UserTableSuccess {
  return { success: true, message, data }
}

function fail(message: string, data?: unknown): UserTableFailure {
  return data === undefined ? { success: false, message } : { success: false, message, data }
}

function stringArg(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key]
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function requireTableId(args: Record<string, unknown>): string | UserTableFailure {
  const tableId = stringArg(args, 'tableId')
  if (!tableId) return fail('args.tableId is required')
  return tableId
}

function parseSchema(raw: unknown): TableSchema | UserTableFailure {
  if (!isRecordLike(raw)) return fail('args.schema must be an object with a columns array')
  const columnsRaw = toArray(raw.columns)
  const columns: ColumnDefinition[] = []
  for (const entry of columnsRaw) {
    if (!isRecordLike(entry)) return fail('args.schema.columns entries must be objects')
    const name = typeof entry.name === 'string' ? entry.name.trim() : ''
    const type = typeof entry.type === 'string' ? entry.type.trim() : ''
    if (!name || !type) return fail('Each schema column needs name and type')
    columns.push({
      name,
      type: type as ColumnDefinition['type'],
      ...(typeof entry.id === 'string' && entry.id.trim() ? { id: entry.id.trim() } : {}),
      ...(typeof entry.unique === 'boolean' ? { unique: entry.unique } : {}),
      ...(typeof entry.required === 'boolean' ? { required: entry.required } : {}),
      ...(Array.isArray(entry.options)
        ? { options: entry.options as ColumnDefinition['options'] }
        : {}),
      ...(typeof entry.multiple === 'boolean' ? { multiple: entry.multiple } : {}),
    })
  }
  return { columns }
}

function projectTable(table: {
  id: string
  name: string
  description?: string | null
  schema: TableSchema
  workspaceId: string
}) {
  return {
    id: table.id,
    name: table.name,
    description: table.description ?? null,
    workspaceId: table.workspaceId,
    schema: table.schema,
    columns: table.schema.columns,
    workflowGroups: table.schema.workflowGroups ?? [],
  }
}

/**
 * Arena Local Copilot `user_table` — covers the scraper→table path and common
 * CRUD. Cloud still serves the full Go surface; unimplemented ops fail with a
 * clear message instead of "Tool not found".
 */
export async function executeUserTable(
  rawParams: Record<string, unknown>,
  ctx: ToolExecutionContext
): Promise<ToolExecutionResult> {
  const operation = String(rawParams.operation ?? '')
    .trim()
    .toLowerCase()
  const args = isRecordLike(rawParams.args) ? toRecord(rawParams.args) : toRecord(rawParams)

  if (!operation) {
    return {
      toolName: USER_TABLE_TOOL_NAME,
      success: false,
      error: "Missing required 'operation' argument",
      result: fail("Missing required 'operation' argument"),
    }
  }

  if (!SUPPORTED_OPERATIONS.has(operation)) {
    const message = `user_table operation "${operation}" is not available in Arena Local Copilot yet. Supported: ${[...SUPPORTED_OPERATIONS].join(', ')}.`
    return {
      toolName: USER_TABLE_TOOL_NAME,
      success: false,
      error: message,
      result: fail(message),
    }
  }

  if (!ctx.workspaceId) {
    return {
      toolName: USER_TABLE_TOOL_NAME,
      success: false,
      error: 'workspaceId is required',
      result: fail('workspaceId is required'),
    }
  }

  const toolContext = toCopilotServerToolContext(ctx)
  if (!toolContext.toolCallId) {
    const message = 'user_table requires an active tool call id'
    return {
      toolName: USER_TABLE_TOOL_NAME,
      success: false,
      error: message,
      result: fail(message),
    }
  }

  try {
    const envelope = await dispatchUserTableOperation(operation, args, ctx, toolContext)
    return {
      toolName: USER_TABLE_TOOL_NAME,
      success: envelope.success,
      result: envelope,
      ...(envelope.success ? {} : { error: envelope.message }),
    }
  } catch (error) {
    logger.error('local user_table failed', {
      error: toError(error).message,
      operation,
      workspaceId: ctx.workspaceId,
    })
    const message = messageForCopilotTableError(
      error,
      getErrorMessage(error, `user_table ${operation} failed`)
    )
    return {
      toolName: USER_TABLE_TOOL_NAME,
      success: false,
      error: message,
      result: fail(message),
    }
  }
}

async function dispatchUserTableOperation(
  operation: string,
  args: Record<string, unknown>,
  ctx: ToolExecutionContext,
  toolContext: ReturnType<typeof toCopilotServerToolContext>
): Promise<UserTableSuccess | UserTableFailure> {
  const workspaceId = ctx.workspaceId

  switch (operation) {
    case 'create': {
      const name = stringArg(args, 'name')
      if (!name) return fail('args.name is required for create')
      let schema: TableSchema = { columns: [] }
      if (args.schema !== undefined) {
        const parsed = parseSchema(args.schema)
        if ('success' in parsed) return parsed
        schema = parsed
      }
      const result = await executeCopilotTableUseCase(toolContext, createTableUseCase, {
        workspaceId,
        name,
        ...(typeof args.description === 'string' ? { description: args.description } : {}),
        schema,
        ...(typeof args.folderPath === 'string' ? { folderPath: args.folderPath } : {}),
      })
      return ok(`Created table "${result.table.name}"`, {
        table: projectTable(result.table),
        folderPath: result.folderPath,
      })
    }

    case 'get':
    case 'get_schema': {
      const tableId = requireTableId(args)
      if (typeof tableId !== 'string') return tableId
      const result = await executeCopilotTableUseCase(
        toolContext,
        readTableUseCase,
        { tableId, workspaceId },
        { tableId }
      )
      return ok(
        operation === 'get_schema'
          ? `Schema for table "${result.table.name}"`
          : `Loaded table "${result.table.name}"`,
        {
          table: projectTable(result.table),
          folderPath: result.folderPath,
        }
      )
    }

    case 'rename': {
      const tableId = requireTableId(args)
      if (typeof tableId !== 'string') return tableId
      const name = stringArg(args, 'name')
      if (!name) return fail('args.name is required for rename')
      const result = await executeCopilotTableUseCase(
        toolContext,
        updateTableUseCase,
        { tableId, workspaceId, name },
        { tableId }
      )
      return ok(`Renamed table to "${name}"`, {
        table: result.table ? projectTable(result.table) : null,
        applied: result.applied,
      })
    }

    case 'delete': {
      const tableId = requireTableId(args)
      if (typeof tableId !== 'string') return tableId
      const result = await executeCopilotTableUseCase(
        toolContext,
        deleteTableUseCase,
        { tableId, workspaceId },
        { tableId }
      )
      return ok(`Deleted table "${result.tableName}"`, { tableId: result.id })
    }

    case 'add_column': {
      const tableId = requireTableId(args)
      if (typeof tableId !== 'string') return tableId
      const column = isRecordLike(args.column) ? args.column : null
      const name = column ? stringArg(column, 'name') : stringArg(args, 'columnName')
      const type = column
        ? typeof column.type === 'string'
          ? column.type.trim()
          : ''
        : typeof args.type === 'string'
          ? args.type.trim()
          : ''
      if (!name || !type) return fail('args.column { name, type } is required for add_column')
      const result = await executeCopilotTableUseCase(
        toolContext,
        addTableColumnUseCase,
        {
          tableId,
          workspaceId,
          column: {
            name,
            type,
            ...(column && typeof column.unique === 'boolean' ? { unique: column.unique } : {}),
            ...(column && typeof column.position === 'number' ? { position: column.position } : {}),
            ...(column && Array.isArray(column.options)
              ? { options: column.options as ColumnDefinition['options'] }
              : {}),
            ...(column && typeof column.multiple === 'boolean'
              ? { multiple: column.multiple }
              : {}),
          },
        },
        { tableId }
      )
      return ok(`Added column "${name}"`, { table: projectTable(result.table) })
    }

    case 'rename_column':
    case 'update_column': {
      const tableId = requireTableId(args)
      if (typeof tableId !== 'string') return tableId
      const columnName = stringArg(args, 'columnName')
      if (!columnName) return fail('args.columnName is required')
      const updates: {
        name?: string
        type?: ColumnDefinition['type']
        unique?: boolean
      } = {}
      const newName = stringArg(args, 'name') ?? stringArg(args, 'newName')
      if (newName) updates.name = newName
      if (typeof args.type === 'string' && args.type.trim()) {
        updates.type = args.type.trim() as ColumnDefinition['type']
      }
      if (typeof args.unique === 'boolean') updates.unique = args.unique
      if (Object.keys(updates).length === 0) {
        return fail('Provide name, type, and/or unique to update the column')
      }
      const result = await executeCopilotTableUseCase(
        toolContext,
        updateTableColumnUseCase,
        { tableId, workspaceId, columnName, updates },
        { tableId }
      )
      return ok(`Updated column "${columnName}"`, { table: projectTable(result.table) })
    }

    case 'delete_column': {
      const tableId = requireTableId(args)
      if (typeof tableId !== 'string') return tableId
      const columnNames = toArray(args.columnNames)
        .filter((entry): entry is string => typeof entry === 'string')
        .map((entry) => entry.trim())
        .filter(Boolean)
      const single = stringArg(args, 'columnName')
      const names = columnNames.length > 0 ? columnNames : single ? [single] : []
      if (names.length === 0) return fail('args.columnName or args.columnNames is required')
      let table = null as ReturnType<typeof projectTable> | null
      for (const columnName of names) {
        const result = await executeCopilotTableUseCase(
          toolContext,
          deleteTableColumnUseCase,
          { tableId, workspaceId, columnName },
          { tableId }
        )
        table = projectTable(result.table)
      }
      return ok(`Deleted column(s): ${names.join(', ')}`, { table })
    }

    case 'insert_row': {
      const tableId = requireTableId(args)
      if (typeof tableId !== 'string') return tableId
      if (!isRecordLike(args.data)) return fail('args.data is required for insert_row')
      const result = await executeCopilotTableUseCase(
        toolContext,
        createTableRows,
        {
          tableId,
          assertedWorkspaceId: workspaceId,
          kind: 'single',
          strictWrite: true,
          dataKeying: 'names',
          data: args.data as RowData,
          ...(typeof args.position === 'number' ? { position: args.position } : {}),
        },
        { tableId }
      )
      if (result.kind !== 'single') return fail('Unexpected insert_row result shape')
      return ok('Inserted row', { row: result.row, tableId })
    }

    case 'batch_insert_rows': {
      const tableId = requireTableId(args)
      if (typeof tableId !== 'string') return tableId
      const rows = toArray(args.rows).filter(isRecordLike) as RowData[]
      if (rows.length === 0) return fail('args.rows must be a non-empty array')
      const result = await executeCopilotTableUseCase(
        toolContext,
        createTableRows,
        {
          tableId,
          assertedWorkspaceId: workspaceId,
          kind: 'batch',
          strictWrite: true,
          dataKeying: 'names',
          rows,
        },
        { tableId }
      )
      if (result.kind !== 'batch') return fail('Unexpected batch_insert_rows result shape')
      return ok(`Inserted ${result.rows.length} row(s)`, { rows: result.rows, tableId })
    }

    case 'get_row': {
      const tableId = requireTableId(args)
      if (typeof tableId !== 'string') return tableId
      const rowId = stringArg(args, 'rowId')
      if (!rowId) return fail('args.rowId is required')
      const result = await executeCopilotTableUseCase(
        toolContext,
        readTableRow,
        { tableId, assertedWorkspaceId: workspaceId, rowId },
        { tableId }
      )
      return ok('Loaded row', { row: result.row })
    }

    case 'query_rows': {
      const tableId = requireTableId(args)
      if (typeof tableId !== 'string') return tableId
      const result = await executeCopilotTableUseCase(
        toolContext,
        queryTableRows,
        {
          tableId,
          assertedWorkspaceId: workspaceId,
          ...(isRecordLike(args.filter) ? { predicate: args.filter as TablePredicate } : {}),
          ...(typeof args.limit === 'number' ? { limit: args.limit } : {}),
          ...(typeof args.cursor === 'string' ? { cursor: args.cursor } : {}),
          includeTotal: true,
        },
        { tableId }
      )
      return ok(`Queried ${result.rows.length} row(s)`, {
        rows: result.rows,
        rowCount: result.rowCount,
        totalCount: result.totalCount,
        nextCursor: result.nextCursor,
        limit: result.limit,
        offset: result.offset,
      })
    }

    case 'update_row': {
      const tableId = requireTableId(args)
      if (typeof tableId !== 'string') return tableId
      const rowId = stringArg(args, 'rowId')
      if (!rowId) return fail('args.rowId is required')
      if (!isRecordLike(args.data)) return fail('args.data is required for update_row')
      const result = await executeCopilotTableUseCase(
        toolContext,
        updateTableRow,
        {
          tableId,
          assertedWorkspaceId: workspaceId,
          rowId,
          strictWrite: true,
          dataKeying: 'names',
          data: args.data as RowData,
        },
        { tableId }
      )
      return ok(result.changed ? 'Updated row' : 'Row unchanged', {
        row: result.row,
        changed: result.changed,
      })
    }

    case 'delete_row': {
      const tableId = requireTableId(args)
      if (typeof tableId !== 'string') return tableId
      const rowId = stringArg(args, 'rowId')
      if (!rowId) return fail('args.rowId is required')
      const result = await executeCopilotTableUseCase(
        toolContext,
        deleteTableRow,
        { tableId, assertedWorkspaceId: workspaceId, rowId },
        { tableId }
      )
      return ok('Deleted row', { deletedRowId: result.deletedRowId })
    }

    case 'list_workflow_outputs': {
      const workflowId = stringArg(args, 'workflowId')
      if (!workflowId) return fail('args.workflowId is required for list_workflow_outputs')
      try {
        const result = await executeCopilotWorkflowUseCase(toolContext, resolveWorkflowOutputs, {
          workflowId,
          assertedWorkspaceId: workspaceId,
        })
        return ok(`Listed outputs for workflow ${workflowId}`, {
          workflowId: result.workflowId,
          outputs: result.outputs ?? [],
          executionOrderByBlockId: result.executionOrderByBlockId,
        })
      } catch (error) {
        return fail(
          messageForCopilotWorkflowError(
            error,
            getErrorMessage(error, 'Failed to list workflow outputs')
          )
        )
      }
    }

    case 'add_workflow_group': {
      const tableId = requireTableId(args)
      if (typeof tableId !== 'string') return tableId
      const workflowId = stringArg(args, 'workflowId')
      if (!workflowId) return fail('args.workflowId is required for add_workflow_group')
      const outputsRaw = toArray(args.outputs)
      if (outputsRaw.length === 0) {
        return fail(
          'args.outputs must be a non-empty array of { blockId, path, columnName?, columnType? }'
        )
      }

      const taken = new Set<string>()
      const groupOutputs: Array<{
        blockId: string
        path: string
        columnName: string
      }> = []
      const outputColumns: Array<{ name: string; type: ColumnDefinition['type'] }> = []

      for (const entry of outputsRaw) {
        if (!isRecordLike(entry)) {
          return fail('Each outputs entry must be an object')
        }
        const blockId = stringArg(entry, 'blockId')
        const path = stringArg(entry, 'path')
        if (!blockId || !path) {
          return fail('Each outputs entry needs blockId and path')
        }
        const columnName = stringArg(entry, 'columnName') ?? deriveOutputColumnName(path, taken)
        taken.add(columnName)
        const columnType =
          typeof entry.columnType === 'string' && entry.columnType.trim()
            ? (entry.columnType.trim() as ColumnDefinition['type'])
            : columnTypeForLeaf(undefined)
        groupOutputs.push({ blockId, path, columnName })
        outputColumns.push({ name: columnName, type: columnType })
      }

      const dependencies = isRecordLike(args.dependencies)
        ? {
            columns: toArray(args.dependencies.columns).filter(
              (entry): entry is string => typeof entry === 'string' && entry.trim().length > 0
            ),
          }
        : undefined

      const result = await executeCopilotTableUseCase(
        toolContext,
        createTableGroupUseCase,
        {
          tableId,
          workspaceId,
          group: {
            workflowId,
            type: 'manual',
            outputs: groupOutputs,
            ...(dependencies ? { dependencies } : {}),
            deploymentMode: 'live',
            ...(typeof args.autoRun === 'boolean' ? { autoRun: args.autoRun } : {}),
          },
          outputColumns,
          autoRun: args.autoRun === true,
        },
        { tableId }
      )
      return ok('Added workflow group', {
        table: projectTable(result.table),
        group: result.group,
      })
    }

    default:
      return fail(`Unsupported operation: ${operation}`)
  }
}
