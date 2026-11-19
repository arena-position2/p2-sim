import { v2ExportWorkflowContract } from '@/lib/api/contracts/v2/workflows'
import { defineV2JsonRoute, v2ApiKeyAuth, v2RateLimits } from '@/lib/api/server/routes'
import { v2WorkflowErrorPolicies } from '@/lib/workflows/api'
import { exportWorkflow } from '@/lib/workflows/application/import-export'
import { workflowOperations } from '@/lib/workflows/application/operations'
import type { BlockState } from '@/stores/workflows/workflow/types'

/**
 * The export contract requires layout flags to be present (possibly undefined).
 * Stored blocks omit them until a user toggles the control.
 */
function presentExportBlocks(blocks: Record<string, BlockState>) {
  return Object.fromEntries(
    Object.entries(blocks).map(([id, block]) => {
      const data = block.data
      return [
        id,
        {
          ...block,
          horizontalHandles: block.horizontalHandles,
          height: block.height,
          advancedMode: block.advancedMode,
          errorEnabled: block.errorEnabled,
          retry: block.retry,
          triggerMode: block.triggerMode,
          locked: block.locked,
          data: data
            ? {
                ...data,
                parentId: data.parentId,
                extent: data.extent,
                width: data.width,
                height: data.height,
                collection: data.collection,
                count: data.count,
                loopType: data.loopType,
                whileCondition: data.whileCondition,
                doWhileCondition: data.doWhileCondition,
                parallelType: data.parallelType,
                batchSize: data.batchSize,
                type: data.type,
                canonicalModes: data.canonicalModes,
              }
            : undefined,
        },
      ]
    })
  )
}

export const dynamic = 'force-dynamic'
export const revalidate = 0

/**
 * `headSafe: false` because the use case projects a `WORKFLOW_EXPORTED` audit
 * event. Letting Next alias `HEAD` onto this `GET` would record an export that
 * handed the caller no bytes.
 */
export const GET = defineV2JsonRoute({
  contract: v2ExportWorkflowContract,
  auth: v2ApiKeyAuth,
  operation: workflowOperations.export,
  rateLimit: v2RateLimits.publicApi,
  headSafe: false,
  errorPolicy: v2WorkflowErrorPolicies.concealWorkflowAuthorization,
  mapInput: ({ params, query }) => ({
    workflowId: params.workflowId,
    includeReferences: query.includeReferences === true,
    includeWorkspaceBindings: query.includeWorkspaceBindings,
  }),
  useCase: exportWorkflow,
  present: ({ payload, folderPath }) => ({
    data: {
      ...payload,
      state: {
        ...payload.state,
        blocks: presentExportBlocks(payload.state.blocks),
      },
      workflow: {
        id: payload.workflow.id,
        name: payload.workflow.name,
        description: payload.workflow.description,
        workspaceId: payload.workflow.workspaceId,
        folderPath,
      },
    },
  }),
})
