import { OrchestrationError } from '@/lib/core/orchestration/types'
import {
  importWorkspaceFileSnapshotProvenance,
  MODEL_UNSAFE_WORKSPACE_FILE_ERROR_MESSAGE,
} from '@/lib/uploads/contexts/workspace/workspace-file-secret-provenance'
import {
  observeWorkspaceFileDelivery,
  WorkspaceFileDeliveryUnobservedError,
} from '@/lib/workspace-files/application/file-delivery-observer'
import type { ToolExecutionContext } from '@/local-copilot/lib/tools/executor'

type LocalFileDeliveryContext = Pick<
  ToolExecutionContext,
  'workspaceId' | 'userId' | 'resolvedSecretTraceRegistry'
>

/**
 * Cloud's file-read transport installs a delivery observer before any Copilot
 * principal reaches stored bytes. Local VFS tools call the same application use
 * cases in-process, so they must wrap the same way — otherwise
 * `requireCopilotWorkspaceFileDeliveryObserver` refuses the read.
 */
export async function withLocalWorkspaceFileDeliveryObservation<T>(
  ctx: LocalFileDeliveryContext,
  execute: () => Promise<T>
): Promise<T> {
  if (!ctx.workspaceId?.trim()) {
    throw new Error('No workspace context available')
  }
  if (!ctx.resolvedSecretTraceRegistry) {
    throw new WorkspaceFileDeliveryUnobservedError()
  }

  const workspaceId = ctx.workspaceId
  const registry = ctx.resolvedSecretTraceRegistry

  return observeWorkspaceFileDelivery(async (source, fileId) => {
    const admitted = await importWorkspaceFileSnapshotProvenance({
      workspaceId,
      provenance: source ?? { status: 'unknown' },
      registry,
      actorUserId: ctx.userId,
      resourceId: fileId,
    })
    if (!admitted) {
      throw new OrchestrationError('forbidden', MODEL_UNSAFE_WORKSPACE_FILE_ERROR_MESSAGE)
    }
  }, execute)
}
