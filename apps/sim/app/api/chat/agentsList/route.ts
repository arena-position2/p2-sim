import { db } from '@sim/db'
import { chat, user, workflow, workflowExecutionLogs } from '@sim/db/schema'
import { createLogger } from '@sim/logger'
import type { SQL } from 'drizzle-orm'
import { and, desc, eq, inArray, isNotNull, ne } from 'drizzle-orm'
import { type NextRequest, NextResponse } from 'next/server'
import { verifyCronAuth } from '@/lib/auth/internal'
import {
  hasAgentEmailAccess,
  hasAllowedEmailStartingWithAtSymbol,
} from '@/lib/chat/agent-email-access'
import {
  getAgentDepartmentLabelMap,
  labelFromDepartmentMap,
  resolveAgentDepartmentValue,
} from '@/lib/chat/arena-departments'
import { withLoggedInEmailOnVideoAgentUrl } from '@/lib/chat/video-agent-redirect'
import { getUniqueBlockNamesByWorkflowId } from '@/lib/chat/workflow-block-names'
import { getBaseUrl } from '@/lib/core/utils/urls'

const logger = createLogger('DeployedChatAgentsListAPI')

interface AgentChatRow {
  chatId: string
  title: string
  authorEmail: string | null
  workflowId: string
  workflowName: string
  workspaceId: string | null
  department: string | null
  createdAt: Date
  allowedEmails: unknown
  description: string | null
  identifier?: string | null
  deploymentType?: string | null
  redirectUrl?: string | null
  arenaPath?: string | null
}

/** Maps a DB row to the response agent list item shape. */
function toAgentListItem(
  row: AgentChatRow,
  departmentLabelMap: Map<string, string>,
  blockNames: string[],
  viewerEmail: string
) {
  const appRedirectUrl = row.deploymentType === 'app' && row.redirectUrl ? row.redirectUrl : null
  return {
    id: row.chatId,
    title: row.title,
    author_email: row.authorEmail,
    workflow_id: row.workflowId,
    workflow_name: row.workflowName,
    workspace_id: row.workspaceId,
    department: labelFromDepartmentMap(departmentLabelMap, row.department),
    created_at: row.createdAt.toISOString(),
    workflow_description: row.description,
    status: 'published',
    identifier: row.identifier,
    deployment_type: row.deploymentType === 'app' ? 'app' : 'chat',
    redirect_url: appRedirectUrl
      ? withLoggedInEmailOnVideoAgentUrl(appRedirectUrl, viewerEmail)
      : `${getBaseUrl()}/chat/${row.identifier || row.workflowId}?workspaceId=${row.workspaceId}`,
    arena_path: row.arenaPath?.trim() || null,
    block_names: blockNames,
    // allowedEmails: row.allowedEmails,
  }
}

type AgentListItem = ReturnType<typeof toAgentListItem>

type AgentListItemWithDisabled = AgentListItem & { disabled: boolean }

/**
 * Parses GENERIC_AGENTS_WORKSPACE_ID query param (JSON string array of workspace IDs).
 * Example: `["bd10ec38-de06-4f44-bf2e-566c151556a2"]`
 */
function parseGenericAgentsWorkspaceIds(raw: string | null): string[] {
  if (!raw?.trim()) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter((id): id is string => typeof id === 'string' && id.trim().length > 0)
  } catch {
    logger.warn('Invalid GENERIC_AGENTS_WORKSPACE_ID query param; expected JSON string array')
    return []
  }
}

/** Maps chat rows to list items, attaching unique workflow block types in one query. */
async function toAgentListItems(
  rows: AgentChatRow[],
  departmentLabelMap: Map<string, string>,
  viewerEmail: string
): Promise<AgentListItem[]> {
  const blockNamesByWorkflowId = await getUniqueBlockNamesByWorkflowId(
    rows.map((row) => row.workflowId)
  )
  return rows.map((row) =>
    toAgentListItem(
      row,
      departmentLabelMap,
      blockNamesByWorkflowId.get(row.workflowId) ?? [],
      viewerEmail
    )
  )
}

/**
 * Returns execution log rows for the given workflowIds and userId, ordered by started_at desc.
 * Deduplicated by workflowId so each workflow appears once (most recent first).
 */
async function getRecentUsedAgentsFromLogs(
  workflowIds: string[],
  userId: string
): Promise<{ workflowId: string; startedAt: Date }[]> {
  if (workflowIds.length === 0) return []
  const rows = await db
    .select({
      workflowId: workflowExecutionLogs.workflowId,
      startedAt: workflowExecutionLogs.startedAt,
    })
    .from(workflowExecutionLogs)
    .where(
      and(
        isNotNull(workflowExecutionLogs.chatId),
        eq(workflowExecutionLogs.userId, userId),
        inArray(workflowExecutionLogs.workflowId, workflowIds)
      )
    )
    .orderBy(desc(workflowExecutionLogs.startedAt))

  const seen = new Set<string>()
  const deduped: { workflowId: string; startedAt: Date }[] = []
  for (const row of rows) {
    if (row.workflowId && !seen.has(row.workflowId)) {
      seen.add(row.workflowId)
      deduped.push({ workflowId: row.workflowId, startedAt: row.startedAt })
    }
  }
  return deduped
}

