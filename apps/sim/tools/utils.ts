import { createLogger } from '@sim/logger'
import { getErrorMessage } from '@sim/utils/errors'
import { stripVersionSuffix } from '@sim/utils/string'
import { parse as parseCsv } from 'csv-parse/sync'
import { getMaxExecutionTimeout } from '@/lib/core/execution-limits'
import {
  normalizeRecord,
  normalizeStringRecord,
  normalizeWorkflowVariables,
} from '@/lib/core/utils/records'
import type { EnvironmentVariable } from '@/lib/environment/api'
import { getQueryClient } from '@/app/_shell/providers/get-query-client'
import type { CustomToolDefinition } from '@/hooks/queries/custom-tools'
import { environmentKeys } from '@/hooks/queries/environment'
import { tools } from '@/tools/registry'
import type { ExecutableToolConfig, InternalToolConfig, ToolConfig } from '@/tools/types'

const logger = createLogger('ToolUtils')

/**
 * Strips version suffix (_v2, _v3, etc.) from a tool ID or name.
 * Re-exported from the canonical `@sim/utils/string` helper so existing
 * `@/tools/utils` consumers keep working unchanged.
 * @example stripVersionSuffix('notion_search_v2') => 'notion_search'
 * @example stripVersionSuffix('github_create_pr_v3') => 'github_create_pr'
 */
export { stripVersionSuffix } from '@sim/utils/string'

/** Materialized HTTP request accepted by the legacy executeRequest helper. */
export interface RequestParams {
  url: string
  method: string
  headers: Record<string, string>
  body?: string
  timeout?: number
  proxyUrl?: string
  stripAuthOnRedirect?: boolean
}

/**
 * Filters a tools map to return only the latest version of each tool.
 * If both `notion_search` and `notion_search_v2` exist, only `notion_search_v2` is returned.
 * @param toolsMap Record of tool ID to ToolConfig
 * @returns Filtered record containing only the latest version of each tool
 */
export function getLatestVersionTools(
  toolsMap: Record<string, ExecutableToolConfig>
): Record<string, ExecutableToolConfig> {
  const latestTools: Record<string, ExecutableToolConfig> = {}
  const baseNameToVersions: Record<string, { toolId: string; version: number }[]> = {}

  for (const toolId of Object.keys(toolsMap)) {
    const baseName = stripVersionSuffix(toolId)
    const versionMatch = toolId.match(/_v(\d+)$/)
    const version = versionMatch ? Number.parseInt(versionMatch[1], 10) : 1

    if (!baseNameToVersions[baseName]) {
      baseNameToVersions[baseName] = []
    }
    baseNameToVersions[baseName].push({ toolId, version })
  }

  for (const versions of Object.values(baseNameToVersions)) {
    const latest = versions.reduce((prev, curr) => (curr.version > prev.version ? curr : prev))
    latestTools[latest.toolId] = toolsMap[latest.toolId]
  }

  return latestTools
}

/**
 * Resolves a tool name to its actual tool ID in the registry.
 * Handles both stripped names (e.g., 'notion_search') and versioned names (e.g., 'notion_search_v2').
 *
 * Workflow block execution must not call this — serialized block tool ids are already exact keys.
 *
 * Server-side counterpart to `resolveToolId` in `@/tools/tool-ids`. Both exist
 * deliberately: this one reads the live registry, so a tool added but not yet
 * regenerated stays resolvable; that one resolves against the generated id list
 * without pulling 4,300 tools into a client graph. Client code wants that one.
 * `check:tool-metadata` asserts the two never diverge.
 *
 * @param toolName The tool name to resolve (may or may not have version suffix)
 * @returns The actual tool ID in the registry, or the original name if not found
 */
export function resolveToolId(toolName: string): string {
  if (tools[toolName]) {
    return toolName
  }

  const latestTools = getLatestVersionTools(tools)
  for (const toolId of Object.keys(latestTools)) {
    if (stripVersionSuffix(toolId) === toolName) {
      return toolId
    }
  }

  return toolName
}

/**
 * Values that are guaranteed to be JSON.stringify-compatible
 */
