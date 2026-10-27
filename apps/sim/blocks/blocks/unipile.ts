import { UnipileIcon } from '@/components/icons'
import type { BlockConfig } from '@/blocks/types'
import { AuthMode, IntegrationType } from '@/blocks/types'
import { normalizeFileInput } from '@/blocks/utils'
import { UNIPILE_LINKEDIN_PROFILE_SECTIONS } from '@/tools/unipile/linkedin_profile_query'
import { buildLinkedinSearchBodyFromForm } from '@/tools/unipile/linkedin_search_form'
import { getLinkedinSearchParameterTypeDropdownOptions } from '@/tools/unipile/linkedin_search_parameter_types'

/** Normalizes attendees to a de-duplicated string array for Unipile `attendees_ids`. */
const UNIPILE_COMMENT_MENTION_COL_NAME = 'Display name'
const UNIPILE_COMMENT_MENTION_COL_PROFILE_ID = 'Profile ID'
const UNIPILE_COMMENT_MENTION_COL_IS_COMPANY = 'Is company'

function unipileParseMentionIsCompanyCell(raw: string): boolean | undefined {
  const s = raw.trim().toLowerCase()
  if (s === '') return undefined
  if (['yes', 'true', '1', 'y', 'company'].includes(s)) return true
  if (['no', 'false', '0', 'n'].includes(s)) return false
  return undefined
}

type UnipileCommentMentionRow = { name: string; profile_id: string; is_company?: boolean }

/** Credential id or legacy raw Unipile account id from block params (resolved at execution). */
function unipileAccountIdFromParams(params: Record<string, unknown>): string {
  const cred =
    typeof params.unipileCredential === 'string'
      ? params.unipileCredential.trim()
      : typeof params.credential === 'string'
        ? params.credential.trim()
        : typeof params.oauthCredential === 'string'
          ? params.oauthCredential.trim()
          : ''
  const legacy = typeof params.account_id === 'string' ? params.account_id.trim() : ''
  return cred || legacy
}

/** Same row shape as Start block `input-format` fields (id, name, type, value, description). */
function unipileMentionsFromInputFormat(raw: unknown): UnipileCommentMentionRow[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const out: UnipileCommentMentionRow[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const f = item as {
      name?: string
      value?: string
      description?: string
    }
    const displayName = (f.name ?? '').trim()
    const profileId = (f.value ?? '').trim()
    if (!displayName || !profileId) continue
    const row: UnipileCommentMentionRow = { name: displayName, profile_id: profileId }
    const desc = (f.description ?? '').trim().toLowerCase()
    if (desc === 'true' || desc === 'yes' || desc === 'company') row.is_company = true
    if (desc === 'false' || desc === 'no') row.is_company = false
    out.push(row)
  }
  return out.length > 0 ? out : undefined
}

