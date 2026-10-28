import { db } from '@sim/db'
import { account, credential } from '@sim/db/schema'
import { createLogger } from '@sim/logger'
import { and, eq, like, or } from 'drizzle-orm'
import { deleteUnipileExternalAccount } from '@/lib/unipile/delete-account'
import { UNIPILE_LINKEDIN_PROVIDER_ID } from '@/lib/unipile/hosted-auth'

const logger = createLogger('UnipileDisconnectAccounts')

export interface AccountRowToDisconnect {
  id: string
  providerId: string
  externalUnipileAccountId: string
}

export interface ListAccountsToDisconnectParams {
  userId: string
  provider: string
  providerId?: string
  accountRowId?: string
}

/**
 * Lists Better Auth account rows that will be removed on disconnect (before DELETE).
 */
export async function listAccountsToDisconnect(
  params: ListAccountsToDisconnectParams
): Promise<AccountRowToDisconnect[]> {
  const { userId, provider, providerId, accountRowId } = params

  const baseSelect = {
    id: account.id,
    providerId: account.providerId,
    externalUnipileAccountId: account.accountId,
  }

  if (accountRowId) {
    const rows = await db
      .select(baseSelect)
      .from(account)
      .where(and(eq(account.userId, userId), eq(account.id, accountRowId)))
    return rows.filter((row) => row.externalUnipileAccountId.trim() !== '')
  }

  if (providerId) {
    const rows = await db
      .select(baseSelect)
      .from(account)
      .where(and(eq(account.userId, userId), eq(account.providerId, providerId)))
    return rows.filter((row) => row.externalUnipileAccountId.trim() !== '')
  }

  const rows = await db
    .select(baseSelect)
    .from(account)
    .where(
      and(
        eq(account.userId, userId),
        or(eq(account.providerId, provider), like(account.providerId, `${provider}-%`))
      )
    )
  return rows.filter((row) => row.externalUnipileAccountId.trim() !== '')
}

async function resolveWorkspaceIdForAccountRow(accountRowId: string): Promise<string | undefined> {
  const [row] = await db
    .select({ workspaceId: credential.workspaceId })
    .from(credential)
    .where(eq(credential.accountId, accountRowId))
    .limit(1)
  return row?.workspaceId ?? undefined
}

/**
 * Calls Unipile `DELETE /api/v1/accounts/{id}` for each LinkedIn (Unipile) row before local DB delete.
 */
export async function unlinkUnipileAccountsFromProvider(
  rows: AccountRowToDisconnect[]
): Promise<void> {
  for (const row of rows) {
    if (row.providerId !== UNIPILE_LINKEDIN_PROVIDER_ID) {
      continue
    }

    const workspaceId = await resolveWorkspaceIdForAccountRow(row.id)
    try {
      await deleteUnipileExternalAccount({
        externalAccountId: row.externalUnipileAccountId,
        workspaceId,
      })
    } catch (error) {
      logger.error('Failed to unlink Unipile account before local disconnect', {
        accountRowId: row.id,
        externalAccountId: row.externalUnipileAccountId,
        error,
      })
      throw error
    }
  }
}
