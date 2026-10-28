import { DOCUMENT_FORMAT_GUIDANCE } from '@/lib/mothership/chat/document-format-guidance'
import { LOCAL_COMPLEX_HTML_GUIDANCE } from '@/local-copilot/lib/prompts/complex-html-guidance'
import type { LocalCopilotToolDefinition } from '@/local-copilot/lib/types'

/**
 * Cloud-aligned specialist domains for Local Copilot hybrid orchestration.
 * `general` is classifier-only (not a specialist tool).
 */
export const LOCAL_COPILOT_SPECIALIST_DOMAINS = [
  'general',
  'workflow',
  'run',
  'deploy',
  'auth',
  'knowledge',
  'table',
  'scheduled_task',
  'agent',
  'research',
  'media',
  'file',
  'superagent',
] as const

export type LocalCopilotSpecialistDomain = (typeof LOCAL_COPILOT_SPECIALIST_DOMAINS)[number]

export const LOCAL_COPILOT_CLOUD_SPECIALIST_DOMAINS = [
  'workflow',
  'run',
  'deploy',
  'auth',
  'knowledge',
  'table',
  'scheduled_task',
  'agent',
  'research',
  'media',
  'file',
  'superagent',
] as const

export type LocalCopilotCloudSpecialistDomain =
  (typeof LOCAL_COPILOT_CLOUD_SPECIALIST_DOMAINS)[number]

/** Pre-pass / parent parallel fan-out cap (slowest specialist gates the wait). */
export const MAX_PARALLEL_SUBAGENTS = 2

export const ALWAYS_ON_TOOL_NAMES = new Set<string>([
  'search_docs',
  'search_documentation',
  // Live web — always available so factual questions do not depend on research
  // intent classification (e.g. "Who is the CM of Karnataka?").
  'search_online',
  'get_workflow_context',
  'get_available_blocks',
  'get_available_integrations',
  'get_blocks_metadata',
  'load_copilot_artifact',
  // Core mutation tools — always available so Bedrock/Gemini can edit without
  // depending solely on the `workflow` specialist entry tool.
  'create_workflow',
  'edit_workflow',
  'list_integration_tools',
  'invoke_integration_tool',
  'open_resource',
  'get_platform_actions',
  'list_user_workspaces',
  'load_user_skill',
  'explain_error',
  'user_memory',
  // Sandbox compute — available on every intent so complex analysis / transforms
  // can call function_execute without waiting for agent|file|research classification.
  // manage_sandbox is still dropped in resolveLocalCopilotTools when the workspace
  // has no sandbox entitlement.
  'function_execute',
  'manage_sandbox',
])

const WORKFLOW_TOOLS = [
  'create_workflow',
  'edit_workflow',
  'validate_workflow',
  'generate_workflow_patch',
  'propose_workflow_patch',
  'get_workflow_data',
  'get_block_upstream_references',
  'get_block_outputs',
  'rename_workflow',
  'move_workflow',
  'delete_workflow',
  'manage_folder',
  'set_block_enabled',
  'set_global_workflow_variables',
  'get_deployed_workflow_state',
  'diff_workflows',
  'restore_resource',
  'manage_skill',
  'manage_custom_tool',
  'manage_mcp_tool',
] as const

const RUN_TOOLS = [
  'get_workflow_run_options',
  'run_workflow',
  'run_workflow_until_block',
  'run_block',
  'run_from_block',
  'query_logs',
  'get_execution_logs',
  'explain_error',
  'validate_workflow',
  'get_workflow_data',
  'set_block_enabled',
] as const

const DEPLOY_TOOLS = [
  'deploy_chat',
  'deploy_api',
  'deploy_mcp',
  'redeploy',
  'load_deployment',
  'promote_to_live',
  'update_deployment_version',
  'get_deployment_log',
  'check_deployment_status',
  'diff_workflows',
  'get_block_outputs',
  'get_deployed_workflow_state',
  'list_workspace_mcp_servers',
  'create_workspace_mcp_server',
  'update_workspace_mcp_server',
  'delete_workspace_mcp_server',
] as const

const AUTH_TOOLS = [
  'manage_credential',
  'oauth_get_auth_link',
  'oauth_request_access',
  'generate_api_key',
  'get_available_integrations',
  'list_integration_tools',
] as const

const KNOWLEDGE_TOOLS = [
  'knowledge_base',
  'materialize_file',
  // KB create/ingest needs workspace docs first — without these, "create a KB with
  // this content" can only call knowledge_base and never write the source files.
  'create_file',
  'create_file_folder',
  'glob',
  'read',
  'list_file_folders',
] as const
const TABLE_TOOLS = ['user_table', 'enrichment_run', 'materialize_file'] as const

const SCHEDULED_TASK_TOOLS = [
  'manage_scheduled_task',
  'complete_scheduled_task',
  'update_scheduled_task_history',
  'get_scheduled_task_logs',
] as const