/** Input-format rows: `name` holds the Unipile section enum; order preserved, duplicates dropped. */
function unipileLinkedinSectionsFromInputFormat(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const allowed = new Set<string>(UNIPILE_LINKEDIN_PROFILE_SECTIONS as readonly string[])
  const out: string[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue
    const id =
      typeof (item as { name?: string }).name === 'string'
        ? (item as { name: string }).name.trim()
        : ''
    if (!id || !allowed.has(id) || seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out.length > 0 ? out : undefined
}

function unipileMentionsFromTable(raw: unknown): UnipileCommentMentionRow[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const out: UnipileCommentMentionRow[] = []
  for (const row of raw) {
    if (!row || typeof row !== 'object' || !('cells' in row)) continue
    const cells = (row as { cells?: Record<string, string> }).cells
    if (!cells || typeof cells !== 'object') continue
    const name = (cells[UNIPILE_COMMENT_MENTION_COL_NAME] ?? '').trim()
    const profileId = (cells[UNIPILE_COMMENT_MENTION_COL_PROFILE_ID] ?? '').trim()
    if (!name || !profileId) continue
    const entry: UnipileCommentMentionRow = { name, profile_id: profileId }
    const ic = unipileParseMentionIsCompanyCell(cells[UNIPILE_COMMENT_MENTION_COL_IS_COMPANY] ?? '')
    if (ic === true) entry.is_company = true
    if (ic === false) entry.is_company = false
    out.push(entry)
  }
  return out.length > 0 ? out : undefined
}

/**
 * Resolves outbound `text` from split sub-blocks (preferred) or legacy `text` for older saved
 * workflows.
 */
function pickUnipileBodyText(params: Record<string, unknown>, operation: string): string {
  const s = (key: string) => (typeof params[key] === 'string' ? (params[key] as string).trim() : '')
  const legacy = s('text')
  if (operation === 'comment_post') {
    return s('comment_post_text') || legacy
  }
  if (operation === 'create_post') {
    return s('create_post_text') || legacy
  }
  if (operation === 'start_new_chat' || operation === 'send_chat_message') {
    return s('chat_message_text') || legacy
  }
  return legacy
}

/** Legacy JSON / single fields / mention table → mentions JSON string for POST comment. */
function unipileBuildCommentMentionsJson(params: Record<string, unknown>): string | undefined {
  const raw = params.comment_mentions_json
  if (typeof raw === 'string' && raw.trim() !== '') {
    return raw.trim()
  }
  const fromInputFormat = unipileMentionsFromInputFormat(params.comment_mentions_input)
  if (fromInputFormat) {
    return JSON.stringify(fromInputFormat)
  }
  const fromTable = unipileMentionsFromTable(params.comment_mentions_table)
  if (fromTable) {
    return JSON.stringify(fromTable)
  }
  const name =
    typeof params.comment_mention_display_name === 'string'
      ? params.comment_mention_display_name.trim()
      : ''
  const profileId =
    typeof params.comment_mention_profile_id === 'string'
      ? params.comment_mention_profile_id.trim()
      : ''
  if (name && profileId) {
    const entry: Record<string, unknown> = { name, profile_id: profileId }
    const ic = params.comment_mention_is_company
    if (ic === 'true') entry.is_company = true
    if (ic === 'false') entry.is_company = false
    return JSON.stringify([entry])
  }
  return undefined
}

function unipileNormalizeAttendeesIds(raw: unknown): string[] | undefined {
  if (Array.isArray(raw) && raw.length > 0) {
    const parts = raw
      .filter((x): x is string => typeof x === 'string' && x.trim() !== '')
      .map((x) => x.trim())
    if (parts.length === 0) return undefined
    return Array.from(new Set(parts))
  }
  if (typeof raw === 'string' && raw.trim() !== '') {
    const parts = raw
      .split(',')
      .map((x) => x.trim())
      .filter((x) => x.length > 0)
    if (parts.length === 0) return undefined
    return Array.from(new Set(parts))
  }
  return undefined
}

export const UnipileBlock: BlockConfig = {
  type: 'unipile',
  name: 'LinkedIn (Unipile)',
  description: 'LinkedIn company data and messaging via Unipile',
  docsLink: 'https://developer.unipile.com/reference/',
  authMode: AuthMode.OAuth,
  longDescription:
    'Shared workspaces list public LinkedIn accounts from `outreach_user_connections_v1` plus your personal connections via Unipile hosted authentication (`GET /api/unipile/accounts`). Other workspaces connect LinkedIn via hosted authentication only. Uses `UNIPILE_API_KEY` from the deployment environment. Covers LinkedIn company and user profiles, posts, comments, reactions, search, messaging, relations, and attachments.',
  category: 'tools',
  integrationType: IntegrationType.Communication,
  bgColor: '#0F2736',
  icon: UnipileIcon,
  subBlocks: [
    {
      id: 'credential',
      title: 'LinkedIn Account',
      type: 'oauth-input',
      serviceId: 'unipile_linkedin',
      canonicalParamId: 'unipileCredential',
      mode: 'basic',
      placeholder: 'Connect or select LinkedIn account',
      required: true,
      description:
        'Shared workspaces include public LinkedIn accounts plus your personal connections. Connect or reconnect through Unipile hosted authentication.',
    },
    {
      id: 'manualCredential',
      title: 'LinkedIn Account',
      type: 'short-input',
      canonicalParamId: 'unipileCredential',
      mode: 'advanced',
      placeholder: 'Credential ID or Unipile account id',
      required: true,
    },
    {
      id: 'operation',
      title: 'Operation',
      type: 'dropdown',
      options: [
        { label: 'Comment on a post', id: 'comment_post' },
        { label: 'Create Post', id: 'create_post' },
        { label: 'Retrieve a chat', id: 'get_chat' },
        { label: 'Get Message Attachment', id: 'get_message_attachment' },
        { label: 'Retrieve search parameters', id: 'get_linkedin_search_parameters' },
        { label: 'Get Post', id: 'get_post' },
        { label: 'Retrieve a profile', id: 'get_user_profile' },
        { label: 'List Chat Attendees', id: 'list_chat_attendees' },
        { label: 'List Chat Messages', id: 'list_chat_messages' },
        { label: 'List all chats', id: 'list_all_chats' },
        { label: 'Perform search', id: 'linkedin_search' },
        { label: 'List Post Comments', id: 'list_post_comments' },
        { label: 'List all reactions from a post', id: 'list_post_reactions' },
        { label: 'List User Comments', id: 'list_user_comments' },
        { label: 'List all posts', id: 'list_user_posts' },
        { label: 'List User Reactions', id: 'list_user_reactions' },
        { label: 'List User Relations', id: 'list_user_relations' },
        { label: 'Retrieve Company Profile', id: 'retrieve_company_details' },
        { label: 'Send Chat Message', id: 'send_chat_message' },
        { label: 'Start New Chat', id: 'start_new_chat' },
      ],
      value: () => 'retrieve_company_details',
    },
    {
      id: 'identifier',
      title: 'Company Identifier',
      type: 'short-input',
      placeholder: 'LinkedIn company public id (e.g. position2)',
      dependsOn: ['operation'],
      condition: { field: 'operation', value: 'retrieve_company_details' },
      required: { field: 'operation', value: 'retrieve_company_details' },
    },
    {
      id: 'user_identifier',
      title: 'User identifier',
      type: 'short-input',
      placeholder: 'Public slug or provider internal id (path segment)',
      description:
        'Unipile path `{identifier}` for this user. For **Retrieve a profile** only: internal id or public id. Reused for **List all posts**, list comments, and list reactions (provider id or public id per Unipile docs).',
      dependsOn: ['operation'],
      condition: {
        field: 'operation',
        value: ['get_user_profile', 'list_user_posts', 'list_user_comments', 'list_user_reactions'],
      },
      required: {
        field: 'operation',
        value: ['get_user_profile', 'list_user_posts', 'list_user_comments', 'list_user_reactions'],
      },
    },
    {
      id: 'linkedin_profile_sections_input',
      title: 'LinkedIn profile sections',
      type: 'input-format',
      inputFormatVariant: 'linkedin_profile_sections',
      inputFormatConfig: {
        title: 'Section',
        fieldNameLabel: 'Profile section',
        fieldNamePlaceholder: 'section',
        profileSectionPlaceholder: 'Select a section…',
      },
      description:
        'Optional `linkedin_sections` query: use **+** to add rows; pick each section from the list. Prefer preview or specific sections—full “all sections” is heavy and LinkedIn may throttle (see response `throttled_sections`). [Provider limits](https://developer.unipile.com/docs/provider-limits-and-restrictions)',
      dependsOn: ['operation'],
      condition: { field: 'operation', value: 'get_user_profile' },
      mode: 'advanced',
    },
    {
      id: 'linkedin_profile_api',
      title: 'LinkedIn API surface',
      type: 'dropdown',
      options: [
        { label: 'Classic)', id: '' },
        { label: 'Recruiter', id: 'recruiter' },
        { label: 'Sales Navigator', id: 'sales_navigator' },
      ],
      value: () => '',
      description:
        'Optional `linkedin_api` query when the account has Recruiter or Sales Navigator (relative features must be subscribed).',
      dependsOn: ['operation'],
      condition: { field: 'operation', value: 'get_user_profile' },
      mode: 'advanced',
    },
    {
      id: 'linkedin_profile_notify',
      title: 'Notify profile visit',
      type: 'dropdown',
      options: [
        { label: 'Default (false)', id: '' },
        { label: 'true', id: 'true' },
        { label: 'false', id: 'false' },
      ],
      value: () => '',
      description:
        'Optional `notify` query: whether LinkedIn notifies the person that their profile was viewed (default upstream is false).',
      dependsOn: ['operation'],
      condition: { field: 'operation', value: 'get_user_profile' },
      mode: 'advanced',
    },
    {
      id: 'list_cursor',
      title: 'Pagination Cursor',
      type: 'short-input',
      placeholder: 'Cursor from a previous list response',
      condition: {
        field: 'operation',
        value: [
          'list_user_posts',
          'list_user_comments',
          'list_user_reactions',
          'list_post_comments',
          'list_all_chats',
          'linkedin_search',
        ],
      },
      dependsOn: ['operation'],
      mode: 'advanced',
    },
    {
      id: 'list_user_posts_limit',
      title: 'Page size (limit)',
      type: 'short-input',
      placeholder: '1–100',
      description: 'Optional `limit` query on **List all posts** (1–100 posts per request).',
      dependsOn: ['operation'],
      condition: { field: 'operation', value: 'list_user_posts' },
      mode: 'advanced',
    },
    {
      id: 'list_user_posts_is_company',
      title: 'Company posts (LinkedIn)',
      type: 'dropdown',
      options: [
        { label: 'Default (omit)', id: '' },
        { label: 'true (company page)', id: 'true' },
        { label: 'false', id: 'false' },
      ],
      value: () => '',
      description:
        'Optional `is_company` query: set **true** when the identifier is a LinkedIn company (numeric id).',
      dependsOn: ['operation'],
      condition: { field: 'operation', value: 'list_user_posts' },
      mode: 'advanced',
    },
    {
      id: 'relations_filter',
      title: 'Relations name filter',
      type: 'short-input',
      placeholder: 'Optional: filter relations by user name',
      dependsOn: ['operation'],
      condition: { field: 'operation', value: 'list_user_relations' },
      mode: 'advanced',
    },
    {
      id: 'linkedin_search_param_type',
      title: 'Parameter type',
      type: 'dropdown',
      options: () => getLinkedinSearchParameterTypeDropdownOptions(),
      value: () => 'PEOPLE',
      description:
        'Required Unipile `type` query: which ID list to return. LinkedIn search bodies use these IDs—not raw text. Guide: https://developer.unipile.com/docs/linkedin-search',
      dependsOn: ['operation'],
      condition: { field: 'operation', value: 'get_linkedin_search_parameters' },
      required: { field: 'operation', value: 'get_linkedin_search_parameters' },
    },
    {
      id: 'linkedin_search_param_service',
      title: 'LinkedIn API surface',
      type: 'dropdown',
      options: [
        { label: 'Classic', id: 'CLASSIC' },
        { label: 'Recruiter', id: 'RECRUITER' },
        { label: 'Sales Navigator', id: 'SALES_NAVIGATOR' },
      ],
      value: () => 'CLASSIC',
      description:
        'Unipile `service` query (default CLASSIC). Affects which parameter sets are available for common types.',
      dependsOn: ['operation'],
      condition: { field: 'operation', value: 'get_linkedin_search_parameters' },
    },
    {
      id: 'linkedin_search_param_keywords',
      title: 'Keywords (optional)',
      type: 'short-input',
      placeholder: 'Seed keywords (not used when type is EMPLOYMENT_TYPE)',
      description:
        'Optional Unipile `keywords` query. Not applicable when parameter type is EMPLOYMENT_TYPE.',
      dependsOn: ['operation'],
      condition: { field: 'operation', value: 'get_linkedin_search_parameters' },
      mode: 'advanced',
    },
    {
      id: 'linkedin_search_param_limit',
      title: 'Result limit',
      type: 'short-input',
      placeholder: '1–100',
      description: 'Optional Unipile `limit` query (1–100 per response page).',
      dependsOn: ['operation'],
      condition: { field: 'operation', value: 'get_linkedin_search_parameters' },
      mode: 'advanced',
    },
    {
      id: 'message_id',
      title: 'Message ID',
      type: 'short-input',
      placeholder: 'Message id',
      dependsOn: ['operation'],
      condition: { field: 'operation', value: 'get_message_attachment' },
      required: { field: 'operation', value: 'get_message_attachment' },
    },
    {
      id: 'attachment_id',
      title: 'Attachment ID',
      type: 'short-input',
      placeholder: 'Attachment id',
      dependsOn: ['operation'],
      condition: { field: 'operation', value: 'get_message_attachment' },
      required: { field: 'operation', value: 'get_message_attachment' },
    },
    {
      id: 'post_id',
      title: 'Post ID',
      type: 'short-input',
      placeholder: 'Post id',
      description:
        'Path `post_id`. LinkedIn: prefer **`social_id`** from GET post / list posts (e.g. `urn:li:activity:…`). Bare activity digits from the URL are normalized to that URN for comments/reactions. **`ugcPost` / `share`** posts: use `urn:li:ugcPost:…` / `urn:li:share:…` or the post URL so the slug can be parsed. Instagram: **provider_id** for list comments/reactions (shortcode not supported). [List comments](https://developer.unipile.com/reference/postscontroller_listallcomments) · [Guide](https://developer.unipile.com/docs/posts-and-comments)',
      dependsOn: ['operation'],
      condition: {
        field: 'operation',
        value: ['get_post', 'list_post_comments', 'comment_post', 'list_post_reactions'],
      },
      required: {
        field: 'operation',
        value: ['get_post', 'list_post_comments', 'comment_post', 'list_post_reactions'],
      },
    },
    {
      id: 'reactions_comment_id',
      title: 'Comment ID (reactions)',
      type: 'short-input',
      placeholder: 'Optional: reactions on this comment (LinkedIn: id from comments list)',
      dependsOn: ['operation'],
      condition: { field: 'operation', value: 'list_post_reactions' },
      mode: 'advanced',
    },
    {
      id: 'reactions_limit',
      title: 'Reactions page size',
      type: 'short-input',
      placeholder: '1–100 per upstream page (default 100); all pages are still fetched',
      dependsOn: ['operation'],
      condition: { field: 'operation', value: 'list_post_reactions' },
      mode: 'advanced',
    },
    {
      id: 'post_comments_thread_comment_id',
      title: 'Comment ID (replies)',
      type: 'short-input',
      placeholder: 'Optional: list replies for this comment (LinkedIn: id from comments list)',
      description: 'Unipile `comment_id` query: omit to list top-level comments on the post.',
      dependsOn: ['operation'],
      condition: { field: 'operation', value: 'list_post_comments' },
      mode: 'advanced',
    },
    {
      id: 'post_comments_limit',
      title: 'Comments page size',
      type: 'short-input',
      placeholder: '1–100 (optional)',
      description: 'Unipile `limit` query for this request page.',
      dependsOn: ['operation'],
      condition: { field: 'operation', value: 'list_post_comments' },
      mode: 'advanced',
    },
    {
      id: 'post_comments_sort',
      title: 'Sort comments by',
      type: 'dropdown',
      options: [
        { label: 'Default (upstream)', id: '' },
        { label: 'Most recent', id: 'MOST_RECENT' },
        { label: 'Most relevant', id: 'MOST_RELEVANT' },
      ],
      value: () => '',
      description: 'Unipile `sort_by` query when set (default upstream is MOST_RECENT).',
      dependsOn: ['operation'],
      condition: { field: 'operation', value: 'list_post_comments' },
      mode: 'advanced',
    },
    {
      id: 'chat_id',
      title: 'Chat ID',
      type: 'short-input',
      placeholder: 'Chat id (e.g. from list chats)',
      dependsOn: ['operation'],
      condition: {
        field: 'operation',
        value: ['get_chat', 'list_chat_messages', 'send_chat_message', 'list_chat_attendees'],
      },
      required: {
        field: 'operation',
        value: ['get_chat', 'list_chat_messages', 'send_chat_message', 'list_chat_attendees'],
      },
    },
    {
      id: 'list_chats_account_ids_csv',
      title: 'Account IDs (optional override)',
      type: 'short-input',
      placeholder: 'Comma-separated Unipile account ids (overrides picker if set)',
      description:
        'Optional `account_id` query: one id or comma-separated list. If empty, uses the Unipile Account picker (admin) or connected LinkedIn account (OAuth).',
      dependsOn: ['operation'],
      condition: { field: 'operation', value: 'list_all_chats' },
      mode: 'advanced',
    },
    {
      id: 'chats_unread_filter',
      title: 'Unread filter',
      type: 'dropdown',
      options: [
        { label: 'All chats', id: '' },
        { label: 'Unread only', id: 'unread' },
        { label: 'Read only', id: 'read' },
      ],
      value: () => '',
      description: 'Maps to Unipile `unread` query (boolean).',
      dependsOn: ['operation'],
      condition: { field: 'operation', value: 'list_all_chats' },
    },
    {
      id: 'chats_account_type_filter',
      title: 'Account type filter',
      type: 'dropdown',
      options: [
        { label: 'Any', id: '' },
        { label: 'WhatsApp', id: 'WHATSAPP' },
        { label: 'LinkedIn', id: 'LINKEDIN' },
        { label: 'Slack', id: 'SLACK' },
        { label: 'Twitter', id: 'TWITTER' },
        { label: 'Messenger', id: 'MESSENGER' },
        { label: 'Instagram', id: 'INSTAGRAM' },
        { label: 'Telegram', id: 'TELEGRAM' },
      ],
      value: () => '',
      description: 'Optional Unipile `account_type` query.',
      dependsOn: ['operation'],
      condition: { field: 'operation', value: 'list_all_chats' },
      mode: 'advanced',
    },
    {
      id: 'chats_before_iso',
      title: 'Created before (ISO UTC)',
      type: 'short-input',
      placeholder: '2025-12-31T23:59:59.999Z',
      description: 'Exclusive upper bound; must match …T… .sssZ (milliseconds + Z).',
      dependsOn: ['operation'],
      condition: { field: 'operation', value: 'list_all_chats' },
      mode: 'advanced',
    },
    {
      id: 'chats_after_iso',
      title: 'Created after (ISO UTC)',
      type: 'short-input',
      placeholder: '2025-01-01T00:00:00.000Z',
      description: 'Exclusive lower bound; same ISO 8601 UTC format as Unipile docs.',
      dependsOn: ['operation'],
      condition: { field: 'operation', value: 'list_all_chats' },
      mode: 'advanced',
    },
    {
      id: 'chats_list_limit',
      title: 'Page limit',
      type: 'short-input',
      placeholder: '1–250',
      dependsOn: ['operation'],
      condition: { field: 'operation', value: 'list_all_chats' },
      mode: 'advanced',
    },
    {
      id: 'start_chat_api_mode',
      title: 'LinkedIn chat API',
      type: 'dropdown',
      options: [
        { label: 'Classic', id: 'classic' },
        { label: 'Recruiter', id: 'recruiter' },
        { label: 'Sales Navigator', id: 'sales_navigator' },
      ],
      value: () => 'classic',
      description: 'Mode for start new chat',
      dependsOn: ['operation'],
      condition: { field: 'operation', value: 'start_new_chat' },
    },
    {
      id: 'attendees_ids',
      title: 'Attendees (CSV)',
      type: 'long-input',
      rows: 3,
      placeholder: 'Comma-separated relation / member ids',
      description:
        'Required for starting a chat: one id per comma-separated value; spaces around commas are trimmed. Legacy multi-select values are still accepted as arrays.',
      dependsOn: ['operation'],
      condition: { field: 'operation', value: 'start_new_chat' },
      required: { field: 'operation', value: 'start_new_chat' },
    },
    {
      id: 'chat_message_text',
      title: 'Message',
      type: 'long-input',
      placeholder: 'Type the chat message…',
      description:
        'Used for **Start new chat** and **Send chat message**. Tag references supported.',
      dependsOn: ['operation'],
      condition: { field: 'operation', value: ['start_new_chat', 'send_chat_message'] },
      required: { field: 'operation', value: ['start_new_chat', 'send_chat_message'] },
    },
    {
      id: 'create_post_text',
      title: 'Post text',
      type: 'long-input',
      placeholder:
        'Post text. You can add a mention by inserting the index of the corresponding entry from the mentions array between two double braces. Example: Hey {{0}}, check this out !',
      description:
        'Used for **Create a post**. LinkedIn: `{{n}}` matches the nth mention row below (same idea as Unipile’s “Hey {{0}}, …”).',
      dependsOn: ['operation'],
      condition: { field: 'operation', value: 'create_post' },
      required: { field: 'operation', value: 'create_post' },
    },
    {
      id: 'comment_post_text',
      title: 'Comment text',
      type: 'long-input',
      placeholder:
        'Comment (max 1250). You can add a mention by inserting the index of the corresponding entry from the mentions array between two double braces. Example: Hey {{0}}, check this out !',
      description:
        'Used for **Comment a post**. LinkedIn: `{{n}}` matches the nth mention row below (same idea as Unipile’s “Hey {{0}}, …”).',
      dependsOn: ['operation'],
      condition: { field: 'operation', value: 'comment_post' },
      required: { field: 'operation', value: 'comment_post' },
    },
    {
      id: 'comment_mentions_input',
      title: 'LinkedIn mentions',
      type: 'input-format',
      inputFormatVariant: 'linkedin_comment_mentions',
      inputFormatConfig: {
        title: 'Mention',
        fieldNameLabel: 'Display name',
        fieldNamePlaceholder: 'How the name appears in the comment',
        fieldValueLabel: 'Profile ID',
        fieldValuePlaceholder: 'Provider id (ACo…, ADo…, or company numeric id)',
        mentionTargetLabel: 'Mention target',
        mentionTargetPlaceholder: 'Person or company',
        mentionTargetOptions: [
          { label: 'Person', value: '' },
          { label: 'Company', value: 'true' },
        ],
      },
      description:
        'Optional LinkedIn @mentions: use **+** to add more. **Display name** is how the mention appears in the post/comment; **Profile ID** is the provider id (ACo…/ADo… for people, numeric id for companies). **Mention target**: Person or Company. **You must** put `{{0}}`, `{{1}}`, … in the comment/post text in the same row order — Unipile substitutes those from the `mentions` array ([reference](https://developer.unipile.com/reference/postscontroller_sendcomment)). Rows with empty name or profile id are ignored.',
      dependsOn: ['operation'],
      condition: { field: 'operation', value: ['comment_post', 'create_post'] },
    },
    {
      id: 'linkedin_search_api',
      title: 'API',
      type: 'dropdown',
      options: [
        { label: 'classic', id: 'classic' },
        { label: 'sales_navigator', id: 'sales_navigator' },
        { label: 'recruiter', id: 'recruiter' },
      ],
      value: () => 'classic',
      description:
        'Request body `api`. Multi-value filter rows apply to **classic**; `sales_navigator` / `recruiter` send `api`, `category`, and `keywords` only unless you use **Search from LinkedIn URL**. [Guide](https://developer.unipile.com/docs/linkedin-search)',
      dependsOn: ['operation'],
      condition: { field: 'operation', value: 'linkedin_search' },
    },
    {
      id: 'linkedin_search_category',
      title: 'Category',
      type: 'dropdown',
      options: [
        { label: 'people', id: 'people' },
        { label: 'companies', id: 'companies' },
        { label: 'posts', id: 'posts' },
        { label: 'jobs', id: 'jobs' },
      ],
      value: () => 'people',
      description:
        'Request body `category` (match to `api` per Unipile: e.g. Classic people / companies / posts / jobs).',
      dependsOn: ['operation'],
      condition: { field: 'operation', value: 'linkedin_search' },
    },
    {
      id: 'linkedin_search_keywords',
      title: 'Keywords',
      type: 'long-input',
      placeholder:
        'e.g. engineer (optional for some Classic searches; required for Recruiter in many cases)',
      description: 'Search keywords (`keywords` in the POST body).',
      dependsOn: ['operation'],
      condition: { field: 'operation', value: 'linkedin_search' },
    },
    {
      id: 'linkedin_search_public_url',
      title: 'Search from LinkedIn URL (optional)',
      type: 'long-input',
      placeholder: 'https://www.linkedin.com/search/…',
      description:
        'If set, the body is only `{ "url": "…" }` and overrides other fields below (paste a public LinkedIn search URL).',
      dependsOn: ['operation'],
      condition: { field: 'operation', value: 'linkedin_search' },
    },
    {
      id: 'linkedin_search_filters_input',
      title: 'Search filters (Classic)',
      type: 'input-format',
      inputFormatVariant: 'linkedin_search_filters',
      inputFormatConfig: {
        title: 'Filter',
        fieldNameLabel: 'Filter',
        fieldNamePlaceholder: 'filter',
        fieldValueLabel: 'ID or value',
        fieldValuePlaceholder: 'IDs from Retrieve LinkedIn search parameters',
        searchFilterPlaceholder: 'Select a filter type…',
      },
      description:
        '**+** to add rows: pick a **filter** (industry, location, …) and the **id or value** from [Retrieve LinkedIn search parameters](https://developer.unipile.com/docs/linkedin-search). Multiple rows for the same filter become an array. **network_distance**: `1`, `2`, or `3`. **open_to**: `proBono` or `boardMember`. **has_job_offers**: `true` or `false` (companies). Ignored when **API** is not `classic`.',
      dependsOn: ['operation'],
      condition: { field: 'operation', value: 'linkedin_search' },
    },
    {
      id: 'linkedin_search_page_limit',
      title: 'Result limit',
      type: 'short-input',
      placeholder: '10 (default upstream); max 100; Classic ≤50',
      description:
        'Optional query `limit` (0–100). Sales Navigator / Recruiter allow up to 100; LinkedIn Classic should stay at or below 50.',
      dependsOn: ['operation'],
      condition: { field: 'operation', value: 'linkedin_search' },
      mode: 'advanced',
    },
    {
      id: 'linkedin_post_video_thumbnail_file',
      title: 'Video Thumbnail',
      type: 'file-upload',
      canonicalParamId: 'video_thumbnail',
      placeholder: 'Upload video thumbnail image',
      dependsOn: ['operation'],
      condition: { field: 'operation', value: 'create_post' },
      mode: 'basic',
    },
    {
      id: 'linkedin_post_video_thumbnail',
      title: 'Video Thumbnail',
      type: 'short-input',
      canonicalParamId: 'video_thumbnail',
      placeholder: 'video_thumbnail form field',
      dependsOn: ['operation'],
      condition: { field: 'operation', value: 'create_post' },
      mode: 'advanced',
    },
    {
      id: 'linkedin_post_repost',
      title: 'Repost',
      type: 'short-input',
      placeholder: 'repost form field',
      dependsOn: ['operation'],
      condition: { field: 'operation', value: 'create_post' },
      mode: 'advanced',
    },
    {
      id: 'linkedin_post_include_job_posting',
      title: 'Include Job Posting',
      type: 'short-input',
      placeholder: 'include_job_posting form field',
      dependsOn: ['operation'],
      condition: { field: 'operation', value: 'create_post' },
      mode: 'advanced',
    },
    {
      id: 'linkedin_post_external_link',
      title: 'External Link',
      type: 'short-input',
      placeholder: 'https://… (must start with http:// or https://)',
      description:
        'LinkedIn only: URL for link preview; include the same URL in the post/comment text (or Unipile may append it).',
      dependsOn: ['operation'],
      condition: { field: 'operation', value: ['create_post', 'comment_post'] },
      mode: 'advanced',
    },
    {
      id: 'linkedin_post_as_organization',
      title: 'As Organization',
      type: 'short-input',
      placeholder: 'Organization id (comment or post on its behalf)',
      description: 'LinkedIn only: id of an organization you control.',
      dependsOn: ['operation'],
      condition: { field: 'operation', value: ['create_post', 'comment_post'] },
      mode: 'advanced',
    },
    {
      id: 'linkedin_comment_parent_id',
      title: 'Comment ID (reply)',
      type: 'short-input',
      placeholder: 'Parent comment id to reply to',
      description:
        'Optional `comment_id` in the API body. LinkedIn: use the comment id returned by the comments list.',
      dependsOn: ['operation'],
      condition: { field: 'operation', value: 'comment_post' },
      mode: 'advanced',
    },
    {
      id: 'thread_id',
      title: 'Thread ID',
      type: 'short-input',
      placeholder: 'Optional thread id',
      dependsOn: ['operation'],
      condition: { field: 'operation', value: 'send_chat_message' },
      mode: 'advanced',
    },
    {
      id: 'quote_id',
      title: 'Quote ID',
      type: 'short-input',
      placeholder: 'Optional quote id',
      dependsOn: ['operation'],
      condition: { field: 'operation', value: 'send_chat_message' },
      mode: 'advanced',
    },
    {
      id: 'typing_duration',
      title: 'Typing Duration',
      type: 'short-input',
      placeholder: 'Optional typing duration (form string)',
      dependsOn: ['operation'],
      condition: { field: 'operation', value: 'send_chat_message' },
      mode: 'advanced',
    },
    {
      id: 'subject',
      title: 'Subject',
      type: 'short-input',
      placeholder: 'Optional chat subject',
      dependsOn: ['operation'],
      condition: { field: 'operation', value: 'start_new_chat' },
      mode: 'advanced',
    },
    {
      id: 'attachment_files',
      title: 'Attachments',
      type: 'file-upload',
      canonicalParamId: 'attachments',
      placeholder: 'Upload one or more files',
      multiple: true,
      dependsOn: ['operation'],
      condition: {
        field: 'operation',
        value: ['start_new_chat', 'send_chat_message', 'create_post', 'comment_post'],
      },
      mode: 'both',
    },
    // {
    //   id: 'voice_message_file',
    //   title: 'Voice Message',
    //   type: 'file-upload',
    //   placeholder: 'Upload voice message file (.m4a/.mp3)',
    //   dependsOn: ['operation'],
    //   condition: { field: 'operation', value: 'start_new_chat' },
    //   mode: 'basic',
    // },
    // {
    //   id: 'video_message_file',
    //   title: 'Video Message',
    //   type: 'file-upload',
    //   placeholder: 'Upload video message file',
    //   dependsOn: ['operation'],
    //   condition: { field: 'operation', value: 'start_new_chat' },
    //   mode: 'basic',
    // },

    // {
    //   id: 'voice_message',
    //   title: 'Voice Message',
    //   type: 'short-input',
    //   placeholder: 'Voice message field (string)',
    //   dependsOn: ['operation'],
    //   condition: { field: 'operation', value: 'start_new_chat' },
    //   mode: 'advanced',
    // },
    // {
    //   id: 'video_message',
    //   title: 'Video Message',
    //   type: 'short-input',
    //   placeholder: 'Video message field (string)',
    //   dependsOn: ['operation'],
    //   condition: { field: 'operation', value: 'start_new_chat' },
    //   mode: 'advanced',
    // },
    {
      id: 'chat_topic',
      title: 'Topic',
      type: 'dropdown',
      options: [
        { label: 'Omit', id: '' },
        { label: 'Service request', id: 'service_request' },
        { label: 'Request demo', id: 'request_demo' },
        { label: 'Support', id: 'support' },
        { label: 'Careers', id: 'careers' },
        { label: 'Other', id: 'other' },
      ],
      value: () => '',
      dependsOn: ['operation'],
      condition: {
        field: 'operation',
        value: 'start_new_chat',
        and: { field: 'start_chat_api_mode', value: 'classic' },
      },
      mode: 'advanced',
    },
    {
      id: 'applicant_id',
      title: 'Applicant ID',
      type: 'short-input',
      placeholder: 'Optional applicant id',
      dependsOn: ['operation'],
      condition: {
        field: 'operation',
        value: 'start_new_chat',
        and: { field: 'start_chat_api_mode', value: 'classic' },
      },
      mode: 'advanced',
    },
    {
      id: 'invitation_id',
      title: 'Invitation ID',
      type: 'short-input',
      placeholder: 'Optional invitation id',
      dependsOn: ['operation'],
      condition: {
        field: 'operation',
        value: 'start_new_chat',
        and: { field: 'start_chat_api_mode', value: 'classic' },
      },
      mode: 'advanced',
    },
    {
      id: 'inmail',
      title: 'InMail',
      type: 'dropdown',
      options: [
        { label: 'Omit', id: '' },
        { label: 'True', id: 'true' },
        { label: 'False', id: 'false' },
      ],
      value: () => '',
      dependsOn: ['operation'],
      condition: {
        field: 'operation',
        value: 'start_new_chat',
        and: { field: 'start_chat_api_mode', value: 'classic' },
      },
      mode: 'advanced',
    },
    {
      id: 'recruiter_signature',
      title: 'Signature',
      type: 'short-input',
      placeholder: 'Recruiter signature',
      dependsOn: ['operation'],
      condition: {
        field: 'operation',
        value: 'start_new_chat',
        and: { field: 'start_chat_api_mode', value: 'recruiter' },
      },
      mode: 'advanced',
    },
    {
      id: 'recruiter_hiring_project_id',
      title: 'Hiring project ID',
      type: 'short-input',
      placeholder: 'hiring_project_id',
      dependsOn: ['operation'],
      condition: {
        field: 'operation',
        value: 'start_new_chat',
        and: { field: 'start_chat_api_mode', value: 'recruiter' },
      },
      mode: 'advanced',
    },
    {
      id: 'recruiter_job_posting_id',
      title: 'Job posting ID',
      type: 'short-input',
      placeholder: 'job_posting_id',
      dependsOn: ['operation'],
      condition: {
        field: 'operation',
        value: 'start_new_chat',
        and: { field: 'start_chat_api_mode', value: 'recruiter' },
      },
      mode: 'advanced',
    },
    {
      id: 'recruiter_sourcing_channel',
      title: 'Sourcing channel',
      type: 'dropdown',
      options: [
        { label: 'Omit', id: '' },
        { label: 'Job posting recommended matches', id: 'JOB_POSTING_RECOMMENDED_MATCHES' },
        { label: 'Job posting', id: 'JOB_POSTING' },
        { label: 'Referral', id: 'REFERRAL' },
        { label: 'Internal candidates', id: 'INTERNAL_CANDIDATES' },
        { label: 'Automated sourcing', id: 'AUTOMATED_SOURCING' },
        { label: 'Recruiter search', id: 'RECRUITER_SEARCH' },
        { label: 'Career site', id: 'CAREER_SITE' },
      ],
      value: () => '',
      dependsOn: ['operation'],
      condition: {
        field: 'operation',
        value: 'start_new_chat',
        and: { field: 'start_chat_api_mode', value: 'recruiter' },
      },
      mode: 'advanced',
    },
    {
      id: 'recruiter_email_address',
      title: 'Email address',
      type: 'short-input',
      placeholder: 'Recruiter email_address',
      dependsOn: ['operation'],
      condition: {
        field: 'operation',
        value: 'start_new_chat',
        and: { field: 'start_chat_api_mode', value: 'recruiter' },
      },
      mode: 'advanced',
    },
    {
      id: 'recruiter_visibility',
      title: 'Visibility',
      type: 'dropdown',
      options: [
        { label: 'Omit', id: '' },
        { label: 'Public', id: 'PUBLIC' },
        { label: 'Private', id: 'PRIVATE' },
        { label: 'Project', id: 'PROJECT' },
      ],
      value: () => '',
      dependsOn: ['operation'],
      condition: {
        field: 'operation',
        value: 'start_new_chat',
        and: { field: 'start_chat_api_mode', value: 'recruiter' },
      },
    },
  ],
  tools: {
    access: [
      'unipile_comment_post',
      'unipile_create_post',
      'unipile_get_chat',
      'unipile_get_linkedin_search_parameters',
      'unipile_get_message_attachment',
      'unipile_get_post',
      'unipile_get_user_profile',
      'unipile_linkedin_search',
      'unipile_list_all_chats',
      'unipile_list_chat_attendees',
      'unipile_list_chat_messages',
      'unipile_list_post_comments',
      'unipile_list_post_reactions',
      'unipile_list_user_comments',
      'unipile_list_user_posts',
      'unipile_list_user_reactions',
      'unipile_list_user_relations',
      'unipile_retrieve_company_details',
      'unipile_send_chat_message',
      'unipile_start_new_chat',
    ],
    config: {
      tool: (params) => `unipile_${params.operation}`,
      params: (params) => {
        const op = params.operation as string
        if (op === 'get_user_profile') {
          const out: Record<string, unknown> = {
            account_id: unipileAccountIdFromParams(params),
            user_identifier:
              typeof params.user_identifier === 'string' ? params.user_identifier.trim() : '',
          }
          const fromRows = unipileLinkedinSectionsFromInputFormat(
            params.linkedin_profile_sections_input
          )
          if (fromRows) {
            out.linkedin_sections_json = JSON.stringify(fromRows)
          } else {
            const sec = params.linkedin_profile_sections_json
            if (typeof sec === 'string' && sec.trim() !== '') {
              out.linkedin_sections_json = sec.trim()
            }
          }
          const api = params.linkedin_profile_api
          if (api === 'recruiter' || api === 'sales_navigator') {
            out.linkedin_api = api
          }
          const notify = params.linkedin_profile_notify
          if (notify === 'true') {
            out.notify = true
          } else if (notify === 'false') {
            out.notify = false
          }
          return out
        }
        if (
          op === 'list_user_posts' ||
          op === 'list_user_comments' ||
          op === 'list_user_reactions'
        ) {
          const out: Record<string, unknown> = {
            account_id: unipileAccountIdFromParams(params),
            user_identifier:
              typeof params.user_identifier === 'string' ? params.user_identifier.trim() : '',
          }
          if (typeof params.list_cursor === 'string' && params.list_cursor.trim() !== '') {
            out.cursor = params.list_cursor.trim()
          }
          if (op === 'list_user_posts') {
            const limitRaw = params.list_user_posts_limit
            if (typeof limitRaw === 'string' && limitRaw.trim() !== '') {
              const n = Number.parseInt(limitRaw.trim(), 10)
              if (!Number.isNaN(n) && n >= 1 && n <= 100) {
                out.limit = n
              }
            }
            const isCo = params.list_user_posts_is_company
            if (isCo === 'true') {
              out.is_company = true
            } else if (isCo === 'false') {
              out.is_company = false
            }
          }
          return out
        }
        if (op === 'list_all_chats') {
          const out: Record<string, unknown> = {}
          const csv =
            typeof params.list_chats_account_ids_csv === 'string'
              ? params.list_chats_account_ids_csv.trim()
              : ''
          const picker = unipileAccountIdFromParams(params)
          if (csv) {
            out.account_id = csv
          } else if (picker) {
            out.account_id = picker
          }
          if (typeof params.list_cursor === 'string' && params.list_cursor.trim() !== '') {
            out.cursor = params.list_cursor.trim()
          }
          const unread = params.chats_unread_filter
          if (unread === 'unread') {
            out.unread = true
          } else if (unread === 'read') {
            out.unread = false
          }
          if (
            typeof params.chats_before_iso === 'string' &&
            params.chats_before_iso.trim() !== ''
          ) {
            out.before = params.chats_before_iso.trim()
          }
          if (typeof params.chats_after_iso === 'string' && params.chats_after_iso.trim() !== '') {
            out.after = params.chats_after_iso.trim()
          }
          const limRaw = params.chats_list_limit
          if (typeof limRaw === 'string' && limRaw.trim() !== '') {
            const n = Number.parseInt(limRaw.trim(), 10)
            if (Number.isFinite(n)) {
              out.limit = n
            }
          } else if (typeof limRaw === 'number' && Number.isFinite(limRaw)) {
            out.limit = Math.trunc(limRaw)
          }
          if (
            typeof params.chats_account_type_filter === 'string' &&
            params.chats_account_type_filter.trim() !== ''
          ) {
            out.account_type = params.chats_account_type_filter.trim()
          }
          return out
        }
        if (op === 'list_chat_attendees') {
          return {
            chat_id: typeof params.chat_id === 'string' ? params.chat_id.trim() : '',
          }
        }
        if (op === 'list_post_comments') {
          const out: Record<string, unknown> = {
            post_id: typeof params.post_id === 'string' ? params.post_id.trim() : '',
            account_id: unipileAccountIdFromParams(params),
          }
          if (typeof params.list_cursor === 'string' && params.list_cursor.trim() !== '') {
            out.cursor = params.list_cursor.trim()
          }
          const limRaw = params.post_comments_limit
          if (typeof limRaw === 'string' && limRaw.trim() !== '') {
            const n = Number.parseInt(limRaw.trim(), 10)
            if (Number.isFinite(n)) {
              out.limit = n
            }
          } else if (typeof limRaw === 'number' && Number.isFinite(limRaw)) {
            out.limit = Math.trunc(limRaw)
          }
          if (
            typeof params.post_comments_sort === 'string' &&
            (params.post_comments_sort === 'MOST_RECENT' ||
              params.post_comments_sort === 'MOST_RELEVANT')
          ) {
            out.sort_by = params.post_comments_sort
          }
          if (
            typeof params.post_comments_thread_comment_id === 'string' &&
            params.post_comments_thread_comment_id.trim() !== ''
          ) {
            out.comment_id = params.post_comments_thread_comment_id.trim()
          }
          return out
        }
        if (op === 'list_post_reactions') {
          const out: Record<string, unknown> = {
            post_id: typeof params.post_id === 'string' ? params.post_id.trim() : '',
            account_id: unipileAccountIdFromParams(params),
          }
          if (
            typeof params.reactions_comment_id === 'string' &&
            params.reactions_comment_id.trim() !== ''
          ) {
            out.comment_id = params.reactions_comment_id.trim()
          }
          const limRaw = params.reactions_limit
          if (typeof limRaw === 'string' && limRaw.trim() !== '') {
            const n = Number.parseInt(limRaw.trim(), 10)
            if (Number.isFinite(n)) {
              out.limit = n
            }
          } else if (typeof limRaw === 'number' && Number.isFinite(limRaw)) {
            out.limit = Math.trunc(limRaw)
          }
          return out
        }
        if (op === 'get_linkedin_search_parameters') {
          const out: Record<string, unknown> = {
            account_id: unipileAccountIdFromParams(params),
            type:
              typeof params.linkedin_search_param_type === 'string' &&
              params.linkedin_search_param_type.trim() !== ''
                ? params.linkedin_search_param_type.trim()
                : 'PEOPLE',
          }
          const svc = params.linkedin_search_param_service
          if (typeof svc === 'string' && svc.trim() !== '') {
            out.service = svc.trim()
          }
          const kw = params.linkedin_search_param_keywords
          if (typeof kw === 'string' && kw.trim() !== '') {
            out.keywords = kw.trim()
          }
          const limRaw = params.linkedin_search_param_limit
          if (typeof limRaw === 'string' && limRaw.trim() !== '') {
            const n = Number.parseInt(limRaw.trim(), 10)
            if (Number.isFinite(n)) {
              out.limit = n
            }
          } else if (typeof limRaw === 'number' && Number.isFinite(limRaw)) {
            out.limit = Math.trunc(limRaw)
          }
          return out
        }
        if (op === 'list_user_relations') {
          const out: Record<string, unknown> = {
            account_id: unipileAccountIdFromParams(params),
          }
          if (
            typeof params.relations_filter === 'string' &&
            params.relations_filter.trim() !== ''
          ) {
            out.filter = params.relations_filter.trim()
          }
          return out
        }
        if (op === 'linkedin_search') {
          const out: Record<string, unknown> = {
            account_id: unipileAccountIdFromParams(params),
            search_body: JSON.stringify(
              buildLinkedinSearchBodyFromForm(params as Record<string, unknown>)
            ),
          }
          if (typeof params.list_cursor === 'string' && params.list_cursor.trim() !== '') {
            out.cursor = params.list_cursor.trim()
          }
          const limRaw = params.linkedin_search_page_limit
          if (typeof limRaw === 'string' && limRaw.trim() !== '') {
            const n = Number.parseInt(limRaw.trim(), 10)
            if (Number.isFinite(n)) out.limit = n
          } else if (typeof limRaw === 'number' && Number.isFinite(limRaw)) {
            out.limit = Math.trunc(limRaw)
          }
          return out
        }
        if (op === 'comment_post') {
          const out: Record<string, unknown> = {
            post_id: typeof params.post_id === 'string' ? params.post_id.trim() : '',
            account_id: unipileAccountIdFromParams(params),
            text: pickUnipileBodyText(params as Record<string, unknown>, op),
          }
          const copyIfString = (fromKey: string, toKey: string) => {
            const v = params[fromKey]
            if (typeof v === 'string' && v.trim() !== '') {
              out[toKey] = v.trim()
            }
          }
          const normalizedCommentAttachments = normalizeFileInput(
            params.attachment_files || params.attachments
          )
          if (normalizedCommentAttachments && normalizedCommentAttachments.length > 0) {
            out.attachments = normalizedCommentAttachments
          } else {
            copyIfString('attachments', 'attachments')
          }
          copyIfString('linkedin_post_external_link', 'external_link')
          copyIfString('linkedin_post_as_organization', 'as_organization')
          copyIfString('linkedin_comment_parent_id', 'comment_id')
          const mentions = unipileBuildCommentMentionsJson(params as Record<string, unknown>)
          if (mentions) {
            out.mentions = mentions
          }
          return out
        }
        if (op === 'create_post') {
          const out: Record<string, unknown> = {
            account_id: unipileAccountIdFromParams(params),
            text: pickUnipileBodyText(params as Record<string, unknown>, op),
          }
          const normalizedAttachments = normalizeFileInput(
            params.attachment_files || params.attachments
          )
          const normalizedVideoThumbnail = normalizeFileInput(
            params.linkedin_post_video_thumbnail_file || params.linkedin_post_video_thumbnail,
            { single: true }
          )
          const copyIfString = (fromKey: string, toKey: string) => {
            const v = params[fromKey]
            if (typeof v === 'string' && v.trim() !== '') {
              out[toKey] = v.trim()
            }
          }
          if (normalizedAttachments && normalizedAttachments.length > 0) {
            out.attachments = normalizedAttachments
          } else {
            copyIfString('attachments', 'attachments')
          }
          if (normalizedVideoThumbnail) {
            out.video_thumbnail = normalizedVideoThumbnail
          } else {
            copyIfString('linkedin_post_video_thumbnail', 'video_thumbnail')
          }
          copyIfString('linkedin_post_repost', 'repost')
          copyIfString('linkedin_post_include_job_posting', 'include_job_posting')
          copyIfString('linkedin_post_external_link', 'external_link')
          copyIfString('linkedin_post_as_organization', 'as_organization')
          const mentions = unipileBuildCommentMentionsJson(params as Record<string, unknown>)
          if (mentions) {
            out.mentions = mentions
          }
          return out
        }
        if (op === 'send_chat_message') {
          const out: Record<string, unknown> = {
            chat_id: typeof params.chat_id === 'string' ? params.chat_id.trim() : '',
            account_id: unipileAccountIdFromParams(params),
            text: pickUnipileBodyText(params as Record<string, unknown>, op),
          }
          const normalizedAttachments = normalizeFileInput(
            params.attachment_files || params.attachments
          )
          const copyIfString = (key: string) => {
            const v = params[key]
            if (typeof v === 'string' && v.trim() !== '') {
              out[key] = v.trim()
            }
          }
          copyIfString('thread_id')
          copyIfString('quote_id')
          if (normalizedAttachments && normalizedAttachments.length > 0) {
            out.attachments = normalizedAttachments
          } else {
            copyIfString('attachments')
          }
          copyIfString('typing_duration')
          return out
        }
        if (op === 'start_new_chat') {
          const out: Record<string, unknown> = {
            account_id: unipileAccountIdFromParams(params),
            text: pickUnipileBodyText(params as Record<string, unknown>, op),
          }
          const normalizedAttachments = normalizeFileInput(
            params.attachment_files || params.attachments
          )
          const normalizedVoice = normalizeFileInput(
            params.voice_message_file || params.voice_message,
            {
              single: true,
            }
          )
          const normalizedVideo = normalizeFileInput(
            params.video_message_file || params.video_message,
            {
              single: true,
            }
          )
          const copyIfString = (key: string) => {
            const v = params[key]
            if (typeof v === 'string' && v.trim() !== '') {
              out[key] = v.trim()
            }
          }
          copyIfString('subject')
          if (normalizedAttachments && normalizedAttachments.length > 0) {
            out.attachments = normalizedAttachments
          } else {
            copyIfString('attachments')
          }
          if (normalizedVoice) {
            out.voice_message = normalizedVoice
          } else {
            copyIfString('voice_message')
          }
          if (normalizedVideo) {
            out.video_message = normalizedVideo
          } else {
            copyIfString('video_message')
          }
          out.attendees_ids = unipileNormalizeAttendeesIds(params.attendees_ids) ?? []

          const modeRaw =
            typeof params.start_chat_api_mode === 'string' &&
            params.start_chat_api_mode.trim() !== ''
              ? params.start_chat_api_mode.trim()
              : typeof params.chat_api === 'string' && params.chat_api.trim() !== ''
                ? params.chat_api.trim()
                : 'classic'
          out.api = modeRaw

          if (modeRaw === 'classic') {
            if (typeof params.chat_topic === 'string' && params.chat_topic.trim() !== '') {
              out.topic = params.chat_topic.trim()
            }
            copyIfString('applicant_id')
            copyIfString('invitation_id')
            if (params.inmail === 'true' || params.inmail === 'false') {
              out.inmail = params.inmail
            }
          }

          if (modeRaw === 'recruiter') {
            const copyTo = (fromKey: string, toKey: string) => {
              const v = params[fromKey]
              if (typeof v === 'string' && v.trim() !== '') {
                out[toKey] = v.trim()
              }
            }
            copyTo('recruiter_signature', 'signature')
            copyTo('recruiter_hiring_project_id', 'hiring_project_id')
            copyTo('recruiter_job_posting_id', 'job_posting_id')
            copyTo('recruiter_sourcing_channel', 'sourcing_channel')
            copyTo('recruiter_email_address', 'email_address')
            copyTo('recruiter_visibility', 'visibility')
            const follow = params.recruiter_follow_up_json
            if (typeof follow === 'string' && follow.trim() !== '') {
              out.follow_up = follow.trim()
            }
          }

          return out
        }
        if (op === 'retrieve_company_details') {
          return {
            identifier: typeof params.identifier === 'string' ? params.identifier.trim() : '',
            account_id: unipileAccountIdFromParams(params),
          }
        }
        if (op === 'get_post') {
          return {
            post_id: typeof params.post_id === 'string' ? params.post_id.trim() : '',
            account_id: unipileAccountIdFromParams(params),
          }
        }
        return {}
      },
    },
  },
  inputs: {
    operation: { type: 'string', description: 'Operation to perform' },
    identifier: {
      type: 'string',
      description: 'LinkedIn company public identifier for /linkedin/company/{identifier}',
    },
    user_identifier: {
      type: 'string',
      description:
        'User path id: for Retrieve a profile, provider internal or public id; for List all posts / list comments/reactions, path segment',
    },
    linkedin_profile_sections_input: {
      type: 'json',
      description:
        'Retrieve a profile: optional rows of LinkedIn section enums → sent as Unipile `linkedin_sections` (see provider limits)',
    },
    linkedin_profile_sections_json: {
      type: 'string',
      description:
        'Retrieve a profile: legacy JSON array string for linkedin_sections if present in saved workflow (prefer LinkedIn profile sections rows)',
    },
    linkedin_profile_api: {
      type: 'string',
      description: 'Retrieve a profile: optional linkedin_api recruiter | sales_navigator',
    },
    linkedin_profile_notify: {
      type: 'string',
      description: 'Retrieve a profile: optional notify true | false (default upstream false)',
    },
    relations_filter: {
      type: 'string',
      description: 'List user relations: optional name filter',
    },
    list_cursor: {
      type: 'string',
      description:
        'Pagination cursor (List all posts, list comments/reactions, list all chats, Perform Linkedin search)',
    },
    list_user_posts_limit: {
      type: 'string',
      description: 'List all posts: optional limit query 1–100',
    },
    list_user_posts_is_company: {
      type: 'string',
      description: 'List all posts: optional is_company true | false (LinkedIn company pages)',
    },
    message_id: { type: 'string', description: 'Message id' },
    attachment_id: { type: 'string', description: 'Attachment id' },
    post_id: {
      type: 'string',
      description: 'Post id path param; LinkedIn social_id from GET post / list posts',
    },
    reactions_comment_id: {
      type: 'string',
      description:
        'List post reactions: optional comment_id to list reactions on that comment (LinkedIn: id from comments list)',
    },
    post_comments_thread_comment_id: {
      type: 'string',
      description:
        'List post comments: optional comment_id to list replies for that comment (LinkedIn: id from comments list)',
    },
    post_comments_limit: {
      type: 'string',
      description: 'List post comments: optional limit 1–100 for the request page',
    },
    post_comments_sort: {
      type: 'string',
      description: 'List post comments: optional sort_by MOST_RECENT | MOST_RELEVANT',
    },
    reactions_limit: {
      type: 'string',
      description:
        'List post reactions: optional 1–100 page size per upstream request (default 100); server still loads every page',
    },
    chat_id: { type: 'string', description: 'Chat id' },
    list_chats_account_ids_csv: {
      type: 'string',
      description: 'List all chats: optional comma-separated account_id query (overrides picker)',
    },
    chats_unread_filter: {
      type: 'string',
      description: 'List all chats: unread | read | empty for Unipile unread query',
    },
    chats_account_type_filter: {
      type: 'string',
      description: 'List all chats: optional WHATSAPP, LINKEDIN, … account_type filter',
    },
    chats_before_iso: { type: 'string', description: 'List all chats: optional before ISO UTC' },
    chats_after_iso: { type: 'string', description: 'List all chats: optional after ISO UTC' },
    chats_list_limit: { type: 'string', description: 'List all chats: optional limit 1–250' },
    account_id: {
      type: 'string',
      description: 'Unipile connected account id (from LinkedIn account credential)',
    },
    chat_message_text: {
      type: 'string',
      description: 'Start new chat / Send chat message: message body',
    },
    create_post_text: { type: 'string', description: 'Create a post: post body text' },
    comment_post_text: { type: 'string', description: 'Comment a post: comment body (max 1250)' },
    text: { type: 'string', description: 'Legacy combined message/post field (migration)' },
    linkedin_search_param_type: {
      type: 'string',
      description:
        'Retrieve LinkedIn search parameters: required Unipile type enum (e.g. PEOPLE, LOCATION)',
    },
    linkedin_search_param_service: {
      type: 'string',
      description: 'Retrieve LinkedIn search parameters: CLASSIC | RECRUITER | SALES_NAVIGATOR',
    },
    linkedin_search_param_keywords: {
      type: 'string',
      description:
        'Retrieve LinkedIn search parameters: optional keywords (not for EMPLOYMENT_TYPE)',
    },
    linkedin_search_param_limit: {
      type: 'string',
      description: 'Retrieve LinkedIn search parameters: optional limit 1–100 as string or number',
    },
    linkedin_search_api: {
      type: 'string',
      description: 'Perform Linkedin search: api field',
    },
    linkedin_search_category: {
      type: 'string',
      description: 'Perform Linkedin search: category field',
    },
    linkedin_search_keywords: {
      type: 'string',
      description: 'Perform Linkedin search: keywords',
    },
    linkedin_search_public_url: {
      type: 'string',
      description: 'Perform Linkedin search: optional public search URL → body { url }',
    },
    linkedin_search_filters_input: {
      type: 'json',
      description:
        'Perform Linkedin search: Classic filter rows (filter type + id/value); merged into POST body arrays',
    },
    linkedin_search_page_limit: {
      type: 'string',
      description: 'Perform Linkedin search: optional limit query 0–100 (Classic ≤50 recommended)',
    },
    linkedin_comment_parent_id: {
      type: 'string',
      description:
        'Comment a post: optional parent comment_id (reply); LinkedIn id from comments list',
    },
    comment_mentions_input: {
      type: 'json',
      description:
        'Comment a post: dynamic mention rows (Start-style input-format → name, profile_id, is_company)',
    },
    comment_mentions_json: {
      type: 'string',
      description:
        'Legacy only: JSON mentions array if present in saved workflow state (normally use LinkedIn mentions table)',
    },
    linkedin_post_video_thumbnail: { type: 'string', description: 'Create post video_thumbnail' },
    linkedin_post_video_thumbnail_file: {
      type: 'json',
      description: 'Create post: uploaded video thumbnail file (UserFile)',
    },
    linkedin_post_repost: { type: 'string', description: 'Create post repost' },
    linkedin_post_include_job_posting: {
      type: 'string',
      description: 'Create post include_job_posting',
    },
    linkedin_post_external_link: { type: 'string', description: 'Create post external_link' },
    linkedin_post_as_organization: { type: 'string', description: 'Create post as_organization' },
    thread_id: { type: 'string', description: 'Thread id for send message' },
    quote_id: { type: 'string', description: 'Quote id for send message' },
    typing_duration: { type: 'string', description: 'Typing duration form field' },
    attachment_files: {
      type: 'json',
      description:
        'Uploaded files (UserFile array) for start chat, send message, create post, or comment post — proxied as multipart `attachments` parts to Unipile',
    },
    // voice_message_file: {
    //   type: 'json',
    //   description: 'Start new chat: uploaded voice message file (UserFile)',
    // },
    // video_message_file: {
    //   type: 'json',
    //   description: 'Start new chat: uploaded video message file (UserFile)',
    // },
    subject: { type: 'string', description: 'Chat subject' },
    attachments: {
      type: 'json',
      description: 'Legacy/advanced attachment reference; prefer **Attachments** file upload above',
    },
    // voice_message: { type: 'string', description: 'Start new chat: voice message form field' },
    // video_message: { type: 'string', description: 'Start new chat: video message form field' },
    attendees_ids: {
      type: 'json',
      description:
        'Start new chat (required): attendee ids as string array (legacy comma-separated string is still accepted)',
    },
    start_chat_api_mode: {
      type: 'string',
      description: 'Start new chat: classic | recruiter | sales_navigator',
    },
    chat_topic: {
      type: 'string',
      description: 'Classic API: topic (service_request, request_demo, support, careers, other)',
    },
    applicant_id: { type: 'string', description: 'Classic API: applicant_id' },
    invitation_id: { type: 'string', description: 'Classic API: invitation_id' },
    inmail: { type: 'string', description: 'Classic API: inmail true/false' },
    recruiter_signature: { type: 'string', description: 'Recruiter API: signature' },
    recruiter_hiring_project_id: {
      type: 'string',
      description: 'Recruiter API: hiring_project_id',
    },
    recruiter_job_posting_id: { type: 'string', description: 'Recruiter API: job_posting_id' },
    recruiter_sourcing_channel: { type: 'string', description: 'Recruiter API: sourcing_channel' },
    recruiter_email_address: { type: 'string', description: 'Recruiter API: email_address' },
    recruiter_visibility: {
      type: 'string',
      description: 'Recruiter API: PUBLIC | PRIVATE | PROJECT',
    },
    recruiter_follow_up_json: {
      type: 'string',
      description: 'Recruiter API: JSON for follow_up { subject, text, scheduled_time }',
    },
  },
  outputs: {
    object: { type: 'string', description: 'Unipile object discriminator' },
    id: { type: 'string', description: 'Resource id (company, chat, post, etc.)' },
    name: { type: 'string', description: 'Display name when applicable' },
    description: { type: 'string', description: 'Company description (profile operation)' },
    public_identifier: { type: 'string', description: 'LinkedIn public identifier' },
    profile_url: { type: 'string', description: 'LinkedIn profile URL (company)' },
    followers_count: { type: 'number', description: 'Followers count (company)' },
    employee_count: { type: 'number', description: 'Employee count (company)' },
    website: { type: 'string', description: 'Company website' },
    logo: { type: 'string', description: 'Logo URL' },
    profile: { type: 'json', description: 'Full company or user profile payload' },
    provider: { type: 'string', description: 'Provider (user profile)' },
    first_name: { type: 'string', description: 'First name (user profile)' },
    last_name: { type: 'string', description: 'Last name (user profile)' },
    headline: { type: 'string', description: 'Headline (user profile)' },
    public_profile_url: { type: 'string', description: 'Public profile URL (Retrieve a profile)' },
    throttled_sections: {
      type: 'json',
      description: 'LinkedIn section names omitted/throttled on profile fetch (Retrieve a profile)',
    },
    account_type: { type: 'string', description: 'Chat account type (get chat)' },
    provider_id: { type: 'string', description: 'Provider id (get chat)' },
    subject: {
      type: 'string',
      description: 'Subject when returned by get chat or set when starting a chat',
    },
    timestamp: { type: 'string', description: 'Chat timestamp (get chat)' },
    unread_count: { type: 'number', description: 'Unread count (get chat)' },
    content_type: { type: 'string', description: 'Chat content type (get chat)' },
    last_message_text: { type: 'string', description: 'Last message text preview (get chat)' },
    chat: { type: 'json', description: 'Full chat payload (get chat)' },
    item_count: { type: 'number', description: 'List item count' },
    items: { type: 'json', description: 'List items payload' },
    cursor: { type: 'string', description: 'Pagination cursor' },
    paging: { type: 'json', description: 'Paging metadata' },
    total_items: { type: 'number', description: 'Total items when API returns total_items' },
    config: { type: 'json', description: 'LinkedIn search echoed config when present' },
    metadata: { type: 'json', description: 'LinkedIn search metadata when present' },
    content: { type: 'string', description: 'Attachment text body when applicable' },
    content_base64: { type: 'string', description: 'Attachment base64 when binary' },
    mime_type: { type: 'string', description: 'Attachment MIME type' },
    share_url: { type: 'string', description: 'Post share URL' },
    text: { type: 'string', description: 'Post or message text snippet' },
    post: { type: 'json', description: 'Full post payload (get post)' },
    chat_id: { type: 'string', description: 'Chat id (start new chat)' },
    message_id: { type: 'string', description: 'Message id' },
    post_id: { type: 'string', description: 'Post id (create post)' },
    account_id: { type: 'string', description: 'Account id' },
    comment_id: { type: 'string', description: 'Comment id (comment on post)' },
  },
}

export const UnipileBlockMeta = {
  tags: ['messaging', 'sales-engagement'],
} as const
