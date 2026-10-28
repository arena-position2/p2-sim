/**
 * Coerces common model aliases into the canonical edit_workflow `operations` field
 * before AJV / local validation.
 */
export function normalizeEditWorkflowArgs(args: Record<string, unknown>): Record<string, unknown> {
  const operations = resolveEditWorkflowOperations(args)
  if (!operations) return { ...args }
  return { ...args, operations }
}

/**
 * Accepts common model aliases (`ops`, nested `args.operations`) for edit_workflow.
 * Also accepts a bare operations array under `params`, JSON-encoded arrays, and a
 * singular `operation` object.
 */
export function resolveEditWorkflowOperations(args: Record<string, unknown>): unknown[] | null {
  const candidates = [args.operations, args.ops, args.edits, args.params, args.operation]
  const nested =
    args.args && typeof args.args === 'object' && !Array.isArray(args.args)
      ? (args.args as Record<string, unknown>)
      : null
  if (nested) {
    candidates.push(nested.operations, nested.ops, nested.edits, nested.params, nested.operation)
  }

  for (const candidate of candidates) {
    const operations = coerceOperationsList(candidate)
    if (operations) return operations
  }
  return null
}

function coerceOperationsList(value: unknown): unknown[] | null {
  if (Array.isArray(value) && value.length > 0) return value
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const record = value as Record<string, unknown>
    if (
      typeof record.operation_type === 'string' ||
      typeof record.operationType === 'string' ||
      typeof record.block_id === 'string' ||
      typeof record.blockId === 'string'
    ) {
      return [value]
    }
  }
  if (typeof value === 'string' && value.trim().startsWith('[')) {
    try {
      const parsed = JSON.parse(value.trim()) as unknown
      if (Array.isArray(parsed) && parsed.length > 0) return parsed
    } catch {
      return null
    }
  }
  return null
}