/**
 * Sorts agent list so items match the order of workflow IDs (recently used first).
 * Items whose workflow_id is not in the order list are placed last.
 */
function sortAgentListByWorkflowOrder<T extends { workflow_id: string }>(
  agentList: T[],
  orderedWorkflowIds: string[]
): T[] {
  const orderMap = new Map(orderedWorkflowIds.map((id, i) => [id, i]))
  return [...agentList].sort((a, b) => {
    const aIdx = orderMap.get(a.workflow_id) ?? Number.MAX_SAFE_INTEGER
    const bIdx = orderMap.get(b.workflow_id) ?? Number.MAX_SAFE_INTEGER
    return aIdx - bIdx
  })
}

/**
 * Builds workflow ID order: recently used first, then remaining agents in stable order.
 */
async function sortAgentListByRecentUsage<T extends { workflow_id: string }>(
  agentList: T[],
  userId: string
): Promise<T[]> {
  const workflowIds = agentList.map((row) => row.workflow_id)
  const recentUsedAgents = await getRecentUsedAgentsFromLogs(workflowIds, userId)
  const orderedWorkflowIds = recentUsedAgents.map((r) => r.workflowId)
  for (const workflowId of workflowIds) {
    if (!orderedWorkflowIds.includes(workflowId)) {
      orderedWorkflowIds.push(workflowId)
    }
  }
  return sortAgentListByWorkflowOrder(agentList, orderedWorkflowIds)
}

/** Merges agent lists by chat id; later entries replace earlier ones for the same id. */
function mergeAgentListsById(...lists: AgentListItem[][]): AgentListItem[] {
  const byId = new Map<string, AgentListItem>()
  for (const list of lists) {
    for (const item of list) {
      byId.set(item.id, item)
    }
  }
  return Array.from(byId.values())
}

const getAgentsListAllowedEmail = (chats: AgentChatRow[], emailId: string) => {
  return chats.filter((chatRecord) => {
    if (chatRecord.allowedEmails) {
      const allowedEmailsList = Array.isArray(chatRecord.allowedEmails)
        ? chatRecord.allowedEmails
        : []
      return allowedEmailsList.includes(emailId)
    }
    return false
  })
}

/**
 * Fetches active chats with their workflow and author metadata.
 *
 * Shared across tabs: joins workflow + author email. Only returns agents whose
 * workflow is deployed (`workflow.isDeployed`) and whose chat deployment is
 * active (`chat.isActive` — deployed as chat). Chat deployments remain listable
 * even when the same workflow also has an active schedule or webhook, since
 * chat runs use triggerType=chat independently of those automations.
 */
async function fetchAgentChats(whereConditions: SQL<unknown> | undefined): Promise<AgentChatRow[]> {
  /**
   * `whereConditions` is a Drizzle SQL expression assembled by the caller.
   * Keeping this typed as `SQL<unknown>` avoids leaking complex query generics throughout the file,
   * while still retaining type-safety (no `any`) at the boundary.
   *
   * Always require an active chat deployment on a deployed workflow, then AND
   * any tab-specific filters from the caller.
   */
  const deployedAsChatConditions = and(eq(chat.isActive, true), eq(workflow.isDeployed, true))
  const combinedWhere =
    whereConditions !== undefined
      ? and(deployedAsChatConditions, whereConditions)
      : deployedAsChatConditions

  return await db
    .select({
      chatId: chat.id,
      title: chat.title,
      workflowId: chat.workflowId,
      allowedEmails: chat.allowedEmails,
      department: chat.department,
      createdAt: chat.createdAt,
      workflowName: workflow.name,
      workspaceId: workflow.workspaceId,
      authorEmail: user.email,
      description: chat.description,
      identifier: chat.identifier,
      deploymentType: chat.deploymentType,
      redirectUrl: chat.redirectUrl,
      arenaPath: chat.arenaPath,
    })
    .from(chat)
    .innerJoin(workflow, eq(chat.workflowId, workflow.id))
    .innerJoin(user, eq(workflow.userId, user.id))
    .where(combinedWhere)
    .orderBy(desc(chat.updatedAt))
}

/**
 * Returns agents (chats) whose workflow was created by the user with the given email.
 * Creator is determined by workflow.userId, not chat.userId.
 */
