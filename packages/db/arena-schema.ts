import { sql } from 'drizzle-orm'
import {
  bigint,
  boolean,
  date,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  varchar,
} from 'drizzle-orm/pg-core'
import { knowledgeBase, organization, skill, user, workflow, workspace } from './schema'

export const accountTokens = pgTable(
  'account_tokens',
  {
    id: text('id').primaryKey(),
    providerId: text('provider_id').notNull(),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    accessTokenExpiresAt: timestamp('access_token_expires_at'),
    refreshTokenExpiresAt: timestamp('refresh_token_expires_at'),
    idToken: text('id_token'),
    scope: text('scope'),
    alias: text('alias'),
    userId: text('user_id').references(() => user.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (table) => ({
    aliasIdx: index('account_tokens_alias_idx').on(table.alias),
    providerAliasIdx: uniqueIndex('idx_account_tokens_on_provider_alias').on(
      table.providerId,
      table.alias
    ),
  })
)

export const defaultUserWorkflows = pgTable(
  'default_user_workflows',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    sourceWorkflowId: text('source_workflow_id').notNull(),
    userWorkflowId: text('user_workflow_id').notNull(),
    userWorkspaceId: text('user_workspace_id').notNull(),
    lastSyncedAt: timestamp('last_synced_at'),
    lastDeployedVersion: integer('last_deployed_version'),
    archivedAt: timestamp('archived_at'),
    createdAt: timestamp('created_at').notNull(),
    updatedAt: timestamp('updated_at').notNull(),
  },
  (table) => ({
    userSourceUnique: uniqueIndex('default_user_workflows_user_source_unique').on(
      table.userId,
      table.sourceWorkflowId
    ),
    sourceWorkflowIdIdx: index('default_user_workflows_source_workflow_id_idx').on(
      table.sourceWorkflowId
    ),
    userWorkflowIdIdx: index('default_user_workflows_user_workflow_id_idx').on(
      table.userWorkflowId
    ),
    archivedAtIdx: index('default_user_workflows_archived_at_idx').on(table.archivedAt),
  })
)

export const skillShareTypeEnum = pgEnum('skill_share_type', ['general', 'service'])

/**
 * Admin-managed service labels used to tag catalog skills (PPC, Ads, …).
 * Independent of workspace `skill` rows so existing skill CRUD is unchanged.
 */
export const skillService = pgTable(
  'skill_service',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (table) => ({
    nameUnique: uniqueIndex('skill_service_name_unique').on(table.name),
    slugUnique: uniqueIndex('skill_service_slug_unique').on(table.slug),
  })
)

/**
 * A workspace skill published by a platform admin for copying into other
 * workspaces. Origin tracking and type live here, not on `skill`.
 */
export const skillShareCatalog = pgTable(
  'skill_share_catalog',
  {
    id: text('id').primaryKey(),
    originSkillId: text('origin_skill_id')
      .notNull()
      .references(() => skill.id, { onDelete: 'cascade' }),
    originWorkspaceId: text('origin_workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'cascade' }),
    type: skillShareTypeEnum('type').notNull(),
    createdBy: text('created_by').references(() => user.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (table) => ({
    originSkillUnique: uniqueIndex('skill_share_catalog_origin_skill_unique').on(
      table.originSkillId
    ),
    typeIdx: index('skill_share_catalog_type_idx').on(table.type),
  })
)

export const skillShareCatalogService = pgTable(
  'skill_share_catalog_service',
  {
    catalogId: text('catalog_id')
      .notNull()
      .references(() => skillShareCatalog.id, { onDelete: 'cascade' }),
    serviceId: text('service_id')
      .notNull()
      .references(() => skillService.id, { onDelete: 'restrict' }),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.catalogId, table.serviceId] }),
    serviceIdx: index('skill_share_catalog_service_service_idx').on(table.serviceId),
  })
)

/**
 * Where a catalog skill was installed. `syncedContentHash` is the hash of
 * name+description+content at the last successful share; a local edit that
 * changes that payload skips the next overwrite.
 */