const AGENT_TOOLS = [
  'list_integration_tools',
  'invoke_integration_tool',
  'manage_mcp_tool',
  'manage_skill',
  'manage_custom_tool',
  'load_user_skill',
  'function_execute',
  'manage_sandbox',
  'get_available_integrations',
  'get_platform_actions',
  'list_workspace_mcp_servers',
  'create_workspace_mcp_server',
  'update_workspace_mcp_server',
  'delete_workspace_mcp_server',
] as const

const RESEARCH_TOOLS = [
  'search_online',
  'list_integration_tools',
  'invoke_integration_tool',
  'search_docs',
  'search_documentation',
  'function_execute',
  'manage_sandbox',
  'user_memory',
  'read',
  'glob',
  'grep',
] as const

const MEDIA_TOOLS = ['generate_image', 'generate_audio', 'generate_video', 'ffmpeg'] as const

const FILE_TOOLS = [
  'read',
  'glob',
  'grep',
  'create_file',
  'create_file_folder',
  'workspace_file',
  'download_to_workspace_file',
  'materialize_file',
  'edit_content',
  'function_execute',
  'manage_sandbox',
  'delete_file',
  'rename_file',
  'move_file',
  'list_file_folders',
  'rename_file_folder',
  'move_file_folder',
  'delete_file_folder',
  'restore_resource',
] as const

const SUPERAGENT_TOOLS = [...new Set([...AGENT_TOOLS, ...AUTH_TOOLS, 'read', 'glob'])] as const

export const DOMAIN_TOOL_NAMES: Record<LocalCopilotCloudSpecialistDomain, readonly string[]> = {
  workflow: WORKFLOW_TOOLS,
  run: RUN_TOOLS,
  deploy: DEPLOY_TOOLS,
  auth: AUTH_TOOLS,
  knowledge: KNOWLEDGE_TOOLS,
  table: TABLE_TOOLS,
  scheduled_task: SCHEDULED_TASK_TOOLS,
  agent: AGENT_TOOLS,
  research: RESEARCH_TOOLS,
  media: MEDIA_TOOLS,
  file: FILE_TOOLS,
  superagent: SUPERAGENT_TOOLS,
}

export const SPECIALIST_ENTRY_TOOL_NAMES = new Set<string>(LOCAL_COPILOT_CLOUD_SPECIALIST_DOMAINS)

export interface LocalCopilotIntent {
  primary: LocalCopilotSpecialistDomain
  secondary: LocalCopilotSpecialistDomain[]
  useFullCatalog: boolean
}

export function toolNamesForDomain(domain: LocalCopilotSpecialistDomain): Set<string> {
  if (domain === 'general') return new Set()
  const names = new Set([...ALWAYS_ON_TOOL_NAMES, ...DOMAIN_TOOL_NAMES[domain]])
  // Always-on create_workflow is for the parent / workflow specialist. Other
  // specialists seeing the same user prompt would otherwise create a second workflow.
  if (domain !== 'workflow') {
    names.delete('create_workflow')
  }
  return names
}

export function toolNamesForIntent(intent: LocalCopilotIntent): Set<string> | null {
  if (intent.useFullCatalog) return null
  // Ambiguous / general: always-on leaf tools only; orchestrator unions specialist entry tools.
  if (intent.primary === 'general') return new Set(ALWAYS_ON_TOOL_NAMES)
  const names = toolNamesForDomain(intent.primary)
  for (const domain of intent.secondary) {
    if (domain === 'general') continue
    for (const name of toolNamesForDomain(domain)) names.add(name)
  }
  return names
}

export function filterToolsByNames(
  tools: LocalCopilotToolDefinition[],
  allowedNames: Set<string> | null
): LocalCopilotToolDefinition[] {
  if (!allowedNames) return tools
  return tools.filter((tool) => allowedNames.has(tool.name))
}

export interface HybridParentToolResolution {
  tools: LocalCopilotToolDefinition[]
  /** True only when the full catalog was selected (explicit escape hatch or empty hybrid). */
  usedFullCatalog: boolean
  leafToolCount: number
  specialistEntryCount: number
}

/**
 * Resolves the parent-turn tool list: intent-filtered leaf tools ∪ specialist entry tools.
 * Falls back to the full catalog only when the hybrid set is empty — never solely because
 * `primary === 'general'` when always-on / specialist tools are present.
 */