async function getMyAgentsList(emailId: string): Promise<NextResponse> {
  const userRecord = await db
    .select({ id: user.id, email: user.email })
    .from(user)
    .where(eq(user.email, emailId))
    .limit(1)

  if (userRecord.length === 0) {
    logger.warn(`User not found for myagents: ${emailId}`)
    return NextResponse.json({ success: false, error: 'User not found' }, { status: 404 })
  }

  const creatorUserId = userRecord[0].id

  const chats = await fetchAgentChats(eq(workflow.userId, creatorUserId))

  /**
   * Core logic: for the "myagents" tab we keep the current behavior:
   * - Only return chats created by the current user
   * - And that are explicitly accessible via `allowedEmails` (exact email or domain pattern)
   */
  const accessibleChats = getAgentsListAllowedEmail(chats, emailId)

  const departmentLabelMap = await getAgentDepartmentLabelMap()
  const agentList = await sortAgentListByRecentUsage(
    await toAgentListItems(accessibleChats, departmentLabelMap, emailId),
    creatorUserId
  )

  logger.info(`agentsList (myagents): returning ${agentList.length} chats for ${emailId}`)

  return NextResponse.json({ success: true, agentList, count: agentList.length }, { status: 200 })
}

/**
 * Returns chats shared with the user via allowedEmails (exact or domain match),
 * excluding workflows created by that user.
 *
 * @param departmentValue - When set, only chats in this department are returned.
 */
async function fetchSharedWithMeChats(
  emailId: string,
  userId: string,
  departmentValue?: string
): Promise<AgentChatRow[]> {
  const sharedWhereConditions =
    departmentValue !== undefined
      ? and(eq(chat.department, departmentValue), ne(workflow.userId, userId))
      : ne(workflow.userId, userId)

  const chats = await fetchAgentChats(sharedWhereConditions)

  return getAgentsListAllowedEmail(chats, emailId)
}

/**
 * Returns agents where emailId is in allowedEmails (exact or domain match) but NOT created by this user.
 * Same allowedEmails logic as myagents; excludes workflow.userId = current user.
 */
async function getSharedWithMeAgentsList(emailId: string): Promise<NextResponse> {
  const userRecord = await db
    .select({ id: user.id })
    .from(user)
    .where(eq(user.email, emailId))
    .limit(1)

  if (userRecord.length === 0) {
    logger.warn(`User not found for sharedwithme: ${emailId}`)
    return NextResponse.json({ success: false, error: 'User not found' }, { status: 404 })
  }

  const sharedChats = await fetchSharedWithMeChats(emailId, userRecord[0].id)
  const departmentLabelMap = await getAgentDepartmentLabelMap()
  const agentList = await toAgentListItems(sharedChats, departmentLabelMap, emailId)

  logger.info(
    `agentsList (sharedwithme): returning ${agentList.length} chats for ${emailId} (in allowedEmails, not created by user)`
  )

  return NextResponse.json({ success: true, agentList, count: agentList.length }, { status: 200 })
}

interface GlobalAgentsListOptions {
  /** When true with genericWorkspaceIds, merge deployed chat agents from those workspaces. */
  onlyAgentAccess?: boolean
  /** Workspace IDs from GENERIC_AGENTS_WORKSPACE_ID whose deployed chat agents are always listed. */
  genericWorkspaceIds?: string[]
}

/**
 * Returns global agents (domain-wide allowedEmails) combined with shared-with-me agents,
 * sorted by the requesting user's recent chat usage.
 *
 * When `onlyAgentAccess` is set with `genericWorkspaceIds`, also merges all deployed
 * chat agents from those workspaces and adds `disabled` on every item:
 * `false` when emailId or the user's domain is in allowedEmails, otherwise `true`.
 */
