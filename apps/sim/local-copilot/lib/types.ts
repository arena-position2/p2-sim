import type { BlockState, Variable, WorkflowState } from '@sim/workflow-types/workflow'
import type { VfsSnapshotV1 } from '@/lib/mothership/generated/vfs-snapshot-v1'
import type { MothershipResource } from '@/lib/mothership/resources/types'
import type { LocalUxPhase } from '@/local-copilot/lib/agent/ux-phase'
import type { GeminiHistoryPart } from '@/local-copilot/lib/providers/types'
import type { LocalToolConfirmationRequirement } from '@/local-copilot/lib/security/tool-confirmation-policy'
import type { LocalTrustedControl } from '@/local-copilot/lib/security/trusted-controls'
import type {
  TurnCompletionStatus,
  VerificationRecord,
} from '@/local-copilot/lib/verification/types'

export interface LocalCopilotE2bCapabilities {
  enabled: boolean
  docSandboxEnabled: boolean
  customSandboxesEnabled?: boolean
  /**
   * Arena Copilot compute matches the Mothership template: Python + shell when
   * the remote sandbox is enabled (not JavaScript).
   */
  supportedCodeLanguages: Array<'python' | 'shell'>
}

export type LocalCopilotProviderId =
  | 'openai'
  | 'anthropic'
  | 'azure-openai'
  | 'bedrock'
  | 'gemini'
  | 'vertex'
  | 'openai-compatible'

export interface LocalCopilotConfig {
  enabled: boolean
  provider: LocalCopilotProviderId
  /** Main agent model (parent tool loop). */
  model: string
  /**
   * Model for specialist / parallel-subagent passes. Defaults to a cheaper
   * Anthropic Haiku when provider is anthropic; otherwise matches {@link model}.
   */
  specialistModel: string
  /**
   * Thinking level for Gemini / Vertex Local Copilot LLM calls (`low` /
   * `medium` / `high`, plus `minimal` on some Flash SKUs). Lower = faster /
   * cheaper. Unset for other providers.
   */
  thinkingLevel?: string
  apiKey?: string
  baseUrl?: string
  /** AWS region for Bedrock (defaults to `AWS_REGION` / `us-east-1`). */
  region?: string
}

export interface LocalCopilotWorkspaceContext {
  id: string
  name: string
  environment: 'cloud' | 'self_hosted'
}

export interface LocalCopilotCredentialMetadata {
  credentialId: string
  provider: string
  status: 'connected' | 'missing' | 'expired'
  scopes?: string[]
  displayName?: string
}

export interface LocalCopilotConnectedIntegration {
  credentialId: string
  providerId: string
  displayName?: string | null
  role?: string | null
  /** True when this OAuth connection belongs to the signed-in user. */
  isOwn?: boolean
}

export interface LocalCopilotExecutionContext {
  lastRunStatus: 'success' | 'failed' | 'running' | 'unknown'
  logs: LocalCopilotLogEntry[]
  failedBlockId: string | null
  error: string | null
  executionId?: string
}

export interface LocalCopilotLogEntry {
  blockId?: string
  blockName?: string
  level: 'info' | 'warn' | 'error'
  message: string
  timestamp?: string
}

export interface LocalCopilotStructuredContext {
  workspace: LocalCopilotWorkspaceContext
  /** Signed-in user talking to Copilot — use for "my email" / "my account". */
  currentUser?: {
    email: string
    name?: string
  }
  connectedIntegrations: LocalCopilotConnectedIntegration[]
  /** Configured workspace/personal env key names (values never included). */
  envVariables: string[]
  /** When true, platform-hosted API keys may be injected at execution time. */
  hostedKeysAvailable: boolean
  /** E2B sandbox availability for code execution and document compilation. */
  e2b?: LocalCopilotE2bCapabilities
  workflow?: {
    id: string
    name: string
    blocks: WorkflowState['blocks']
    edges: WorkflowState['edges']
    variables: WorkflowState['variables']
    loops: WorkflowState['loops']
    parallels: WorkflowState['parallels']
    credentials: LocalCopilotCredentialMetadata[]
  }
  /** Workspace workflow inventory. Present on home chat, and on the open-workflow path for cross-workflow context. */
  workspaceWorkflows?: Array<{
    id: string
    name: string
    isDeployed?: boolean
    lastRunAt?: string | null
    /** Canonical VFS directory (e.g. `workflows/Marketing/Weekly Summary`). */
    path?: string
    folderPath?: string | null
    description?: string | null
  }>
  /** Actionable hint injected when existing workflows should be preferred over creating new ones. */
  guidance?: string
  /**
   * WORKSPACE.md-style inventory markdown built from {@link generateWorkspaceSnapshot}.
   * Injected as a `Workspace snapshot:` system block so Local matches Cloud inventory
   * richness (members, MCP servers, jobs, custom tools) without duplicating it in the JSON payload.
   */
  inventoryMarkdown?: string
  /** Freshness stamps for the workspace inventory snapshot (Local wrapper). */
  snapshotFreshness?: {
    generatedAt: string
    contentRevision: string
    workspaceId?: string
  }
  /**
   * Typed VFS inventory used for incremental baseline/delta prompting.
   * Not injected into the JSON context payload — only for Local prompt planning.
   */
  vfsSnapshot?: VfsSnapshotV1
  knowledgeBases?: Array<{
    id: string
    name: string
    description?: string | null
    connectorTypes?: string[]
  }>
  tables?: Array<{ id: string; name: string; description?: string | null }>
  workspaceFiles?: Array<{ id: string; name: string; path: string; type: string; size: number }>
  /**
   * User-created workspace skills (name + description). All skill bodies are
   * inlined for the turn; otherwise load via load_user_skill if a skill applies.
   */
  skills?: Array<{ id: string; name: string; description: string }>
  /**
   * High-confidence user memories (preferences/entities) for this user + workspace.
   * Full CRUD via the `user_memory` tool.
   */
  userMemories?: Array<{
    key: string
    value: string
    memoryType: string
    source: string
    confidence: number
  }>
  execution: LocalCopilotExecutionContext
  availableIntegrations: string[]
  availableBlocks: LocalCopilotBlockSummary[]
  selectedBlockId?: string
}

