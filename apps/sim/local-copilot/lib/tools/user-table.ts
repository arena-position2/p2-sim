/**
 * Local Arena Copilot handler for `user_table`.
 *
 * Cloud routes `user_table` (`route: 'sim'`) through the Mothership worker. Arena
 * Copilot has no worker for it, so without this handler the model gets
 * "Tool not found: user_table" and cannot create tables from chat. Lives under
 * `local-copilot` so upstream Sim syncs do not own the file.
 */
import { createLogger } from '@sim/logger'
import { toError } from '@sim/utils/errors'
import { isRecordLike, toArray, toRecord } from '@sim/utils/object'
import { executeCopilotTableUseCase } from '@/lib/mothership/application/execute-table-use-case'
import {
  type CopilotTableDelegationContext,
  messageForCopilotTableError,
} from '@/lib/mothership/auth/table-delegation'
import type {
  ToolExecutionContext,
  ToolExecutionResult,
  ToolHandler,
} from '@/lib/mothership/tool-executor/types'
import { addTableColumnUseCase } from '@/lib/table/application/columns'
import {
  createTableRows,
  deleteTableRow,
  queryTableRows,
  readTableRow,
  updateTableRow,
} from '@/lib/table/application/rows'
import {
  createTableUseCase,
  listTableDefinitionsUseCase,
  readTableUseCase,
  updateTableUseCase,
} from '@/lib/table/application/tables'
import { COLUMN_TYPES } from '@/lib/table/column-types/types'
import { TableLockedError } from '@/lib/table/mutation-locks'
import type {
  ColumnDefinition,
  ColumnType,
  RowData,
  TableRow,
  TableSchema,
} from '@/lib/table/types'

const logger = createLogger('LocalCopilotUserTable')

const SUPPORTED_COLUMN_TYPES = new Set<string>(COLUMN_TYPES)

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
  'list',
])

function fail(message: string): ToolExecutionResult {
  return { success: false, error: message, output: { success: false, message, error: message } }
}

function ok(message: string, data: Record<string, unknown>): ToolExecutionResult {
  return {
    success: true,
    output: { success: true, message, data },
  }
}

function requireWorkspaceId(context: ToolExecutionContext): string | ToolExecutionResult {
  const workspaceId = context.workspaceId?.trim()
  if (!workspaceId) {
    return fail('Workspace ID is required for user_table')
  }
  return workspaceId
}

function requireString(value: unknown, label: string): string | ToolExecutionResult {
  if (typeof value !== 'string' || !value.trim()) {
    return fail(`${label} is required`)
  }
  return value.trim()
}

function parseColumnType(raw: unknown): ColumnType | ToolExecutionResult {
  if (typeof raw !== 'string' || !SUPPORTED_COLUMN_TYPES.has(raw)) {
    return fail(
      `Invalid column type "${String(raw)}". Supported: ${[...SUPPORTED_COLUMN_TYPES].join(', ')}`
    )
  }
  return raw as ColumnType
}

function parseSchema(raw: unknown): TableSchema | ToolExecutionResult {
  const schema = toRecord(raw)
  const columnsRaw = toArray(schema.columns)
  if (columnsRaw.length === 0) {
    return fail('schema.columns must be a non-empty array')
  }

  const columns: ColumnDefinition[] = []
  for (const entry of columnsRaw) {
    const column = toRecord(entry)
    const name = typeof column.name === 'string' ? column.name.trim() : ''
    if (!name) {
      return fail('Each schema column requires a non-empty name')
    }
    const type = parseColumnType(column.type)
    if (typeof type !== 'string') return type

    const definition: ColumnDefinition = { name, type }
    if (typeof column.required === 'boolean') definition.required = column.required
    if (typeof column.unique === 'boolean') definition.unique = column.unique
    if (typeof column.multiple === 'boolean') definition.multiple = column.multiple
    if (typeof column.currencyCode === 'string' && column.currencyCode.trim()) {
      definition.currencyCode = column.currencyCode.trim()
    }
    columns.push(definition)
  }

  return { columns }
}

