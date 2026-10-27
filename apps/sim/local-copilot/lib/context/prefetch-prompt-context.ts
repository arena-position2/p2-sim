import { hasWorkspaceSandboxAccess } from '@/lib/billing/core/subscription'
import { listChatUploads } from '@/lib/mothership/tools/handlers/upload-file-reader'
import {
  type ActiveDocumentsState,
  parseActiveDocumentsState,
  pathsFromCurrentTurnUploads,
  type ResolvedActiveEditTarget,
  resolveActiveEditTarget,
} from '@/local-copilot/lib/context/active-documents'
import {
  type CopilotChatConfig,
  loadCopilotChatConfig,
} from '@/local-copilot/lib/context/chat-config'
import {
  chatUploadsToAttachmentRefs,
  formatChatUploadsInventorySystemMessage,
  mergeFileAttachmentRefs,
  shouldAutoInlinePriorChatUploads,
} from '@/local-copilot/lib/context/chat-uploads'
import { loadRelevantSkillGuidance } from '@/local-copilot/lib/context/relevant-skills'
import { type CopilotTaskState, parseTaskState } from '@/local-copilot/lib/context/task-state'
import type { ChatMessage } from '@/local-copilot/lib/providers/types'
import { resolveLocalCopilotTools } from '@/local-copilot/lib/tools/definitions'
import type { LocalCopilotSkillSummary } from '@/local-copilot/lib/tools/user-skills'
import type { LocalCopilotToolDefinition } from '@/local-copilot/lib/types'
import {
  type BuildLocalCopilotUserTurnParams,
  buildLocalCopilotUserTurn,
} from '@/local-copilot/lib/user-turn-content'

export interface PromptContextPrefetchInput {
  userId: string
  workspaceId: string
  chatId?: string
  message: string
  contexts?: BuildLocalCopilotUserTurnParams['contexts']
  fileAttachments?: BuildLocalCopilotUserTurnParams['fileAttachments']
}

export interface SettledPromptContextPrefetch {
  relevantSkills: Awaited<ReturnType<typeof loadRelevantSkillGuidance>>
  allTools: LocalCopilotToolDefinition[]
  userTurn: ChatMessage
  taskState: CopilotTaskState | null
  chatConfig: CopilotChatConfig | null
  /** Durable chat-scoped edit targets from prior creates/edits. */
  activeDocuments: ActiveDocumentsState | null
  /** Resolved preferred edit path for this turn (new uploads win; proceed re-inline does not). */
  activeEditTarget: ResolvedActiveEditTarget
  /** Upload paths attached on this request (not prior proceed auto-inline). */
  currentRequestUploadPaths: string[]
  /** System note listing chat-scoped uploads (pointers only). */
  chatUploadsInventory: string | null
  /** True when proceed heuristic auto-inlined prior uploads into the user turn. */
  autoInlinedPriorUploads: boolean
}

export interface PromptContextPrefetch {
  /**
   * Started after structured context exposes skill summaries. Refreshes the
   * tool list so `load_user_skill` matches the catalog (replacing the early
   * provisional tools resolve).
   */
  startSkills: (skills: LocalCopilotSkillSummary[] | undefined, sandboxEntitled?: boolean) => void
  /** Awaits tools / user turn / chat config / skills (once started). */
  settle: () => Promise<SettledPromptContextPrefetch>
}

/**
 * Kicks off parent-prompt I/O that does not need intent classification, so it
 * overlaps spend-gate / session-memory work (and specialist TTFT when present).
 *
 * Chat config is loaded once and reused for both snapshot deltas and task state.
 * Sandbox entitlement + a provisional tool list start immediately; tools are
 * refreshed when skill summaries arrive so the skill tool is not missing.
 */
