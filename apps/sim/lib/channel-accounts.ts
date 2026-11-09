/**
 * Database-driven channel accounts management
 * Fetches accounts from database instead of hardcoded constants
 */

import { db } from '@sim/db'
import { workspace } from '@sim/db/schema'
import { createLogger } from '@sim/logger'
import { eq, sql } from 'drizzle-orm'
import { getSession } from '@/lib/auth'
import { env } from '@/lib/core/config/env'

const logger = createLogger('ChannelAccounts')

export interface ChannelAccount {
  id: string
  name: string
}

interface ChannelAccountRow {
  account_id?: string
  account_name?: string
  accountid?: string
  accountname?: string
}

/**
 * Parses `ANALYTICS_WORKSPACE_IDS` from env as a JSON array or comma-separated list.
 */
function parseAnalyticsWorkspaceIds(): string[] {
  const raw = env.ANALYTICS_WORKSPACE_IDS
  if (!raw) return []

  const trimmed = raw.trim()
  if (trimmed.startsWith('[')) {
    try {
      const parsed = JSON.parse(trimmed) as unknown
      if (Array.isArray(parsed)) {
        return parsed.filter((id): id is string => typeof id === 'string' && id.length > 0)
      }
    } catch {
      logger.warn('Failed to parse ANALYTICS_WORKSPACE_IDS as JSON array')
    }
  }

  return trimmed
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean)
}

/**
 * Returns whether the workspace has access to the full shared channel account catalog.
 */
export function isAnalyticsWorkspace(workspaceId?: string): boolean {
  if (!workspaceId) return false
  return parseAnalyticsWorkspaceIds().includes(workspaceId)
}