export interface LocalCopilotBlockSummary {
  id: string
  name: string
  category: string
  description: string
  authMode?: string
}

export type WorkflowPatchOperation =
  | { operation: 'add_block'; block: BlockState }
  | { operation: 'update_block'; blockId: string; updates: Partial<BlockState> }
  | { operation: 'remove_block'; blockId: string }
  | { operation: 'add_edge'; edge: WorkflowState['edges'][number] }
  | { operation: 'remove_edge'; edgeId: string }
  | { operation: 'update_variable'; variableId: string; updates: Partial<Variable> }
  | { operation: 'add_variable'; variable: Variable }
  | { operation: 'remove_variable'; variableId: string }

export interface WorkflowPatch {
  type: 'workflow_patch'
  summary: string
  changes: WorkflowPatchOperation[]
  requiresConfirmation: true
  warnings?: string[]
  recommendations?: string[]
}

export interface PatchValidationResult {
  valid: boolean
  errors: string[]
  warnings: string[]
}

export interface LocalCopilotToolDefinition {
  name: string
  description: string
  parameters: Record<string, unknown>
}

export interface LocalCopilotToolCallRecord {
  toolCallId: string
  toolName: string
  arguments: Record<string, unknown>
  result?: unknown
  status: 'pending' | 'completed' | 'failed'
}

export type LocalCopilotStreamEvent =
  | { type: 'text_delta'; content: string; thoughtSignature?: string }
  | { type: 'thinking_delta'; content: string; thoughtSignature?: string }
  | {
      type: 'tool_call_start'
      toolCallId: string
      toolName: string
      args?: Record<string, unknown>
      /** Gemini 3+ thought signature — required for follow-up turn CoT. */
      thoughtSignature?: string
    }
  | {
      type: 'tool_call_result'
      toolCallId: string
      toolName: string
      success: boolean
      output: unknown
      error?: string
      resources?: MothershipResource[]
    }
  | {
      type: 'status'
      message: string
      toolCallId?: string
      toolName?: string
    }
  | {
      type: 'ux_phase'
      phase: LocalUxPhase
    }
  | {
      type: 'trusted_control'
      toolCallId: string
      control: LocalTrustedControl
    }
  | {
      type: 'confirmation_required'
      toolCallId: string
      toolName: string
      requirement: LocalToolConfirmationRequirement
    }
  | {
      type: 'verification_completed'
      record: VerificationRecord
    }
  | {
      type: 'turn_completion'
      status: TurnCompletionStatus
      verifications: VerificationRecord[]
    }
  | { type: 'patch_proposed'; patch: WorkflowPatch; patchId: string; workflowId?: string }
  | { type: 'recommendations'; items: string[] }
  | { type: 'error'; message: string }
  | {
      type: 'done'
      messageId: string
      /** Aggregated model tokens for this turn (used for mothership billing). */
      usage?: {
        model: string
        inputTokens: number
        outputTokens: number
      }
    }
  | {
      /**
       * Exact Gemini/Vertex model parts for one tool-loop round. Persisted so
       * the next user turn can echo signatures verbatim (required for CoT).
       */
      type: 'gemini_model_parts'
      parts: GeminiHistoryPart[]
    }

export interface LocalCopilotMessageContent {
  text: string
  patchId?: string
  recommendations?: string[]
  toolCalls?: LocalCopilotToolCallRecord[]
}