async function getGlobalAgentsList(
  emailId: string,
  departmentValue: string | undefined,
  options: GlobalAgentsListOptions = {}
): Promise<NextResponse> {
  const userRecord = await db
    .select({ id: user.id })
    .from(user)
    .where(eq(user.email, emailId))
    .limit(1)

  if (userRecord.length === 0) {
    logger.warn(`User not found for global: ${emailId}`)
    return NextResponse.json({ success: false, error: 'User not found' }, { status: 404 })
  }

  const userId = userRecord[0].id
  const { onlyAgentAccess = false, genericWorkspaceIds = [] } = options
  const shouldMergeGenericAgents = onlyAgentAccess && genericWorkspaceIds.length > 0

  const globalWhereConditions =
    departmentValue !== undefined ? eq(chat.department, departmentValue) : undefined
  const userEmailDomain = `@${emailId.split('@')[1]}`

  const globalChats = await fetchAgentChats(globalWhereConditions)
  const departmentLabelMap = await getAgentDepartmentLabelMap()
  const globalAgentList = await toAgentListItems(
    globalChats.filter((row) =>
      hasAllowedEmailStartingWithAtSymbol(row.allowedEmails, userEmailDomain)
    ),
    departmentLabelMap,
    emailId
  )

  const sharedChats = await fetchSharedWithMeChats(emailId, userId, departmentValue)
  const sharedAgentList = await toAgentListItems(sharedChats, departmentLabelMap, emailId)

  const mergedAgentList = mergeAgentListsById(globalAgentList, sharedAgentList)
  let agentList: AgentListItem[] | AgentListItemWithDisabled[] = await sortAgentListByRecentUsage(
    mergedAgentList,
    userId
  )

  if (shouldMergeGenericAgents) {
    const accessibleGlobalRows = globalChats.filter((row) =>
      hasAllowedEmailStartingWithAtSymbol(row.allowedEmails, userEmailDomain)
    )
    const genericRows = await fetchAgentChats(inArray(workflow.workspaceId, genericWorkspaceIds))

    const allowedEmailsByChatId = new Map<string, unknown>()
    for (const row of [...accessibleGlobalRows, ...sharedChats, ...genericRows]) {
      allowedEmailsByChatId.set(row.chatId, row.allowedEmails)
    }

    const genericAgentList = await toAgentListItems(genericRows, departmentLabelMap, emailId)
    const mergedWithGeneric = mergeAgentListsById(mergedAgentList, genericAgentList)
    const sortedMerged = await sortAgentListByRecentUsage(mergedWithGeneric, userId)

    agentList = sortedMerged.map((item) => ({
      ...item,
      disabled: !hasAgentEmailAccess(allowedEmailsByChatId.get(item.id), emailId),
    }))

    logger.info(
      `agentsList (global+onlyAgentAccess): returning ${agentList.length} chats for ${emailId} (${globalAgentList.length} global + ${sharedAgentList.length} shared + ${genericAgentList.length} generic workspaces, deduped)`
    )
  } else {
    logger.info(
      `agentsList (global): returning ${agentList.length} chats for ${emailId} (${globalAgentList.length} global + ${sharedAgentList.length} shared, deduped)`
    )
  }

  return NextResponse.json({ success: true, agentList, count: agentList.length }, { status: 200 })
}

/**
 * GET /api/chat/agentsList
 * Query: tabName=global — returns global agents (domain allowedEmails) plus shared-with-me agents, sorted by recent usage; requires emailId.
 *        tabName=myagents — returns agents created by user or in allowedEmails; requires emailId.
 *        tabName=sharedwithme — returns agents where emailId is in allowedEmails (exact or domain) but NOT created by this user; requires emailId.
 * Optional for global: departmentName — filters both global and shared-with-me agents by department.
 * Optional for global: onlyAgentAccess=true & GENERIC_AGENTS_WORKSPACE_ID=<JSON string[]> —
 *   also merges deployed chat agents from those workspaces and adds `disabled` per item
 *   (`false` when emailId or user domain is in allowedEmails, else `true`).
 */
export async function GET(request: NextRequest) {
  const authError = verifyCronAuth(request, 'Schedule execution')
  if (authError) {
    return authError
  }

  try {
    const { searchParams } = new URL(request.url)
    const tabName = searchParams.get('tabName')
    const emailId = searchParams.get('emailId')

    if (tabName === 'myagents') {
      if (!emailId?.trim()) {
        return NextResponse.json(
          { success: false, error: 'emailId is required when tabName=myagents' },
          { status: 400 }
        )
      }
      return await getMyAgentsList(emailId.trim())
    }

    if (tabName === 'sharedwithme') {
      if (!emailId?.trim()) {
        return NextResponse.json(
          { success: false, error: 'emailId is required when tabName=sharedwithme' },
          { status: 400 }
        )
      }
      return await getSharedWithMeAgentsList(emailId.trim())
    }

    if (tabName === 'global') {
      if (!emailId?.trim()) {
        return NextResponse.json(
          { success: false, error: 'emailId is required when tabName=global' },
          { status: 400 }
        )
      }

      const departmentName = searchParams.get('departmentName')
      const departmentValue = await resolveAgentDepartmentValue(departmentName)
      const onlyAgentAccess = searchParams.get('onlyAgentAccess') === 'true'
      const genericWorkspaceIds = parseGenericAgentsWorkspaceIds(
        searchParams.get('GENERIC_AGENTS_WORKSPACE_ID')
      )

      return await getGlobalAgentsList(emailId.trim(), departmentValue, {
        onlyAgentAccess,
        genericWorkspaceIds,
      })
    }

    return NextResponse.json({ success: true, agentList: [], count: 0 }, { status: 200 })
  } catch (error: unknown) {
    logger.error('Error fetching agents list:', error)
    return NextResponse.json(
      {
        success: false,
        error: error instanceof Error ? error.message : 'Internal server error',
      },
      { status: 500 }
    )
  }
}