export function resolveHybridParentTools(params: {
  allTools: LocalCopilotToolDefinition[]
  intent: LocalCopilotIntent
  specialistTools: LocalCopilotToolDefinition[]
}): HybridParentToolResolution {
  const { allTools, intent, specialistTools } = params
  const allowedToolNames = toolNamesForIntent(intent)

  if (allowedToolNames === null) {
    return {
      tools: allTools,
      usedFullCatalog: true,
      leafToolCount: allTools.length,
      specialistEntryCount: 0,
    }
  }

  const leafTools = filterToolsByNames(allTools, allowedToolNames)
  const seen = new Set(leafTools.map((tool) => tool.name))
  const hybrid: LocalCopilotToolDefinition[] = [...leafTools]
  let specialistEntryCount = 0

  for (const specialistTool of specialistTools) {
    if (seen.has(specialistTool.name)) continue
    hybrid.push(specialistTool)
    seen.add(specialistTool.name)
    specialistEntryCount += 1
  }

  if (hybrid.length === 0) {
    return {
      tools: allTools,
      usedFullCatalog: true,
      leafToolCount: 0,
      specialistEntryCount: 0,
    }
  }

  return {
    tools: hybrid,
    usedFullCatalog: false,
    leafToolCount: leafTools.length,
    specialistEntryCount,
  }
}

export function isSpecialistDomain(name: string): name is LocalCopilotCloudSpecialistDomain {
  return SPECIALIST_ENTRY_TOOL_NAMES.has(name)
}

export function domainSystemHint(domain: LocalCopilotSpecialistDomain): string {
  switch (domain) {
    case 'workflow':
      return "Build, edit, and run workflows. Use get_workflow_data / get_workflow_context or get_workflow_run_options when inspecting an existing workflow; create_workflow when the user wants a new one. When adding blocks, use current types from get_blocks_metadata (never sunset/legacy types like gmail, router, or image_generator — use gmail_v2, router_v2, image_generator_v2). When the user asks to add tools TO an Agent (Image Generator, Chart Generator, Exa, etc.), edit that Agent's tools array — do not add those as canvas blocks. For Agent/Router model, use a current recommended id or omit to keep the default (gpt-5) — never gpt-4o or other sunset/legacy models."
    case 'run':
      return 'Focus on running and debugging workflows (get_workflow_run_options, run_workflow, run_block, run_from_block, query_logs). Prefer existing workspaceWorkflows entries — never create a workflow just to run something.'
    case 'deploy':
      return 'Focus on deploying workflows (deploy_chat / deploy_api / redeploy / promotion) and verifying deployment status.'
    case 'auth':
      return 'Focus on credentials, OAuth links, and API keys.'
    case 'knowledge':
      return 'Query, create, and ingest knowledge bases (knowledge_base get / list / query / create / add_file). To seed a new KB with content: create_file markdown/text under files/ (full body in content), then knowledge_base operation=create, then add_file with those VFS paths. Do not finish after research alone — write the files and ingest them.'
    case 'table':
      return 'Create and manage tables, rows, schemas, and enrichments (user_table).'
    case 'scheduled_task':
      return 'Focus on scheduled tasks (create/list/update/complete/logs).'
    case 'agent':
      return 'Focus on integration tools, MCP tools, skills, function_execute (python or shell; Mothership template has no JS), and manage_sandbox (language=python).'
    case 'research':
      return 'Focus on research. For ANY real-world factual or current question, call a live search tool FIRST (exa_answer via invoke_integration_tool, or search_online) before answering — never answer from training memory alone. When the question is about a workspace file, glob/read/grep that exact VFS path — do not open a similarly named file. Use search_documentation only for Sim product questions.'
    case 'media':
      return 'Focus on image/audio/video generation and ffmpeg. For PNG/JPEG/GIF/WebP (even when the user says "PNG format"), call generate_image with outputs.files — never create_file with base64.'
    case 'file':
      return `Read, create, and update workspace files. Create NEW lean html/md/txt/json/csv with create_file once (full body in content) — HTML must stay modular (no mega inline SVG dumps; split CSS/JS; Arena/Figma-scale pages cannot be one-shot). Edit EXISTING text/html: MUST read files/<path>/content first (mega lines may truncate); targeted changes use workspace_file operation=patch with search_replace then edit_content with ONLY the replacement — never regenerate complex HTML. Use operation=update only for empty shells or an explicit full rewrite of a lean file. After create_file, workspace_file target.kind=path (never kind=new_file / operation=create — that duplicates the file). Office PDF/DOCX/PPTX: create_file empty shell (size=0) is SUCCESS — immediately workspace_file update, then edit_content; never claim tools returned empty or restart. There is no prepare_file_edit, edit_file, or run_function tool. Use function_execute only for sandbox data processing (mount via inputs, save with outputs.files), not office docs. Chat uploads/ need materialize_file into files/ before the sandbox can open them. CRITICAL: never dump HTML/CSS/JS in the user-facing reply or findings (no \`\`\`html fences). You MUST still read existing files via the read tool. Put write bodies only in create_file/edit_content. Findings: 1–2 sentences naming the file and outcome.\n\n${DOCUMENT_FORMAT_GUIDANCE}\n\n${LOCAL_COMPLEX_HTML_GUIDANCE}`
    case 'superagent':
      return 'Focus on third-party integration actions. Authenticate if needed, then invoke the right integration tool.'
    default:
      return 'Use the tools for this domain to complete the request.'
  }
}