function parseRowData(raw: unknown, label: string): RowData | ToolExecutionResult {
  if (!isRecordLike(raw)) {
    return fail(`${label} must be an object of column-name → value`)
  }
  return raw as RowData
}

function toTableContext(context: ToolExecutionContext): CopilotTableDelegationContext {
  return {
    userId: context.userId,
    workspaceId: context.workspaceId,
    workflowId: context.workflowId,
    chatId: context.chatId,
    executionId: context.executionId,
    toolCallId: context.toolCallId,
    copilotToolExecution: context.copilotToolExecution ?? true,
    copilotInteractionMode: context.copilotInteractionMode,
    requestMode: context.requestMode,
  }
}

function summarizeTable(table: {
  id: string
  name: string
  description?: string | null
  schema: TableSchema
  workspaceId: string
  createdAt?: Date | string
  updatedAt?: Date | string
}) {
  return {
    id: table.id,
    name: table.name,
    description: table.description ?? null,
    workspaceId: table.workspaceId,
    schema: table.schema,
    columnCount: table.schema.columns.length,
    createdAt: table.createdAt,
    updatedAt: table.updatedAt,
  }
}

function projectRow(row: Pick<TableRow, 'id' | 'data' | 'createdAt' | 'updatedAt'>) {
  return {
    id: row.id,
    data: row.data,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

/** Joins `error.cause` so Drizzle "Failed query" wrappers keep the Postgres reason. */
function describeCaughtError(error: unknown): string {
  const primary = toError(error)
  const parts = [primary.message]
  let cursor: unknown = primary.cause
  let depth = 0
  while (cursor && depth < 4) {
    parts.push(toError(cursor).message)
    cursor = toError(cursor).cause
    depth += 1
  }
  return parts.join(' ← ')
}

function messageForUserTableFailure(error: unknown): string {
  if (error instanceof TableLockedError) return error.message
  const fallback = 'user_table operation failed'
  const projected = messageForCopilotTableError(error, fallback)
  if (projected !== fallback) return projected
  return `${fallback}: ${describeCaughtError(error)}`
}

/**
 * Executes Local Arena Copilot `user_table` against table application use cases.
 */
export const executeLocalUserTable: ToolHandler = async (
  params,
  context
): Promise<ToolExecutionResult> => {
  const workspaceOrError = requireWorkspaceId(context)
  if (typeof workspaceOrError !== 'string') return workspaceOrError
  const workspaceId = workspaceOrError

  const operationRaw = params.operation
  if (typeof operationRaw !== 'string' || !operationRaw.trim()) {
    return fail('operation is required (e.g. create, get, get_schema, insert_row, query_rows)')
  }
  const operation = operationRaw.trim()
  if (!SUPPORTED_OPERATIONS.has(operation)) {
    return fail(
      `Unsupported user_table operation "${operation}". Supported: ${[...SUPPORTED_OPERATIONS].join(', ')}`
    )
  }

  const args = isRecordLike(params.args) ? params.args : params

  try {
    switch (operation) {
      case 'create': {
        const name = requireString(args.name, 'name')
        if (typeof name !== 'string') return name
        const schema = parseSchema(args.schema)
        if (!('columns' in schema)) return schema
        const description =
          typeof args.description === 'string' && args.description.trim()
            ? args.description.trim()
            : undefined
        const folderPath =
          typeof args.folderPath === 'string' && args.folderPath.trim()
            ? args.folderPath.trim()
            : undefined

        const { table, folderPath: resolvedFolderPath } = await executeCopilotTableUseCase(
          toTableContext(context),
          createTableUseCase,
          {
            workspaceId,
            name,
            description,
            schema,
            folderPath,
          }
        )

        logger.info('user_table create succeeded', {
          tableId: table.id,
          workspaceId,
          columnCount: table.schema.columns.length,
        })

        return ok(`Table "${table.name}" created successfully`, {
          table: { ...summarizeTable(table), folderPath: resolvedFolderPath },
          tableId: table.id,
          tableName: table.name,
        })
      }

      case 'list': {
        const { tables } = await executeCopilotTableUseCase(
          toTableContext(context),
          listTableDefinitionsUseCase,
          {
            workspaceId,
            scope: 'active',
          }
        )
        return ok(`Found ${tables.length} table(s)`, {
          tables: tables.map((table) => summarizeTable(table)),
          count: tables.length,
        })
      }

      case 'get':
      case 'get_schema': {
        const tableId = requireString(args.tableId ?? params.tableId, 'tableId')
        if (typeof tableId !== 'string') return tableId
        const { table, folderPath } = await executeCopilotTableUseCase(
          toTableContext(context),
          readTableUseCase,
          {
            tableId,
            workspaceId,
          },
          { tableId }
        )
        if (operation === 'get_schema') {
          return ok(`Retrieved schema for table "${table.name}"`, {
            tableId: table.id,
            tableName: table.name,
            schema: table.schema,
          })
        }
        return ok(`Retrieved table "${table.name}"`, {
          table: { ...summarizeTable(table), folderPath },
          tableId: table.id,
          tableName: table.name,
        })
      }

      case 'rename': {
        const tableId = requireString(args.tableId ?? params.tableId, 'tableId')
        if (typeof tableId !== 'string') return tableId
        const name = requireString(args.name, 'name')
        if (typeof name !== 'string') return name
        const result = await executeCopilotTableUseCase(
          toTableContext(context),
          updateTableUseCase,
          {
            tableId,
            workspaceId,
            name,
          },
          { tableId }
        )
        if (!result.table) {
          return fail('Rename did not return an updated table')
        }
        return ok(`Table renamed to "${result.table.name}"`, {
          table: summarizeTable(result.table),
          tableId: result.table.id,
          tableName: result.table.name,
          applied: result.applied,
        })
      }

      case 'add_column': {
        const tableId = requireString(args.tableId ?? params.tableId, 'tableId')
        if (typeof tableId !== 'string') return tableId
        const columnRaw = toRecord(args.column)
        const columnName = requireString(columnRaw.name, 'column.name')
        if (typeof columnName !== 'string') return columnName
        const columnType = parseColumnType(columnRaw.type)
        if (typeof columnType !== 'string') return columnType
        const { table } = await executeCopilotTableUseCase(
          toTableContext(context),
          addTableColumnUseCase,
          {
            tableId,
            workspaceId,
            column: {
              name: columnName,
              type: columnType,
              ...(typeof columnRaw.required === 'boolean' ? { required: columnRaw.required } : {}),
              ...(typeof columnRaw.unique === 'boolean' ? { unique: columnRaw.unique } : {}),
              ...(typeof columnRaw.multiple === 'boolean' ? { multiple: columnRaw.multiple } : {}),
            },
          },
          { tableId }
        )
        return ok(`Added column "${columnName}" to table "${table.name}"`, {
          table: summarizeTable(table),
          tableId: table.id,
          tableName: table.name,
        })
      }

      case 'insert_row': {
        const tableId = requireString(args.tableId ?? params.tableId, 'tableId')
        if (typeof tableId !== 'string') return tableId
        const data = parseRowData(args.data, 'data')
        if (!isRecordLike(data)) return data
        const result = await executeCopilotTableUseCase(
          toTableContext(context),
          createTableRows,
          {
            tableId,
            assertedWorkspaceId: workspaceId,
            kind: 'single',
            data,
            strictWrite: false,
            dataKeying: 'names',
          },
          { tableId }
        )
        if (result.kind !== 'single') {
          return fail('Unexpected batch result from insert_row')
        }
        return ok('Row inserted', {
          tableId: result.table.id,
          tableName: result.table.name,
          row: projectRow(result.row),
        })
      }

      case 'batch_insert_rows': {
        const tableId = requireString(args.tableId ?? params.tableId, 'tableId')
        if (typeof tableId !== 'string') return tableId
        const rowsRaw = toArray(args.rows)
        if (rowsRaw.length === 0) {
          return fail('rows must be a non-empty array of objects')
        }
        const rows: RowData[] = []
        for (const [index, entry] of rowsRaw.entries()) {
          const parsed = parseRowData(entry, `rows[${index}]`)
          if (!isRecordLike(parsed)) return parsed
          rows.push(parsed)
        }
        const result = await executeCopilotTableUseCase(
          toTableContext(context),
          createTableRows,
          {
            tableId,
            assertedWorkspaceId: workspaceId,
            kind: 'batch',
            rows,
            strictWrite: false,
            dataKeying: 'names',
          },
          { tableId }
        )
        if (result.kind !== 'batch') {
          return fail('Unexpected single-row result from batch_insert_rows')
        }
        return ok(`Inserted ${result.rows.length} row(s)`, {
          tableId: result.table.id,
          tableName: result.table.name,
          rows: result.rows.map(projectRow),
          count: result.rows.length,
        })
      }

      case 'get_row': {
        const tableId = requireString(args.tableId ?? params.tableId, 'tableId')
        if (typeof tableId !== 'string') return tableId
        const rowId = requireString(args.rowId, 'rowId')
        if (typeof rowId !== 'string') return rowId
        const result = await executeCopilotTableUseCase(
          toTableContext(context),
          readTableRow,
          {
            tableId,
            assertedWorkspaceId: workspaceId,
            rowId,
          },
          { tableId }
        )
        return ok('Retrieved row', {
          tableId: result.table.id,
          tableName: result.table.name,
          row: projectRow(result.row),
        })
      }

      case 'query_rows': {
        const tableId = requireString(args.tableId ?? params.tableId, 'tableId')
        if (typeof tableId !== 'string') return tableId
        const limit =
          typeof args.limit === 'number' && Number.isFinite(args.limit)
            ? Math.max(1, Math.floor(args.limit))
            : 50
        const cursor =
          typeof args.cursor === 'string' && args.cursor.trim() ? args.cursor : undefined
        const result = await executeCopilotTableUseCase(
          toTableContext(context),
          queryTableRows,
          {
            tableId,
            assertedWorkspaceId: workspaceId,
            limit,
            cursor,
            includeTotal: true,
            legacyKeying: 'names',
          },
          { tableId }
        )
        return ok(`Found ${result.rows.length} row(s)`, {
          tableId: result.table.id,
          tableName: result.table.name,
          rows: result.rows.map(projectRow),
          rowCount: result.rowCount,
          totalCount: result.totalCount,
          limit: result.limit,
          nextCursor: result.nextCursor,
        })
      }

      case 'update_row': {
        const tableId = requireString(args.tableId ?? params.tableId, 'tableId')
        if (typeof tableId !== 'string') return tableId
        const rowId = requireString(args.rowId, 'rowId')
        if (typeof rowId !== 'string') return rowId
        const data = parseRowData(args.data, 'data')
        if (!isRecordLike(data)) return data
        const result = await executeCopilotTableUseCase(
          toTableContext(context),
          updateTableRow,
          {
            tableId,
            assertedWorkspaceId: workspaceId,
            rowId,
            data,
            strictWrite: false,
            dataKeying: 'names',
          },
          { tableId }
        )
        return ok('Row updated', {
          tableId: result.table.id,
          tableName: result.table.name,
          row: projectRow(result.row),
          changed: result.changed,
        })
      }

      case 'delete_row': {
        const tableId = requireString(args.tableId ?? params.tableId, 'tableId')
        if (typeof tableId !== 'string') return tableId
        const rowId = requireString(args.rowId, 'rowId')
        if (typeof rowId !== 'string') return rowId
        const result = await executeCopilotTableUseCase(
          toTableContext(context),
          deleteTableRow,
          {
            tableId,
            assertedWorkspaceId: workspaceId,
            rowId,
          },
          { tableId }
        )
        return ok('Row deleted', {
          tableId: result.table.id,
          tableName: result.table.name,
          rowId,
        })
      }

      default:
        return fail(`Unsupported user_table operation "${operation}"`)
    }
  } catch (error) {
    const cause = describeCaughtError(error)
    const message = messageForUserTableFailure(error)
    logger.warn('user_table failed', {
      operation,
      workspaceId,
      error: message,
      cause,
      stack: toError(error).stack,
    })
    return fail(message)
  }
}