function toAccountKey(accountName: string): string {
  return accountName
    .toLowerCase()
    .replace(/[^a-zA-Z0-9\s]/g, '')
    .replace(/\s+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
}

function mapRowsToAccounts(rows: ChannelAccountRow[]): Record<string, ChannelAccount> {
  const accounts: Record<string, ChannelAccount> = {}

  for (const row of rows) {
    const accountName = String(row.account_name ?? row.accountname ?? '')
    const accountId = String(row.account_id ?? row.accountid ?? '')
    if (!accountName || !accountId) continue

    const key = toAccountKey(accountName)
    accounts[key] = {
      id: accountId,
      name: accountName,
    }
  }

  return accounts
}

/**
 * Returns account IDs explicitly mapped to the workspace in
 * `client_analytics_account_mapping` for the given channel type.
 *
 * When a workspace has mapping rows, they take precedence over the
 * analytics/admin full-catalog behavior, so client workspaces (e.g.
 * Eventgroove) can be restricted to their own accounts per channel.
 */
async function getMappedAccountIds(
  workspaceId: string,
  type: 'facebook' | 'bing' | 'google'
): Promise<string[]> {
  const result = await db.execute(sql`
    SELECT sub_account_id
    FROM client_analytics_account_mapping
    WHERE workspace_id_ref = ${workspaceId}
      AND sub_account_type = ${type}
  `)

  return (result as unknown as Array<{ sub_account_id: string }>)
    .map((row) => String(row.sub_account_id))
    .filter(Boolean)
}

/** Builds a text ARRAY[...] SQL expression from a non-empty list of IDs. */
function idArrayExpression(ids: string[]) {
  return sql`ARRAY[${sql.join(
    ids.map((id) => sql`${id}`),
    sql`, `
  )}]::text[]`
}

/**
 * Fetches channel accounts from database by type.
 * Analytics workspaces receive the full shared catalog; other workspaces receive none.
 *
 * @param type - Account type ('facebook', 'bing', 'google')
 * @param workspaceId - Current workspace ID used for access control
 * @param userId - Optional user ID for server-side tool execution (when session cookies are unavailable)
 * @returns Accounts in the same format as legacy constants
 */
export async function getChannelAccounts(
  type: 'facebook' | 'bing' | 'google',
  workspaceId?: string,
  userId?: string
): Promise<Record<string, ChannelAccount>> {
  try {
    if (!workspaceId) {
      return {}
    }

    // Mapping-first: explicit workspace mappings win over the analytics
    // full-catalog path, so a workspace can be in ANALYTICS_WORKSPACE_IDS
    // (needed for Bing/Facebook env gates) while still seeing only its
    // mapped accounts for this channel.
    const mappedIds = await getMappedAccountIds(workspaceId, type)
    if (mappedIds.length > 0) {
      const mappedResult = await db.execute(sql`
        SELECT account_id, account_name
        FROM channel_accounts
        WHERE account_type = ${type}
          AND account_id = ANY(${idArrayExpression(mappedIds)})
        ORDER BY account_name
      `)
      return mapRowsToAccounts(mappedResult as unknown as ChannelAccountRow[])
    }

    if (isAnalyticsWorkspace(workspaceId)) {
      const result = await db.execute(sql`
        SELECT account_id, account_name 
        FROM channel_accounts 
        WHERE account_type = ${type} 
        ORDER BY account_name
      `)
      return mapRowsToAccounts(result as unknown as ChannelAccountRow[])
    }

    const session = await getSession()
    const resolvedUserId = userId ?? session?.user?.id
    if (!resolvedUserId) {
      logger.warn('No authenticated user for workspace-scoped channel accounts', { workspaceId })
      return {}
    }

    const [currentWorkspace] = await db
      .select({ isPersonal: workspace.isPersonal })
      .from(workspace)
      .where(eq(workspace.id, workspaceId))
      .limit(1)

    const isPersonalWorkspace = currentWorkspace?.isPersonal === true

    const mappedResult = isPersonalWorkspace
      ? await db.execute(sql`
          SELECT ca.account_id as account_id, ca.account_name as account_name
          FROM channel_accounts ca
          WHERE ca.account_type = ${type}
            AND ca.account_id IN (
              SELECT DISTINCT sub_account_id
              FROM client_analytics_account_mapping
              WHERE workspace_id_ref IN (
                SELECT w.id
                FROM permissions p
                INNER JOIN workspace w ON p.entity_id = w.id
                WHERE p.user_id = ${resolvedUserId}
                  AND p.entity_type = 'workspace'
                  AND w.archived_at IS NULL
              )
            )
          ORDER BY ca.account_name
        `)
      : await db.execute(sql`
          SELECT ca.account_id as account_id, ca.account_name as account_name
          FROM channel_accounts ca
          WHERE ca.account_type = ${type}
            AND ca.account_id IN (
              SELECT cam.sub_account_id
              FROM client_analytics_account_mapping cam
              WHERE cam.workspace_id_ref = ${workspaceId}
                AND cam.sub_account_type = ${type}
            )
          ORDER BY ca.account_name
        `)

    return mapRowsToAccounts(mappedResult as unknown as ChannelAccountRow[])
  } catch (error) {
    logger.error(`Error fetching ${type} accounts from database`, { error, workspaceId })
    return {}
  }
}

/**
 * Fetches Google Ads accounts from database for the current workspace.
 */
export async function getGoogleAdsAccounts(
  workspaceId?: string,
  userId?: string
): Promise<Record<string, ChannelAccount>> {
  return getChannelAccounts('google', workspaceId, userId)
}

/**
 * Fetches Facebook Ads accounts from database (facebook_accounts table).
 *
 * When the workspace has rows in `client_analytics_account_mapping` with
 * sub_account_type = 'facebook', only those accounts are returned; otherwise
 * the full catalog is returned (legacy behavior for admin workspaces).
 */
export async function getFacebookAdsAccounts(
  workspaceId?: string
): Promise<Record<string, ChannelAccount>> {
  try {
    if (workspaceId) {
      const mappedIds = await getMappedAccountIds(workspaceId, 'facebook')
      if (mappedIds.length > 0) {
        const mappedResult = await db.execute(sql`
          SELECT account_id, account_name
          FROM facebook_accounts
          WHERE account_id = ANY(${idArrayExpression(mappedIds)})
          ORDER BY account_name
        `)
        return mapRowsToAccounts(mappedResult as unknown as ChannelAccountRow[])
      }
    }

    const result = await db.execute(sql`
      SELECT account_id, account_name 
      FROM facebook_accounts 
      ORDER BY account_name
    `)

    const accounts: Record<string, ChannelAccount> = {}

    for (const row of result as unknown as Array<{ account_id: string; account_name: string }>) {
      const key = String(row.account_name)
        .toLowerCase()
        .replace(/[^a-zA-Z0-9\s]/g, '')
        .replace(/\s+/g, '_')
        .replace(/_+/g, '_')
        .replace(/^_|_$/g, '')

      accounts[key] = {
        id: String(row.account_id),
        name: String(row.account_name),
      }
    }

    return accounts
  } catch (error) {
    logger.error('Error fetching facebook accounts from database', { error })
    return {}
  }
}

/**
 * Fetches Bing Ads accounts from the dedicated `bing_accounts` table.
 *
 * Workspaces with rows in `client_analytics_account_mapping`
 * (sub_account_type = 'bing') see only their mapped accounts. Workspaces
 * without mappings keep the legacy behavior: the full catalog for analytics
 * (Position2) workspaces, nothing for everyone else.
 */
export async function getBingAdsAccounts(
  workspaceId?: string
): Promise<Record<string, ChannelAccount>> {
  try {
    if (workspaceId) {
      const mappedIds = await getMappedAccountIds(workspaceId, 'bing')
      if (mappedIds.length > 0) {
        const mappedResult = await db.execute(sql`
          SELECT account_id, account_name
          FROM bing_accounts
          WHERE account_id = ANY(${idArrayExpression(mappedIds)})
          ORDER BY account_name
        `)
        return mapRowsToAccounts(mappedResult as unknown as ChannelAccountRow[])
      }
    }

    if (!isAnalyticsWorkspace(workspaceId)) {
      return {}
    }

    const result = await db.execute(sql`
      SELECT account_id, account_name
      FROM bing_accounts
      ORDER BY account_name
    `)

    return mapRowsToAccounts(result as unknown as ChannelAccountRow[])
  } catch (error) {
    logger.error('Error fetching bing accounts from database', { error, workspaceId })
    return {}
  }
}