export type JSONSafePrimitive = string | number | boolean | null

export type JSONSafeValue = JSONSafePrimitive | JSONSafeValue[] | { [key: string]: JSONSafeValue }

/**
 * Internal helper that:
 * - Removes real circular references
 * - Preserves shared references
 * - Converts `undefined → null` ONLY inside arrays
 * - Drops `undefined` inside objects
 */
function decycle(
  value: unknown,
  stack: WeakSet<object>,
  inArray: boolean
): JSONSafeValue | undefined {
  // Preserve top-level undefined (caller decides)
  if (value === undefined) {
    return inArray ? null : undefined
  }

  // JSON primitives
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return value
  }

  // Unsupported JSON values
  if (typeof value === 'function') {
    return '[Function]'
  }

  if (typeof value === 'symbol') {
    return '[Symbol]'
  }

  // Non-object, non-JSON values
  if (typeof value !== 'object') {
    return inArray ? null : undefined
  }

  // Circular reference detection (path-based)
  if (stack.has(value)) {
    return '[Circular Reference]'
  }

  stack.add(value)

  let result: JSONSafeValue

  if (Array.isArray(value)) {
    const arr = value as unknown[]
    result = arr.map((item) => {
      const processed = decycle(item, stack, true)
      return processed === undefined ? null : processed
    })
  } else {
    const obj = value as Record<string, unknown>
    const cloned: Record<string, JSONSafeValue> = {}

    for (const key of Object.keys(obj)) {
      const processed = decycle(obj[key], stack, false)
      if (processed !== undefined) {
        cloned[key] = processed
      }
    }

    result = cloned
  }

  stack.delete(value)
  return result
}

/**
 * Safely stringifies data for:
 * - Logging
 * - APIs
 * - Google Sheets (2D arrays)
 *
 * Guarantees:
 * - Top-level `undefined` → returns undefined
 * - Arrays never contain `undefined`
 * - Objects never contain `undefined` keys
 * - Circular references are replaced
 */
export function safeStringify(value: unknown, context = 'unknown'): string | undefined {
  if (value === undefined) {
    return undefined
  }

  if (typeof value === 'string') {
    return value
  }

  try {
    const safeValue: JSONSafeValue | undefined = decycle(value, new WeakSet<object>(), false)

    if (safeValue === undefined) {
      return undefined
    }

    return JSON.stringify(safeValue)
  } catch (error: unknown) {
    const errorMessage: string = error instanceof Error ? error.message : String(error)

    if (
      errorMessage.includes('circular') ||
      errorMessage.includes('Converting circular structure')
    ) {
      logger.error(`Circular reference detected during JSON stringify in ${context}`, {
        error: errorMessage,
      })
      throw new Error('Cannot stringify data: circular reference detected.')
    }

    if (errorMessage.includes('Invalid string length') || errorMessage.includes('too large')) {
      logger.error(`Data too large to stringify in ${context}`, {
        error: errorMessage,
      })
      throw new Error('Cannot stringify data: data is too large.')
    }

    logger.error(`Failed to stringify JSON in ${context}`, {
      error: errorMessage,
    })

    throw new Error(`Failed to convert data to JSON: ${errorMessage}`)
  }
}

/**
 * Format request parameters based on tool configuration and provided params
 */
