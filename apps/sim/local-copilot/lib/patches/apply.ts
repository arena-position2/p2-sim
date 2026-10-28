import { db } from '@sim/db'
import { localCopilotPatches } from '@sim/db/schema'
import { createLogger } from '@sim/logger'
import type { WorkflowState } from '@sim/workflow-types/workflow'
import { eq } from 'drizzle-orm'
import type { WorkflowPersistGovernance } from '@/lib/workflows/persistence/block-access-guard'
import { saveWorkflowToNormalizedTables } from '@/lib/workflows/persistence/utils'
import { validateWorkflowPatch } from '@/local-copilot/lib/patches/validate'
import type { WorkflowPatch } from '@/local-copilot/lib/types'
import { assertExpectedRevision } from '@/local-copilot/lib/writes/revision'
import { loadWorkflowRevision } from '@/local-copilot/lib/writes/workflow-access'

const logger = createLogger('LocalCopilotPatchApply')

export interface ApplyPatchParams {
  patchId: string
  userId: string
  workflowId: string
  currentState: WorkflowState
  /** Authenticated workspace — used for tenancy + optional CAS. */
  workspaceId?: string
  /** Optional CAS token from workflow.updatedAt. */
  expectedRevision?: string
}

export interface ApplyPatchResult {
  success: boolean
  state?: WorkflowState
  errors?: string[]
  revision?: string
}

export async function applyWorkflowPatch(params: ApplyPatchParams): Promise<ApplyPatchResult> {
  const { patchId, userId, workflowId, currentState, workspaceId, expectedRevision } = params

  const [patchRow] = await db
    .select()
    .from(localCopilotPatches)
    .where(eq(localCopilotPatches.id, patchId))
    .limit(1)

  if (!patchRow) {
    return { success: false, errors: ['Patch not found'] }
  }
  if (patchRow.userId !== userId) {
    return { success: false, errors: ['Unauthorized'] }
  }
  if (patchRow.workflowId !== workflowId) {
    return { success: false, errors: ['Patch workflow mismatch'] }
  }
  if (patchRow.status !== 'pending') {
    return { success: false, errors: [`Patch is ${patchRow.status}`] }
  }

  let currentRevision: string | undefined
  if (workspaceId) {
    const loaded = await loadWorkflowRevision(workflowId, workspaceId)
    if (!loaded) {
      return { success: false, errors: ['Workflow not found in this workspace'] }
    }
    currentRevision = loaded.revision
    const revisionCheck = assertExpectedRevision({
      expectedRevision,
      currentRevision,
      requireExpected: Boolean(expectedRevision),
    })
    if (!revisionCheck.ok) {
      return { success: false, errors: [revisionCheck.error] }
    }
  }

  const patch = patchRow.patch as WorkflowPatch
  const validation = validateWorkflowPatch(patch, currentState)
  if (!validation.valid) {
    return { success: false, errors: validation.errors }
  }

  const nextState = applyPatchOperations(currentState, patch)
  const governance: WorkflowPersistGovernance = {
    workspaceId: workspaceId ?? null,
    subjectUserId: userId,
  }
  await saveWorkflowToNormalizedTables(workflowId, nextState, governance)

  await db
    .update(localCopilotPatches)
    .set({ status: 'applied', resolvedAt: new Date() })
    .where(eq(localCopilotPatches.id, patchId))

  logger.info('Applied Arena Copilot patch', { patchId, workflowId, userId })

  let revision = currentRevision
  if (workspaceId) {
    const loaded = await loadWorkflowRevision(workflowId, workspaceId)
    if (loaded) revision = loaded.revision
  }

  return {
    success: true,
    state: nextState,
    ...(revision ? { revision } : {}),
  }
}

export async function rejectWorkflowPatch(patchId: string, userId: string): Promise<boolean> {
  const [patchRow] = await db
    .select({
      id: localCopilotPatches.id,
      userId: localCopilotPatches.userId,
      status: localCopilotPatches.status,
    })
    .from(localCopilotPatches)
    .where(eq(localCopilotPatches.id, patchId))
    .limit(1)

  if (!patchRow || patchRow.userId !== userId || patchRow.status !== 'pending') {
    return false
  }

  await db
    .update(localCopilotPatches)
    .set({ status: 'rejected', resolvedAt: new Date() })
    .where(eq(localCopilotPatches.id, patchId))

  return true
}

function applyPatchOperations(state: WorkflowState, patch: WorkflowPatch): WorkflowState {
  const next = structuredClone(state)

  for (const change of patch.changes) {
    switch (change.operation) {
      case 'add_block': {
        next.blocks[change.block.id] = change.block
        break
      }
      case 'update_block': {
        const existing = next.blocks[change.blockId]
        if (existing) {
          next.blocks[change.blockId] = { ...existing, ...change.updates }
        }
        break
      }
      case 'remove_block': {
        delete next.blocks[change.blockId]
        next.edges = next.edges.filter(
          (e) => e.source !== change.blockId && e.target !== change.blockId
        )
        break
      }
      case 'add_edge':
        next.edges.push(change.edge)
        break
      case 'remove_edge':
        next.edges = next.edges.filter((e) => e.id !== change.edgeId)
        break
      case 'add_variable': {
        if (!next.variables) next.variables = {}
        next.variables[change.variable.id] = change.variable
        break
      }
      case 'update_variable': {
        const existing = next.variables?.[change.variableId]
        if (existing && next.variables) {
          next.variables[change.variableId] = { ...existing, ...change.updates }
        }
        break
      }
      case 'remove_variable':
        if (next.variables) delete next.variables[change.variableId]
        break
    }
  }

  return next
}