export function startPromptContextPrefetch(
  input: PromptContextPrefetchInput
): PromptContextPrefetch {
  const uploadsPromise = input.chatId
    ? listChatUploads(input.chatId).catch(() => [])
    : Promise.resolve([])

  const hasCurrentAttachments =
    Boolean(input.fileAttachments?.length) ||
    Boolean(input.contexts?.some((entry) => entry.type === 'uploaded_file'))

  const userTurnPrepPromise = uploadsPromise.then(async (uploads) => {
    const autoInline = shouldAutoInlinePriorChatUploads({
      message: input.message,
      hasCurrentAttachments,
      priorUploadCount: uploads.length,
    })
    const priorRefs = autoInline ? chatUploadsToAttachmentRefs(uploads) : []
    const fileAttachments = autoInline
      ? mergeFileAttachmentRefs(input.fileAttachments, priorRefs)
      : input.fileAttachments

    const userTurn = await buildLocalCopilotUserTurn({
      message: input.message,
      ...(input.contexts?.length ? { contexts: input.contexts } : {}),
      ...(fileAttachments?.length ? { fileAttachments } : {}),
      ...(input.chatId ? { chatId: input.chatId } : {}),
    })

    const currentRequestUploadPaths = pathsFromCurrentTurnUploads({
      fileAttachments: input.fileAttachments,
      contexts: input.contexts,
    })

    return {
      userTurn,
      chatUploadsInventory: formatChatUploadsInventorySystemMessage(uploads),
      autoInlinedPriorUploads: autoInline,
      currentRequestUploadPaths,
    }
  })

  const chatConfigPromise: Promise<CopilotChatConfig | null> = input.chatId
    ? loadCopilotChatConfig(input.chatId, input.userId).catch(() => null)
    : Promise.resolve(null)

  const sandboxPromise = hasWorkspaceSandboxAccess(input.workspaceId).catch(() => false)

  let skillsPromise: Promise<Awaited<ReturnType<typeof loadRelevantSkillGuidance>>> | null = null
  let toolsPromise: Promise<LocalCopilotToolDefinition[]> | null = null
  let toolsHaveSkillCatalog = false

  const resolveTools = (
    skills: LocalCopilotSkillSummary[] | undefined,
    sandboxEntitled?: boolean
  ): Promise<LocalCopilotToolDefinition[]> => {
    const entitledPromise =
      sandboxEntitled !== undefined ? Promise.resolve(sandboxEntitled) : sandboxPromise
    return entitledPromise.then((entitled) =>
      resolveLocalCopilotTools(input.workspaceId, {
        ...(skills !== undefined ? { skills } : {}),
        sandboxEntitled: entitled,
      })
    )
  }

  // Provisional tools (no skill catalog yet) — overlaps context build. Replaced
  // when startSkills provides summaries, or settle falls back to a DB skills query.
  toolsPromise = resolveTools([])

  return {
    startSkills(skills, sandboxEntitled) {
      if (!skillsPromise) {
        skillsPromise = loadRelevantSkillGuidance({
          skills,
          workspaceId: input.workspaceId,
        })
      }
      toolsHaveSkillCatalog = true
      toolsPromise = resolveTools(skills ?? [], sandboxEntitled)
    },
    async settle() {
      if (!skillsPromise) {
        skillsPromise = loadRelevantSkillGuidance({
          skills: undefined,
          workspaceId: input.workspaceId,
        })
      }
      if (!toolsHaveSkillCatalog) {
        toolsHaveSkillCatalog = true
        toolsPromise = resolveTools(undefined)
      }
      const [relevantSkills, allTools, userTurnPrep, chatConfig] = await Promise.all([
        skillsPromise,
        toolsPromise ?? resolveTools(undefined),
        userTurnPrepPromise,
        chatConfigPromise,
      ])
      const activeDocuments = chatConfig
        ? parseActiveDocumentsState(chatConfig.activeDocuments)
        : null
      const activeEditTarget = resolveActiveEditTarget({
        state: activeDocuments,
        currentTurnPaths: userTurnPrep.currentRequestUploadPaths,
        message: input.message,
      })
      return {
        relevantSkills,
        allTools,
        userTurn: userTurnPrep.userTurn,
        taskState: chatConfig ? parseTaskState(chatConfig.taskState) : null,
        chatConfig,
        activeDocuments,
        activeEditTarget,
        currentRequestUploadPaths: userTurnPrep.currentRequestUploadPaths,
        chatUploadsInventory: userTurnPrep.chatUploadsInventory,
        autoInlinedPriorUploads: userTurnPrep.autoInlinedPriorUploads,
      }
    },
  }
}