export async function formatRequestParams(
  tool: ToolConfig,
  params: Record<string, any>
): Promise<RequestParams> {
  // Process URL
  const resolvedUrl: unknown =
    typeof tool.request.url === 'function' ? tool.request.url(params) : tool.request.url

  // Check if the URL function returned an error response
  // This should be handled upstream, but we check here to prevent crashes
  if (resolvedUrl && typeof resolvedUrl === 'object' && '_errorResponse' in resolvedUrl) {
    const errorResponse = (
      resolvedUrl as {
        _errorResponse?: {
          data?: {
            error?: { message?: string }
            message?: string
          }
        }
      }
    )._errorResponse
    throw new Error(
      errorResponse?.data?.error?.message ||
        errorResponse?.data?.message ||
        'Tool request validation failed'
    )
  }
  const url = String(resolvedUrl)

  // Process method
  const method =
    typeof tool.request.method === 'function'
      ? tool.request.method(params)
      : params.method || tool.request.method || 'GET'

  // Process headers
  const headers = tool.request.headers ? tool.request.headers(params) : {}

  // Process body
  const hasBody = method !== 'GET' && method !== 'HEAD' && !!tool.request.body
  const bodyResult = tool.request.body ? await tool.request.body(params) : undefined

  // Special handling for content types whose body is not JSON (pre-formatted strings)
  const contentType = headers['Content-Type'] ?? ''
  const isPreformattedContent =
    contentType === 'application/x-ndjson' ||
    contentType === 'application/x-www-form-urlencoded' ||
    contentType.startsWith('multipart/')

  let body: string | undefined
  if (hasBody) {
    if (isPreformattedContent) {
      // Check if bodyResult is a string
      if (typeof bodyResult === 'string') {
        body = bodyResult
      }
      // Check if bodyResult is an object with a 'body' property (Twilio pattern)
      else if (bodyResult && typeof bodyResult === 'object' && 'body' in bodyResult) {
        body = bodyResult.body
      }
      // Otherwise JSON stringify it
      else {
        body = safeStringify(bodyResult, tool.id || 'unknown')
      }
    } else {
      body =
        typeof bodyResult === 'string'
          ? bodyResult
          : safeStringify(bodyResult, tool.id || 'unknown')
    }

    // Validate the JSON is parseable before returning
    if (body && !isPreformattedContent) {
      try {
        JSON.parse(body)
      } catch (parseError) {
        logger.error(`Generated invalid JSON in formatRequestParams for ${tool.id || 'unknown'}`, {
          error: parseError instanceof Error ? parseError.message : String(parseError),
          bodyLength: body.length,
          bodyPreview: body.substring(0, 200),
        })
        throw new Error(
          `Failed to generate valid JSON for request body. This may be due to circular references or invalid data structures.`
        )
      }
    }
  }

  const MAX_TIMEOUT_MS = getMaxExecutionTimeout()
  const rawTimeout = params.timeout ?? tool.request.timeout
  const timeout = rawTimeout != null ? Number(rawTimeout) : undefined
  const validTimeout =
    timeout != null && Number.isFinite(timeout) && timeout > 0
      ? Math.min(timeout, MAX_TIMEOUT_MS)
      : undefined

  const proxyUrl =
    typeof params.proxyUrl === 'string' && params.proxyUrl.trim()
      ? params.proxyUrl.trim()
      : undefined

  return {
    url,
    method,
    headers,
    body,
    timeout: validTimeout,
    proxyUrl,
    stripAuthOnRedirect: tool.request.stripAuthOnRedirect,
  }
}

/**
 * Formats a parameter name for user-friendly error messages
 * Converts parameter names and descriptions to more readable format
 */

/**
 * Formats a parameter name for user-friendly error messages
 * Converts parameter names and descriptions to more readable format
 */
