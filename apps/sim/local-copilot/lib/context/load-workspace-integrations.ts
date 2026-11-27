import { isHosted } from '@/lib/core/config/env-flags'
import type { AccessibleOAuthCredential } from '@/lib/credentials/environment'
import {
  getAccessibleEnvCredentials,
  getAccessibleOAuthCredentials,
  getEnrolledManagedOAuthCredentials,
} from '@/lib/credentials/environment'
import { getEffectiveDecryptedEnv } from '@/lib/environment/utils'
import {
  getHubSpotSharedAccountOptionIds,
  mergeOAuthIntegrationPresence,
} from '@/lib/mothership/chat/env-integration-presence'
import type { VfsSnapshotV1 } from '@/lib/mothership/generated/vfs-snapshot-v1'
import type { LocalCopilotConnectedIntegration } from '@/local-copilot/lib/types'

export interface WorkspaceIntegrationsContext {
  connectedIntegrations: LocalCopilotConnectedIntegration[]
  envVariables: string[]
  hostedKeysAvailable: boolean
}

/**
 * Maps mothership VFS snapshot integration/env inventory into Local context
 * without a second OAuth/env decrypt round-trip.
 */
export function mapSnapshotToWorkspaceIntegrations(
  snapshot: VfsSnapshotV1
): WorkspaceIntegrationsContext {
  return {
    connectedIntegrations: (snapshot.integrations ?? []).map((integration) => ({
      credentialId: integration.id,
      providerId: integration.providerId,
      ...(integration.displayName ? { displayName: integration.displayName } : {}),
      role: integration.role ?? null,
    })),
    envVariables: [...(snapshot.envVars ?? [])].sort(),
    hostedKeysAvailable: isHosted,
  }
}

function ownedManagedIntegrations(
  rows: AccessibleOAuthCredential[],
  presentIds: ReadonlySet<string>
): LocalCopilotConnectedIntegration[] {
  return rows
    .filter((row) => !presentIds.has(row.id))
    .map((row) => ({
      credentialId: row.id,
      providerId: row.providerId,
      displayName: row.displayName,
      role: 'member',
      isOwn: true,
      updatedAt: row.updatedAt,
    }))
}

/**
 * The workspace snapshot has no owner field, and it omits Credential Group
 * connections. Restore which OAuth rows belong to the signed-in user and add
 * that person's enrolled accounts so Copilot can use their Slack.
 */
export async function attachSignedInIntegrationOwnership(
  workspaceId: string,
  userId: string,
  mapped: WorkspaceIntegrationsContext
): Promise<WorkspaceIntegrationsContext> {
  const [oauthRows, managedRows] = await Promise.all([
    getAccessibleOAuthCredentials(workspaceId, userId),
    getEnrolledManagedOAuthCredentials(workspaceId, userId),
  ])
  const oauthById = new Map(oauthRows.map((row) => [row.id, row]))
  const connectedIntegrations = mapped.connectedIntegrations.map((integration) => {
    const row = oauthById.get(integration.credentialId)
    if (!row) return integration
    return {
      ...integration,
      ...(row.ownerUserId === userId ? { isOwn: true } : {}),
      updatedAt: row.updatedAt,
    }
  })
  const presentIds = new Set(connectedIntegrations.map((integration) => integration.credentialId))
  const managed = ownedManagedIntegrations(managedRows, presentIds)
  return {
    ...mapped,
    connectedIntegrations:
      managed.length > 0 ? [...connectedIntegrations, ...managed] : connectedIntegrations,
  }
}

/**
 * Loads OAuth connections and configured env key names for Arena Copilot context.
 * Secret values are never returned — only key names and credential metadata.
 */
export async function loadWorkspaceIntegrations(
  workspaceId: string,
  userId: string
): Promise<WorkspaceIntegrationsContext> {
  const [oauthRows, envCredentialRows, decryptedEnv, managedRows] = await Promise.all([
    getAccessibleOAuthCredentials(workspaceId, userId),
    getAccessibleEnvCredentials(workspaceId, userId),
    getEffectiveDecryptedEnv(userId, workspaceId),
    getEnrolledManagedOAuthCredentials(workspaceId, userId),
  ])

  const envKeysFromCredentials = envCredentialRows
    .map((row) => row.envKey)
    .filter((key): key is string => Boolean(key?.trim()))

  const envKeysFromRuntime = Object.entries(decryptedEnv)
    .filter(([, value]) => typeof value === 'string' && value.trim().length > 0)
    .map(([key]) => key)

  const envVariables = [...new Set([...envKeysFromCredentials, ...envKeysFromRuntime])].sort()

  const updatedAtById = new Map(oauthRows.map((row) => [row.id, row.updatedAt]))
  const connectedIntegrations = mergeOAuthIntegrationPresence(
    oauthRows.map((credential) => ({
      id: credential.id,
      providerId: credential.providerId,
      displayName: credential.displayName,
      role: credential.role,
      isOwn: credential.ownerUserId === userId,
    })),
    envKeysFromCredentials,
    getHubSpotSharedAccountOptionIds()
  ).map((integration) => {
    const updatedAt = updatedAtById.get(integration.id)
    return {
      credentialId: integration.id,
      providerId: integration.providerId,
      displayName: integration.displayName,
      role: integration.role ?? null,
      ...(integration.isOwn ? { isOwn: true } : {}),
      ...(updatedAt ? { updatedAt } : {}),
    }
  })
  const presentIds = new Set(connectedIntegrations.map((integration) => integration.credentialId))
  const managed = ownedManagedIntegrations(managedRows, presentIds)

  return {
    connectedIntegrations:
      managed.length > 0 ? [...connectedIntegrations, ...managed] : connectedIntegrations,
    envVariables,
    hostedKeysAvailable: isHosted,
  }
}

export function oauthIntegrationsToCredentialMetadata(
  integrations: LocalCopilotConnectedIntegration[]
): Array<{
  credentialId: string
  provider: string
  status: 'connected'
  displayName?: string
}> {
  return integrations
    .filter((integration) => !integration.credentialId.startsWith('__env__'))
    .filter((integration) => !integration.credentialId.startsWith('__hubspot_'))
    .map((integration) => ({
      credentialId: integration.credentialId,
      provider: integration.providerId,
      status: 'connected' as const,
      ...(integration.displayName ? { displayName: integration.displayName } : {}),
    }))
}
