/**
 * Rewrites Agent `inputs.tools` on Local Copilot `edit_workflow` ops so they
 * pass upstream tool-binding authoring (no title/toolId on new attachments)
 * and map common KB aliases onto the catalog block id `knowledge`.
 *
 * Arena-only seam — keeps Sim merge surface thin.
 */

const AGENT_TOOL_IDENTITY_FIELDS = ['title', 'name', 'toolId', 'functionName'] as const

const KNOWLEDGE_TOOL_TYPE_ALIASES = new Set([
  'knowledge_base',
  'knowledgebase',
  'manage_knowledge_base',
  'kb',
])

const KNOWLEDGE_ID_KEYS = [
  'knowledgeBaseId',
  'knowledge_base_id',
  'knowledgeBaseSelector',
  'manualKnowledgeBaseId',
  'kbId',
  'kb_id',
] as const

/**
 * Coerces Agent tool arrays on add/edit operations.
 */
export function coerceLocalEditAgentTools(operations: unknown[]): unknown[] {
  if (!Array.isArray(operations) || operations.length === 0) return operations

  let changed = false
  const next = operations.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return item
    const op = item as Record<string, unknown>
    const opType = operationType(op)
    if (opType !== 'add' && opType !== 'edit') return item

    const params = asRecord(op.params)
    if (!params) return item
    const inputs = asRecord(params.inputs)
    if (!inputs || !Array.isArray(inputs.tools)) return item

    const coercedTools = inputs.tools.map((tool) => coerceAgentToolEntry(tool))
    const toolsChanged = coercedTools.some((tool, index) => tool !== inputs.tools[index])
    if (!toolsChanged) return item

    changed = true
    return {
      ...op,
      params: {
        ...params,
        inputs: {
          ...inputs,
          tools: coercedTools,
        },
      },
    }
  })

  return changed ? next : operations
}

/**
 * Normalizes one Agent tool attachment for authoring + KB aliases.
 */
export function coerceAgentToolEntry(tool: unknown): unknown {
  if (!tool || typeof tool !== 'object' || Array.isArray(tool)) return tool
  const record = { ...(tool as Record<string, unknown>) }
  let changed = false

  for (const key of AGENT_TOOL_IDENTITY_FIELDS) {
    if (key in record) {
      delete record[key]
      changed = true
    }
  }

  const rawType = typeof record.type === 'string' ? record.type.trim() : ''
  const lowerType = rawType.toLowerCase()
  if (KNOWLEDGE_TOOL_TYPE_ALIASES.has(lowerType)) {
    record.type = 'knowledge'
    changed = true
  }

  const isKnowledge =
    (typeof record.type === 'string' && record.type.trim().toLowerCase() === 'knowledge') ||
    KNOWLEDGE_TOOL_TYPE_ALIASES.has(lowerType)

  if (isKnowledge) {
    if (typeof record.operation !== 'string' || !record.operation.trim()) {
      record.operation = 'search'
      changed = true
    }

    const params = asRecord(record.params) ?? {}
    const nextParams: Record<string, unknown> = { ...params }
    let paramsChanged = !asRecord(record.params)

    for (const key of KNOWLEDGE_ID_KEYS) {
      const topLevel = record[key]
      if (typeof topLevel === 'string' && topLevel.trim()) {
        if (!hasKnowledgeBaseId(nextParams.knowledgeBaseId)) {
          nextParams.knowledgeBaseId = topLevel.trim()
          paramsChanged = true
        }
        delete record[key]
        changed = true
      }
    }

    for (const key of KNOWLEDGE_ID_KEYS) {
      if (key === 'knowledgeBaseId') continue
      const nested = nextParams[key]
      if (typeof nested === 'string' && nested.trim()) {
        if (!hasKnowledgeBaseId(nextParams.knowledgeBaseId)) {
          nextParams.knowledgeBaseId = nested.trim()
        }
        delete nextParams[key]
        paramsChanged = true
      }
    }

    if (paramsChanged) {
      record.params = nextParams
      changed = true
    }
  }

  return changed ? record : tool
}

function operationType(op: Record<string, unknown>): string {
  const raw = op.operation_type ?? op.operationType ?? op.type
  return typeof raw === 'string' ? raw.trim().toLowerCase() : ''
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

function hasKnowledgeBaseId(value: unknown): boolean {
  return typeof value === 'string' && value.trim().length > 0
}