function formatParameterNameForError(paramName: string): string {
  // Split camelCase and snake_case/kebab-case into words, then capitalize first letter of each word
  return paramName
    .split(/(?=[A-Z])|[_-]/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ')
}

/**
 * Validates required parameters after LLM and user params have been merged
 * This is the final validation before tool execution - ensures all required
 * user-or-llm parameters are present after the merge process
 */
export function validateRequiredParametersAfterMerge(
  toolId: string,
  tool: ExecutableToolConfig | undefined,
  params: Record<string, any>,
  parameterNameMap?: Record<string, string>
): void {
  if (!tool) {
    throw new Error(`Tool not found: ${toolId}`)
  }

  // Validate all required user-or-llm parameters after merge
  // user-only parameters should have been validated earlier during serialization
  for (const [paramName, paramConfig] of Object.entries(tool.params)) {
    if (
      (paramConfig as any).visibility === 'user-or-llm' &&
      paramConfig.required &&
      (!(paramName in params) ||
        params[paramName] === null ||
        params[paramName] === undefined ||
        params[paramName] === '')
    ) {
      // Create a more user-friendly error message
      const toolName = tool.name || toolId
      const friendlyParamName =
        parameterNameMap?.[paramName] || formatParameterNameForError(paramName)
      throw new Error(`${friendlyParamName} is required for ${toolName}`)
    }
  }
}

/**
 * Creates parameter schema from custom tool schema
 */
export function createParamSchema(customTool: any): Record<string, any> {
  const params: Record<string, any> = {}

  if (customTool.schema.function?.parameters?.properties) {
    const properties = customTool.schema.function.parameters.properties
    const required = customTool.schema.function.parameters.required || []

    Object.entries(properties).forEach(([key, config]: [string, any]) => {
      const isRequired = required.includes(key)

      // Create the base parameter configuration
      const paramConfig: Record<string, any> = {
        type: config.type || 'string',
        required: isRequired,
        description: config.description || '',
      }

      // Set visibility based on whether it's required
      if (isRequired) {
        paramConfig.visibility = 'user-or-llm'
      } else {
        paramConfig.visibility = 'user-only'
      }

      params[key] = paramConfig
    })
  }

  return params
}

/**
 * Get environment variables from React Query cache (client-side only)
 */
export function getClientEnvVars(): Record<string, string> {
  if (typeof window === 'undefined') return {}

  try {
    const allEnvVars =
      getQueryClient().getQueryData<Record<string, EnvironmentVariable>>(
        environmentKeys.personal()
      ) ?? {}

    // Convert environment variables to a simple key-value object
    return Object.entries(allEnvVars).reduce(
      (acc, [key, variable]) => {
        acc[key] = variable.value
        return acc
      },
      {} as Record<string, string>
    )
  } catch (_error) {
    // In case of any errors (like in testing), return empty object
    return {}
  }
}

/**
 * Creates the request body configuration for custom tools
 * @param customTool The custom tool configuration
 * @param isClient Whether running on client side
 * @param workflowId Optional workflow ID for server-side
 */
export function createCustomToolRequestBody(customTool: any, isClient = true, workflowId?: string) {
  return (params: Record<string, any>) => {
    // Get environment variables - try multiple sources in order of preference:
    // 1. envVars parameter (passed from provider/agent context)
    // 2. Client-side store (if running in browser)
    // 3. Empty object (fallback)
    const envVars = normalizeStringRecord(params.envVars || (isClient ? getClientEnvVars() : {}))

    const workflowVariables = normalizeWorkflowVariables(params.workflowVariables)

    const blockData = normalizeRecord(params.blockData)
    const blockNameMapping = normalizeStringRecord(params.blockNameMapping)

    // Include everything needed for execution
    return {
      code: customTool.code,
      params: params, // These will be available in the VM context
      schema: customTool.schema.function.parameters, // For validation
      envVars: envVars, // Environment variables
      workflowVariables: workflowVariables, // Workflow variables for <variable.name> resolution
      blockData: blockData, // Runtime block outputs for <block.field> resolution
      blockNameMapping: blockNameMapping, // Block name to ID mapping
      workflowId: params._context?.workflowId || workflowId, // Pass workflowId for server-side context
      userId: params._context?.userId, // Pass userId for auth context
      isCustomTool: true, // Flag to indicate this is a custom tool execution
    }
  }
}

// Get a tool by its ID
export function getTool(toolId: string, _workspaceId?: string): ExecutableToolConfig | undefined {
  // Check for built-in tools
  const builtInTool = tools[resolveToolId(toolId)]
  if (builtInTool) return builtInTool

  // If not found or running on the server, return undefined
  return undefined
}

export function createToolConfig(
  customTool: CustomToolDefinition,
  customToolId: string
): InternalToolConfig {
  // Create a parameter schema from the custom tool schema
  const params = createParamSchema(customTool)

  // Create a tool config for the custom tool
  return {
    id: customToolId,
    name: customTool.title,
    description: customTool.schema.function?.description || '',
    version: '1.0.0',
    params,

    operation: {
      input: createCustomToolRequestBody(customTool, true),
    },

    // Standard response handling for custom tools
    transformResponse: async (response: Response) => {
      const data = await response.json()

      if (!data.success) {
        throw new Error(data.error || 'Custom tool execution failed')
      }

      return {
        success: true,
        output: data.output.result || data.output,
        error: undefined,
      }
    },
  }
}

export interface CsvParseOptions {
  /**
   * CSV delimiter. Defaults to ',' (comma).
   * Common delimiters: ',' (comma), ';' (semicolon), '\t' (tab)
   */
  delimiter?: string
  /**
   * Whether the first row contains headers. Defaults to true.
   */
  header?: boolean
  /**
   * Whether to skip empty lines. Defaults to true.
   */
  skipEmptyLines?: boolean
  /**
   * Whether to trim whitespace from values. Defaults to true.
   */
  trimHeaders?: boolean
  /**
   * Whether to trim whitespace from values. Defaults to true.
   */
  trimValues?: boolean
}

export interface CsvParseResult {
  /**
   * Parsed data as an array of objects (if header: true) or arrays (if header: false)
   */
  data: Array<Record<string, string>> | string[][]
  /**
   * Column headers (if header: true)
   */
  headers: string[]
  /**
   * Total number of data rows (excluding header)
   */
  totalRows: number
  /**
   * Raw CSV text that was parsed
   */
  rawCsv: string
  /**
   * Any parsing errors encountered
   */
  errors: Array<{ message: string }>
}

/**
 * Generic CSV parser for API responses using `csv-parse`.
 * Supports different delimiters (comma, semicolon, tab) and can be used by any tool
 * that receives CSV responses from external APIs.
 *
 * @param csvText - Raw CSV text from API response
 * @param options - Parsing options
 * @returns Parsed CSV data with headers and rows
 *
 * @example
 * ```typescript
 * // Parse semicolon-delimited CSV (e.g., Semrush)
 * const result = parseCsvResponse(csvText, { delimiter: ';' })
 *
 * // Parse comma-delimited CSV (default)
 * const result = parseCsvResponse(csvText)
 *
 * // Parse CSV without headers
 * const result = parseCsvResponse(csvText, { header: false })
 * ```
 */
export function parseCsvResponse(csvText: string, options: CsvParseOptions = {}): CsvParseResult {
  const {
    delimiter = ',',
    header = true,
    skipEmptyLines = true,
    trimHeaders = true,
    trimValues = true,
  } = options

  if (!csvText || csvText.trim().length === 0) {
    logger.warn('Empty CSV text provided')
    return {
      data: header ? [] : [],
      headers: [],
      totalRows: 0,
      rawCsv: csvText,
      errors: [],
    }
  }

  try {
    const allRows = parseCsv(csvText, {
      delimiter,
      columns: false,
      skip_empty_lines: skipEmptyLines,
      trim: trimValues,
      relax_column_count: true,
      bom: true,
    }) as string[][]

    let headers: string[] = []
    let data: Array<Record<string, string>> | string[][]
    let totalRows: number

    if (header) {
      headers = (allRows[0] ?? []).map((column) =>
        trimHeaders ? String(column).trim() : String(column)
      )
      data = allRows.slice(1).map((row) => {
        const record: Record<string, string> = {}
        for (let i = 0; i < headers.length; i++) {
          record[headers[i]] = String(row[i] ?? '')
        }
        return record
      })
      totalRows = data.length
    } else if (allRows.length > 0) {
      headers = allRows[0] || []
      data = allRows.slice(1)
      totalRows = data.length
    } else {
      headers = []
      data = []
      totalRows = 0
    }

    logger.info('CSV parsed successfully', {
      delimiter,
      header,
      totalRows,
      columnCount: headers.length,
    })

    return {
      data,
      headers,
      totalRows,
      rawCsv: csvText,
      errors: [],
    }
  } catch (error) {
    const message = getErrorMessage(error, 'Unknown CSV parse error')
    logger.error('CSV parsing failed', {
      error: message,
      delimiter,
      preview: csvText.substring(0, 200),
    })
    throw new Error(`Failed to parse CSV response: ${message}`)
  }
}