export const skillShareCopy = pgTable(
  'skill_share_copy',
  {
    id: text('id').primaryKey(),
    catalogId: text('catalog_id')
      .notNull()
      .references(() => skillShareCatalog.id, { onDelete: 'cascade' }),
    copySkillId: text('copy_skill_id')
      .notNull()
      .references(() => skill.id, { onDelete: 'cascade' }),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'cascade' }),
    syncedContentHash: text('synced_content_hash').notNull(),
    syncedAt: timestamp('synced_at').notNull().defaultNow(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (table) => ({
    catalogWorkspaceUnique: uniqueIndex('skill_share_copy_catalog_workspace_unique').on(
      table.catalogId,
      table.workspaceId
    ),
    copySkillUnique: uniqueIndex('skill_share_copy_skill_unique').on(table.copySkillId),
    workspaceIdx: index('skill_share_copy_workspace_idx').on(table.workspaceId),
  })
)

export const mothershipSettings = pgTable('mothership_settings', {
  workspaceId: text('workspace_id')
    .primaryKey()
    .references(() => workspace.id, { onDelete: 'cascade' }),
  mcpToolRefs: jsonb('mcp_tool_refs').notNull().default(sql`'[]'::jsonb`),
  customToolRefs: jsonb('custom_tool_refs').notNull().default(sql`'[]'::jsonb`),
  skillRefs: jsonb('skill_refs').notNull().default(sql`'[]'::jsonb`),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
})

export const workflowQueries = pgTable(
  'workflow_queries',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    workflowId: text('workflow_id')
      .notNull()
      .references(() => workflow.id, { onDelete: 'cascade' }),
    query: text('query').notNull(),
    priority: integer('priority').notNull().default(0),
    deleted: boolean('deleted').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    workflowIdIdx: index('workflow_queries_workflow_id_idx').on(table.workflowId),
    userIdIdx: index('workflow_queries_user_id_idx').on(table.userId),
  })
)

export const userKnowledgeBase = pgTable(
  'user_knowledge_base',
  {
    id: text('id').primaryKey(),
    userIdRef: text('user_id_ref')
      .notNull()
      .default('')
      .references(() => user.id, { onDelete: 'cascade' }),
    userWorkspaceIdRef: text('user_workspace_id_ref')
      .notNull()
      .default('')
      .references(() => workspace.id, { onDelete: 'cascade' }),
    knowledgeBaseIdRef: text('knowledge_base_id_ref')
      .notNull()
      .default('')
      .references(() => knowledgeBase.id, { onDelete: 'cascade' }),
    kbWorkspaceIdRef: text('kb_workspace_id_ref')
      .notNull()
      .default('')
      .references(() => workspace.id, { onDelete: 'cascade' }),
    knowledgeBaseNameRef: text('knowledge_base_name_ref').notNull(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
    deletedAt: timestamp('deleted_at'),
  },
  (table) => ({
    userIdRefIdx: index('user_kb_user_id_ref_idx').on(table.userIdRef),
    userWorkspaceIdRefIdx: index('user_kb_user_workspace_id_ref_idx').on(table.userWorkspaceIdRef),
    kbIdRefIdx: index('user_kb_kb_id_ref_idx').on(table.knowledgeBaseIdRef),
    kbWorkspaceIdRefIdx: index('user_kb_kb_workspace_id_ref_idx').on(table.kbWorkspaceIdRef),
    userKbIdx: index('user_kb_user_kb_idx').on(table.userIdRef, table.knowledgeBaseIdRef),
    userWorkspaceKbIdx: index('user_kb_user_workspace_kb_idx').on(
      table.userWorkspaceIdRef,
      table.knowledgeBaseIdRef
    ),
    deletedAtIdx: index('user_kb_deleted_at_idx').on(table.deletedAt),
  })
)

export const localCopilotPatchStatusEnum = pgEnum('local_copilot_patch_status', [
  'pending',
  'applied',
  'rejected',
  'expired',
])

export const localCopilotAuditStatusEnum = pgEnum('local_copilot_audit_status', [
  'success',
  'failure',
  'rejected',
])

/**
 * Allowlisted Local Copilot picker ids. Keep in sync with
 * `LOCAL_COPILOT_CATALOG` in `apps/sim/local-copilot/lib/model-catalog.ts`.
 */
export const localCopilotDefaultModelEnum = pgEnum('local_copilot_default_model', [
  'claude',
  'gemini-3.8-flash',
  'gemini-2.5-pro',
  'gemini-3.1-pro',
  'vertex-gemini-3.8-flash',
  'bedrock-claude-fable-5-1',
  'bedrock-gpt-6-astra',
  'bedrock-gpt-5.5',
  'bedrock-claude-opus-5',
  'bedrock-claude-sonnet-5',
  'bedrock-claude-opus-4-8',
  'bedrock-claude-opus-4-6',
  'bedrock-claude-sonnet-4-6',
  'bedrock-zai-glm-5',
  'bedrock-deepseek-v3.2',
  'bedrock-nemotron-super-3-120b',
  'bedrock-mistral-large-3',
  'bedrock-llama-3.3-70b',
])

export const localCopilotConversations = pgTable(
  'local_copilot_conversations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'cascade' }),
    workflowId: text('workflow_id').references(() => workflow.id, { onDelete: 'cascade' }),
    title: text('title'),
    model: text('model').notNull(),
    provider: text('provider').notNull(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (table) => ({
    userIdIdx: index('local_copilot_conversations_user_id_idx').on(table.userId),
    workspaceIdIdx: index('local_copilot_conversations_workspace_id_idx').on(table.workspaceId),
    workflowIdIdx: index('local_copilot_conversations_workflow_id_idx').on(table.workflowId),
    userWorkflowIdx: index('local_copilot_conversations_user_workflow_idx').on(
      table.userId,
      table.workflowId
    ),
    updatedAtIdx: index('local_copilot_conversations_updated_at_idx').on(table.updatedAt),
  })
)

export const localCopilotMessages = pgTable(
  'local_copilot_messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => localCopilotConversations.id, { onDelete: 'cascade' }),
    role: text('role').notNull(),
    content: jsonb('content').notNull(),
    seq: integer('seq').notNull(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => ({
    conversationSeqIdx: index('local_copilot_messages_conversation_seq_idx').on(
      table.conversationId,
      table.seq
    ),
  })
)

export const localCopilotToolCalls = pgTable(
  'local_copilot_tool_calls',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => localCopilotConversations.id, { onDelete: 'cascade' }),
    messageId: uuid('message_id').references(() => localCopilotMessages.id, {
      onDelete: 'set null',
    }),
    toolName: text('tool_name').notNull(),
    toolCallId: text('tool_call_id').notNull(),
    arguments: jsonb('arguments').notNull().default({}),
    result: jsonb('result'),
    status: text('status').notNull().default('completed'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    completedAt: timestamp('completed_at'),
  },
  (table) => ({
    conversationIdIdx: index('local_copilot_tool_calls_conversation_id_idx').on(
      table.conversationId
    ),
    toolCallIdIdx: index('local_copilot_tool_calls_tool_call_id_idx').on(table.toolCallId),
  })
)

export const localCopilotPatches = pgTable(
  'local_copilot_patches',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => localCopilotConversations.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    workflowId: text('workflow_id')
      .notNull()
      .references(() => workflow.id, { onDelete: 'cascade' }),
    summary: text('summary').notNull(),
    patch: jsonb('patch').notNull(),
    status: localCopilotPatchStatusEnum('status').notNull().default('pending'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    resolvedAt: timestamp('resolved_at'),
  },
  (table) => ({
    conversationIdIdx: index('local_copilot_patches_conversation_id_idx').on(table.conversationId),
    workflowIdIdx: index('local_copilot_patches_workflow_id_idx').on(table.workflowId),
    statusIdx: index('local_copilot_patches_status_idx').on(table.status),
  })
)

export const localCopilotAuditLogs = pgTable(
  'local_copilot_audit_logs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'cascade' }),
    workflowId: text('workflow_id').references(() => workflow.id, { onDelete: 'set null' }),
    conversationId: uuid('conversation_id').references(() => localCopilotConversations.id, {
      onDelete: 'set null',
    }),
    patchId: uuid('patch_id').references(() => localCopilotPatches.id, { onDelete: 'set null' }),
    action: text('action').notNull(),
    summary: text('summary'),
    status: localCopilotAuditStatusEnum('status').notNull().default('success'),
    metadata: jsonb('metadata').notNull().default({}),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => ({
    userIdIdx: index('local_copilot_audit_logs_user_id_idx').on(table.userId),
    workspaceIdIdx: index('local_copilot_audit_logs_workspace_id_idx').on(table.workspaceId),
    workflowIdIdx: index('local_copilot_audit_logs_workflow_id_idx').on(table.workflowId),
    createdAtIdx: index('local_copilot_audit_logs_created_at_idx').on(table.createdAt),
  })
)

/**
 * Per-user Arena Copilot allowlist. Access is denied unless a row exists for the
 * user with `hasAccess = true` or `localOnly = true`. Managed via SQL only
 * (no admin UI). New accounts default to `localOnly = true` and Gemini.
 */
export const localCopilotUserAccess = pgTable(
  'local_copilot_user_access',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    hasAccess: boolean('has_access').notNull().default(false),
    localOnly: boolean('local_only').notNull().default(true),
    defaultModel: localCopilotDefaultModelEnum('default_model').notNull().default('gemini-2.5-pro'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (table) => ({
    userIdUnique: uniqueIndex('local_copilot_user_access_user_id_uidx').on(table.userId),
    emailIdx: index('local_copilot_user_access_email_idx').on(table.email),
  })
)

/**
 * Long-lived Arena Copilot memories (preferences, entities, corrections).
 * Scoped to a user; optional workspaceId narrows visibility to one workspace.
 * Cloud Go `user_memory` is separate — this table is Local/self-hosted only.
 */
export const localCopilotUserMemory = pgTable(
  'local_copilot_user_memory',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    workspaceId: text('workspace_id').references(() => workspace.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    value: text('value').notNull(),
    memoryType: text('memory_type').notNull().default('preference'),
    source: text('source').notNull().default('explicit'),
    confidence: doublePrecision('confidence').notNull().default(1),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (table) => ({
    userKeyGlobalUnique: uniqueIndex('local_copilot_user_memory_user_key_global_uidx')
      .on(table.userId, table.key)
      .where(sql`${table.workspaceId} IS NULL`),
    userWorkspaceKeyUnique: uniqueIndex('local_copilot_user_memory_user_workspace_key_uidx')
      .on(table.userId, table.workspaceId, table.key)
      .where(sql`${table.workspaceId} IS NOT NULL`),
    userIdIdx: index('local_copilot_user_memory_user_id_idx').on(table.userId),
    workspaceIdIdx: index('local_copilot_user_memory_workspace_id_idx').on(table.workspaceId),
    memoryTypeIdx: index('local_copilot_user_memory_type_idx').on(table.memoryType),
  })
)

export type LocalCopilotPatchStatus = (typeof localCopilotPatchStatusEnum.enumValues)[number]
export type LocalCopilotAuditStatus = (typeof localCopilotAuditStatusEnum.enumValues)[number]

/**
 * Organization-scoped "bring your own OAuth app" credentials.
 *
 * Lets an organization register its own OAuth app (client id/secret) for a
 * provider instead of using Sim's shared app, so every workspace under that
 * organization authorizes against the org's own app registration. One row
 * per `(organizationId, providerId)` — `providerId` is the custom-app key
 * (e.g. `'zoom'` or `'zoom-admin'`). Distinct Marketplace / cloud apps that
 * need separate client credentials get separate keys; sibling services that
 * share one client map to the same key via `CUSTOM_OAUTH_APP_PROVIDERS`.
 * `clientSecret` is encrypted the same way as `mcpServers.oauthClientSecret`.
 */
export const organizationOauthApps = pgTable(
  'organization_oauth_apps',
  {
    id: text('id').primaryKey(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    providerId: text('provider_id').notNull(),
    clientId: text('client_id').notNull(),
    clientSecret: text('client_secret').notNull(),
    /**
     * Workspace IDs within this organization that may use this app.
     * Currently applied for `zoom-admin` only: non-empty list restricts access;
     * empty list falls back to env `ADMIN_WORKSPACE_IDS`.
     */
    allowedWorkspaceIds: jsonb('allowed_workspace_ids')
      .$type<string[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    createdBy: text('created_by')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (table) => ({
    orgProviderUnique: uniqueIndex('organization_oauth_apps_org_provider_unique').on(
      table.organizationId,
      table.providerId
    ),
  })
)

/**
 * Short-lived, single-use correlation state for the custom (non-Better-Auth)
 * OAuth authorize/callback flow used by providers with an organization-scoped
 * custom app (see {@link organizationOauthApps}). Mirrors the correlation
 * role `mcpServerOauth.state` plays for MCP OAuth, but generic across
 * providers and keyed by an opaque state token rather than one row per server.
 */
export const oauthCustomAppState = pgTable(
  'oauth_custom_app_state',
  {
    id: text('id').primaryKey(),
    /** Opaque token minted at authorize time and echoed back by the provider. */
    state: text('state').notNull(),
    providerId: text('provider_id').notNull(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    workspaceId: text('workspace_id')
      .notNull()
      .references(() => workspace.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    /** Where to redirect the browser back to once the flow completes. */
    returnUrl: text('return_url'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    expiresAt: timestamp('expires_at').notNull(),
  },
  (table) => ({
    stateUnique: uniqueIndex('oauth_custom_app_state_state_unique').on(table.state),
  })
)

export const deployedChat = pgTable(
  'deployed_chat',
  {
    id: text('id').primaryKey(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
    chatId: text('chat_id'),
    title: text('title'),
    workflowId: text('workflow_id'),
    executingUserId: text('executing_user_id'),
    archivedAt: timestamp('archived_at'),
    pinnedAt: timestamp('pinned_at'),
  },
  (table) => ({
    chatIdIdx: index('deployed_chat_chat_id_idx').on(table.chatId),
    workflowIdIdx: index('deployed_chat_workflow_id_idx').on(table.workflowId),
  })
)

export const chatPromptFeedback = pgTable(
  'chat_prompt_feedback',
  {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull(),
    comment: text('comment'),
    createdAt: timestamp('created_at').notNull(),
    updatedAt: timestamp('updated_at').notNull(),
    inComplete: boolean('in_complete').default(false),
    inAccurate: boolean('in_accurate').default(false),
    outOfDate: boolean('out_of_date').default(false),
    tooLong: boolean('too_long').default(false),
    tooShort: boolean('too_short').default(false),
    liked: boolean('liked').default(false),
    executionId: text('execution_id').notNull(),
    workflowId: text('workflow_id').notNull(),
  },
  (table) => ({
    createdAtIdx: index('chat_prompt_feedback_created_at_idx').on(table.createdAt),
  })
)

export const userArenaDetails = pgTable(
  'user_arena_details',
  {
    id: text('id'),
    userType: text('user_type'),
    createdAt: timestamp('created_at', { withTimezone: false }),
    department: text('department'),
    updatedAt: timestamp('updated_at', { withTimezone: false }),
    userIdRef: text('user_id_ref'),
    arenaUserIdRef: text('arena_user_id_ref'),
    airbyteRawId: text('_airbyte_raw_id').$type<string>(),
    airbyteExtractedAt: timestamp('_airbyte_extracted_at', { withTimezone: true }),
    airbyteGenerationId: bigint('_airbyte_generation_id', { mode: 'number' }),
    airbyteMeta: jsonb('_airbyte_meta'),
    /** Short-lived Arena access JWT from SSO redeem / refresh (interactive only). */
    arenaToken: text('arena_token'),
    /** Encrypted Arena refresh token (AES-256-GCM). Interactive SSO only. */
    arenaRefreshToken: text('arena_refresh_token'),
    timezone: text('timezone'),
    persona: text('persona'),
  },
  (table) => ({
    airbyteRawIdIdx: index('user_arena_details__airbyte_raw_id_idx').on(table.airbyteRawId),
  })
)

export const bannerMessages = pgTable('banner_messages', {
  id: text('id').notNull(),
  message: text('message'),
  success: boolean('success'),
  type: text('type').notNull(),
  isActive: boolean('is_active').notNull(),
})

/**
 * Arena agent department catalog (value stored on chat.department; label for display).
 * Table is managed outside Drizzle migrations — keep schema aligned with the live table.
 */
export const agentDepartments = pgTable('agent_departments', {
  id: text('id').primaryKey(),
  value: text('value').notNull().unique(),
  label: text('label').notNull(),
  sortOrder: integer('sort_order').notNull().default(0),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
})

export const workflowStatsDaily = pgTable(
  'workflow_stats_daily',
  {
    id: text('id').primaryKey(),
    workflowId: text('workflow_id_ref'),
    workflowName: text('workflow_name'),
    workflowAuthorId: text('workflow_author_id'),
    workflowAuthorUserName: text('workflow_author_name'),
    category: text('category'),
    executionCount: integer('execution_count').notNull().default(0),
    executionDate: date('execution_date').notNull(),
    executionUserName: text('executor_name'),
    executionUserId: text('executor_user_id'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (table) => ({
    workflowIdIdx: index('workflow_stats_daily_workflow_id_idx').on(table.workflowId),
    workflowAuthorIdIdx: index('workflow_stats_daily_workflow_author_id_idx').on(
      table.workflowAuthorId
    ),
  })
)

export const workflowStatsMonthly = pgTable(
  'workflow_stats_monthly',
  {
    id: text('id').primaryKey(),
    workflowId: text('workflow_id_ref'),
    workflowName: text('workflow_name'),
    workflowAuthorId: text('workflow_author_id'),
    workflowAuthorUserName: text('workflow_author_name'),
    category: text('category'),
    executionCount: integer('execution_count').notNull().default(0),
    executionMonth: integer('execution_month').notNull(),
    executionUserName: text('executor_name'),
    executionUserId: text('executor_user_id'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (table) => ({
    workflowIdIdx: index('workflow_stats_monthly_workflow_id_idx').on(table.workflowId),
    workflowAuthorIdIdx: index('workflow_stats_monthly_workflow_author_id_idx').on(
      table.workflowAuthorId
    ),
  })
)

export const slackSummary = pgTable(
  'slack_summary',
  {
    id: text('id').primaryKey(),
    clientIdRef: text('client_id_ref').notNull(),
    clientName: text('client_name').notNull(),
    channelIdRef: text('channel_id_ref').notNull(),
    channelName: text('channel_name').notNull(),
    channelType: text('channel_type').notNull(),
    type: text('type'),
    oneDaySummary: text('one_day_summary'),
    sevenDaySummary: text('seven_day_summary'),
    fourteenDaySummary: text('fourteen_day_summary'),
    createdDate: timestamp('created_date').notNull().defaultNow(),
    updatedDate: timestamp('updated_date').notNull().defaultNow(),
    startTime: timestamp('start_time'),
    endTime: timestamp('end_time'),
    status: text('status').notNull(),
    retryCount: integer('retry_count').notNull().default(0),
    runDate: date('run_date').notNull(),
  },
  (table) => ({
    clientIdRefIdx: index('slack_summary_client_id_ref_idx').on(table.clientIdRef),
    channelIdRefIdx: index('slack_summary_channel_id_ref_idx').on(table.channelIdRef),
    statusIdx: index('slack_summary_status_idx').on(table.status),
    runDateIdx: index('slack_summary_run_date_idx').on(table.runDate),
    clientChannelIdx: index('slack_summary_client_channel_idx').on(
      table.clientIdRef,
      table.channelIdRef
    ),
  })
)

export const gmailClientSummary = pgTable(
  'gmail_client_summary',
  {
    id: text('id').primaryKey(),
    runDate: date('run_date').notNull(),
    status: text('status').notNull(),
    runStartTime: timestamp('run_start_time'),
    runEndTime: timestamp('run_end_time'),
    clientId: text('client_id'),
    clientName: text('client_name'),
    clientDomain: text('client_domain'),
    type: text('type'),
    oneDaySummary: text('one_day_summary'),
    sevenDaySummary: text('seven_day_summary'),
  },
  (table) => ({
    clientIdIdx: index('gmail_client_summary_client_id_idx').on(table.clientId),
    statusIdx: index('gmail_client_summary_status_idx').on(table.status),
    runDateIdx: index('gmail_client_summary_run_date_idx').on(table.runDate),
  })
)

export const meetingSummary = pgTable(
  'meeting_summary',
  {
    id: text('id').primaryKey(),
    clientIdRef: text('client_id_ref').notNull(),
    clientName: text('client_name').notNull(),
    meetingType: text('meeting_type'),
    type: text('type'),
    oneDaySummary: text('one_day_summary'),
    sevenDaySummary: text('seven_day_summary'),
    fourteenDaySummary: text('fourteen_day_summary'),
    createdDate: timestamp('created_date').notNull().defaultNow(),
    updatedDate: timestamp('updated_date').notNull().defaultNow(),
    startTime: timestamp('start_time'),
    endTime: timestamp('end_time'),
    status: text('status').notNull(),
    retryCount: integer('retry_count').notNull().default(0),
    runDate: date('run_date').notNull(),
  },
  (table) => ({
    clientIdRefIdx: index('meeting_summary_client_id_ref_idx').on(table.clientIdRef),
    statusIdx: index('meeting_summary_status_idx').on(table.status),
    runDateIdx: index('meeting_summary_run_date_idx').on(table.runDate),
  })
)

export const overallClientSummary = pgTable(
  'overall_client_summary',
  {
    id: text('id').primaryKey(),
    clientIdRef: text('client_id_ref').notNull(),
    clientName: text('client_name').notNull(),
    type: text('type'),
    oneDaySummary: text('one_day_summary'),
    sevenDaySummary: text('seven_day_summary'),
    fourteenDaySummary: text('fourteen_day_summary'),
    dailySummaryChanges: text('daily_summary_changes'),
    weeklySentiment: text('weekly_sentiment'),
    createdDate: timestamp('created_date').notNull().defaultNow(),
    updatedDate: timestamp('updated_date').notNull().defaultNow(),
    startTime: timestamp('start_time'),
    endTime: timestamp('end_time'),
    status: text('status').notNull(),
    retryCount: integer('retry_count').notNull().default(0),
    runDate: date('run_date').notNull(),
  },
  (table) => ({
    clientIdRefIdx: index('overall_client_summary_client_id_ref_idx').on(table.clientIdRef),
    statusIdx: index('overall_client_summary_status_idx').on(table.status),
    runDateIdx: index('overall_client_summary_run_date_idx').on(table.runDate),
  })
)

export const arenaTaskSummary = pgTable(
  'arena_task_summary',
  {
    id: text('id').primaryKey(),
    clientIdRef: text('client_id_ref').notNull(),
    clientName: text('client_name').notNull(),
    type: text('type'),
    oneDaySummary: text('one_day_summary'),
    sevenDaySummary: text('seven_day_summary'),
    fourteenDaySummary: text('fourteen_day_summary'),
    createdDate: timestamp('created_date').notNull().defaultNow(),
    updatedDate: timestamp('updated_date').notNull().defaultNow(),
    startTime: timestamp('start_time'),
    endTime: timestamp('end_time'),
    status: text('status').notNull(),
    retryCount: integer('retry_count').notNull().default(0),
    runDate: date('run_date').notNull(),
  },
  (table) => ({
    clientIdRefIdx: index('arena_task_summary_client_id_ref_idx').on(table.clientIdRef),
    statusIdx: index('arena_task_summary_status_idx').on(table.status),
    runDateIdx: index('arena_task_summary_run_date_idx').on(table.runDate),
  })
)

export const clientChannelMapping = pgTable(
  'client_channel_mapping',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clientId: text('client_id').notNull(),
    channelId: text('channel_id').notNull(),
    channelName: text('channel_name').notNull(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (table) => ({
    clientIdIdx: index('client_channel_mapping_client_id_idx').on(table.clientId),
    channelIdIdx: index('client_channel_mapping_channel_id_idx').on(table.channelId),
  })
)

export const clientDetails = pgTable(
  'client_details',
  {
    id: text('id').primaryKey(),
    clientId: text('client_id').notNull(),
    clientName: text('client_name'),
    gmailDomain: text('gmail_domain'),
    clientCustomerId: text('client_customer_id'),
    clientManager: text('client_manager'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (table) => ({
    clientIdIdx: index('client_details_client_id_idx').on(table.clientId),
  })
)

export const promptConfig = pgTable(
  'prompt_config',
  {
    id: text('id').primaryKey(),
    key: varchar('key', { length: 256 }).notNull().unique(),
    prompt: text('prompt').notNull(),
    createdAt: timestamp('created_at').notNull().defaultNow(),
    updatedAt: timestamp('updated_at').notNull().defaultNow(),
  },
  (table) => ({
    keyIdx: uniqueIndex('prompt_config_key_idx').on(table.key),
  })
)

export const masterConfig = pgTable('master_config', {
  id: text('id').primaryKey(),
  key: varchar('key', { length: 256 }).notNull().unique(),
  value: text('value').notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  updatedAt: timestamp('updated_at').notNull().defaultNow(),
})

export const channelAccounts = pgTable(
  'channel_accounts',
  {
    accountId: varchar('account_id', { length: 100 }).notNull(),
    accountName: varchar('account_name', { length: 255 }).notNull(),
    accountType: varchar('account_type', { length: 50 }).notNull(),
  },
  (table) => ({
    pk: uniqueIndex('channel_accounts_pkey').on(table.accountId, table.accountType),
  })
)

/**
 * The application code that read/wrote this table (Academy) was removed in
 * the same PR that would have dropped it here — deferred to a follow-up PR
 * once that removal has actually shipped, per the expand/contract migration
 * safety check (`check:migrations`), since a same-deploy drop would break
 * any pod still running the old code during a rolling deploy.
 */
export const academyCertStatusEnum = pgEnum('academy_cert_status', ['active', 'revoked', 'expired'])

/** Partner certification records issued on course completion */
export const academyCertificate = pgTable(
  'academy_certificate',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    /** References the file-based course ID from lib/academy/content */
    courseId: text('course_id').notNull(),
    status: academyCertStatusEnum('status').notNull().default('active'),
    issuedAt: timestamp('issued_at').notNull().defaultNow(),
    /** Optional expiry for recertification requirements */
    expiresAt: timestamp('expires_at'),
    /** Human-readable unique certificate number, e.g. SIM-2026-00042 */
    certificateNumber: text('certificate_number').notNull().unique(),
    /** Snapshot of name and other metadata at time of issue */
    metadata: jsonb('metadata'),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => ({
    userIdIdx: index('academy_certificate_user_id_idx').on(table.userId),
    courseIdIdx: index('academy_certificate_course_id_idx').on(table.courseId),
    userCourseUnique: uniqueIndex('academy_certificate_user_course_unique').on(
      table.userId,
      table.courseId
    ),
    statusIdx: index('academy_certificate_status_idx').on(table.status),
  })
)

export const outreachUserConnectionsV1 = pgTable('outreach_user_connections_v1', {
  id: varchar('id').primaryKey(),
  userIdRef: varchar('user_id_ref', { length: 64 }).notNull(),
  platformId: text('platform_id').notNull(),
  platformType: varchar('platform_type', { length: 64 }).notNull(),
  isConnected: boolean('is_connected').notNull().default(true),
  isShown: boolean('is_shown').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }),
  name: text('name'),
  accountId: varchar('account_id'),
  userEmail: varchar('user_email'),
  userPersona: text('user_persona'),
  fileName: varchar('file_name'),
  defaultPersona: text('default_persona'),
  timeZone: varchar('time_zone'),
  synced: boolean('synced').notNull().default(false),
})

export const helpSupportIssueTypeEnum = pgEnum('help_support_issue_type', [
  'bug',
  'feedback',
  'feature_request',
  'other',
])

export type HelpSupportIssueAttachment = {
  filename: string
  content_type: string
  file_url: string
  storage_key: string
}

export const helpSupportIssue = pgTable(
  'help_support_issue',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    userEmail: text('user_email').notNull(),
    workspaceId: text('workspace_id').references(() => workspace.id, { onDelete: 'set null' }),
    workflowId: text('workflow_id').references(() => workflow.id, { onDelete: 'set null' }),
    type: helpSupportIssueTypeEnum('type').notNull(),
    subject: text('subject').notNull(),
    message: text('message').notNull(),
    attachments: jsonb('attachments')
      .$type<HelpSupportIssueAttachment[]>()
      .notNull()
      .default(sql`'[]'::jsonb`),
    createdAt: timestamp('created_at').notNull().defaultNow(),
  },
  (table) => ({
    userIdIdx: index('help_support_issue_user_id_idx').on(table.userId),
    workspaceIdIdx: index('help_support_issue_workspace_id_idx').on(table.workspaceId),
    workflowIdIdx: index('help_support_issue_workflow_id_idx').on(table.workflowId),
    typeIdx: index('help_support_issue_type_idx').on(table.type),
    createdAtIdx: index('help_support_issue_created_at_idx').on(table.createdAt),
  })
)

/**
 * Maps an external client id (from Arena / partner systems) to a Sim organization.
 * One client → one org; used by the admin ensure-member provisioning API.
 */
export const clientOrganization = pgTable(
  'client_organization',
  {
    id: text('id').primaryKey(),
    clientId: text('client_id').notNull(),
    clientName: text('client_name').notNull(),
    organizationId: text('organization_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at').defaultNow().notNull(),
    updatedAt: timestamp('updated_at').defaultNow().notNull(),
  },
  (table) => ({
    clientIdUnique: uniqueIndex('client_organization_client_id_unique').on(table.clientId),
    organizationIdUnique: uniqueIndex('client_organization_organization_id_unique').on(
      table.organizationId
    ),
  })
)
