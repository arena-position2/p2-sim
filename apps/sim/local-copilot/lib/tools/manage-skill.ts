import { AuditAction, AuditResourceType, recordAudit } from '@sim/audit'
import { createLogger } from '@sim/logger'
import { getErrorMessage, toError } from '@sim/utils/errors'
import { copilotToolCanWrite, copilotWriteDeniedMessage } from '@/lib/mothership/tools/permissions'
import { captureServerEvent } from '@/lib/posthog/server'
import { getSkillActorContext } from '@/lib/skills/access'
import { isBuiltinSkillId } from '@/lib/workflows/skills/builtin-skills'
import { deleteSkill, listSkillsForUser, upsertSkills } from '@/lib/workflows/skills/operations'

const logger = createLogger('LocalCopilotManageSkill')

/** Arena Copilot tool name — catalog id matches Cloud `manage_skill`. */
export const MANAGE_SKILL_TOOL_NAME = 'manage_skill'

type ManageSkillOperation = 'add' | 'edit' | 'delete' | 'list'

export interface ManageSkillExecutionContext {
  userId: string
  workspaceId: string
  userPermission?: string | null
  messageId?: string
}

/**
 * Creates, updates, lists, or deletes workspace skills for Arena Local Copilot.
 *
 * Mirrors the historical Cloud Copilot `executeManageSkill` handler (ops +
 * editor gates + audit/PostHog), kept under `local-copilot` so Sim merges do
 * not need to restore `lib/mothership/tools/handlers/management/manage-skill`.
 */
export async function executeManageSkill(
  rawParams: Record<string, unknown>,
  context: ManageSkillExecutionContext
): Promise<{ success: boolean; output?: unknown; error?: string }> {
  const operation = String(rawParams.operation ?? '')
    .trim()
    .toLowerCase() as ManageSkillOperation
  const workspaceId = context.workspaceId
  const skillId = stringArg(rawParams, 'skillId')
  const name = stringArg(rawParams, 'name')
  const description = stringArg(rawParams, 'description')
  const content = stringArg(rawParams, 'content')

  if (!operation) {
    return { success: false, error: "Missing required 'operation' argument" }
  }

  if (!workspaceId) {
    return { success: false, error: 'workspaceId is required' }
  }

  // Workspace write gates only creation; edits and deletes are gated per skill
  // below (skill editor — explicit editor row or derived workspace admin).
  if (operation === 'add' && !copilotToolCanWrite(context.userPermission)) {
    return {
      success: false,
      error: copilotWriteDeniedMessage(MANAGE_SKILL_TOOL_NAME, operation, context.userPermission),
    }
  }

  try {
    if (operation === 'list') {
      const skills = await listSkillsForUser({ workspaceId, userId: context.userId })
      return {
        success: true,
        output: {
          success: true,
          operation,
          skills: skills.map((skill) => ({
            id: skill.id,
            name: skill.name,
            description: skill.description,
            createdAt: skill.createdAt,
          })),
          count: skills.length,
        },
      }
    }

    if (operation === 'add') {
      if (!name || !description || !content) {
        return {
          success: false,
          error: "'name', 'description', and 'content' are required for 'add'",
        }
      }

      const { skills: resultSkills } = await upsertSkills({
        skills: [{ name, description, content }],
        workspaceId,
        userId: context.userId,
      })
      const created = resultSkills.find((skill) => skill.name === name)

      recordAudit({
        workspaceId,
        actorId: context.userId,
        action: AuditAction.SKILL_CREATED,
        resourceType: AuditResourceType.SKILL,
        resourceId: created?.id,
        resourceName: name,
        description: `Created skill "${name}"`,
        metadata: { source: 'tool_input' },
      })
      if (created?.id) {
        captureServerEvent(
          context.userId,
          'skill_created',
          {
            skill_id: created.id,
            skill_name: name,
            workspace_id: workspaceId,
            source: 'tool_input',
          },
          { groups: { workspace: workspaceId } }
        )
      }

      return {
        success: true,
        output: {
          success: true,
          operation,
          skillId: created?.id,
          name,
          message: `Created skill "${name}"`,
        },
      }
    }

    if (operation === 'edit') {
      if (!skillId) {
        return { success: false, error: "'skillId' is required for 'edit'" }
      }
      if (!name && !description && !content) {
        return {
          success: false,
          error: "At least one of 'name', 'description', or 'content' is required for 'edit'",
        }
      }

      if (isBuiltinSkillId(skillId)) {
        return { success: false, error: 'Built-in skills are read-only and cannot be modified' }
      }

      const actor = await getSkillActorContext(skillId, context.userId)
      if (!actor.skill || actor.skill.workspaceId !== workspaceId || !actor.hasWorkspaceAccess) {
        return { success: false, error: `Skill not found: ${skillId}` }
      }
      if (!actor.canEdit) {
        return {
          success: false,
          error: `Permission denied: editing skill "${actor.skill.name}" requires skill editor access. Ask a skill editor to add you.`,
        }
      }

      await upsertSkills({
        skills: [
          {
            id: skillId,
            ...(name ? { name } : {}),
            ...(description ? { description } : {}),
            ...(content ? { content } : {}),
          },
        ],
        workspaceId,
        userId: context.userId,
      })

      const updatedName = name || actor.skill.name
      recordAudit({
        workspaceId,
        actorId: context.userId,
        action: AuditAction.SKILL_UPDATED,
        resourceType: AuditResourceType.SKILL,
        resourceId: skillId,
        resourceName: updatedName,
        description: `Updated skill "${updatedName}"`,
        metadata: { source: 'tool_input' },
      })
      captureServerEvent(
        context.userId,
        'skill_updated',
        {
          skill_id: skillId,
          skill_name: updatedName,
          workspace_id: workspaceId,
          source: 'tool_input',
        },
        { groups: { workspace: workspaceId } }
      )

      return {
        success: true,
        output: {
          success: true,
          operation,
          skillId,
          name: updatedName,
          message: `Updated skill "${updatedName}"`,
        },
      }
    }

    if (operation === 'delete') {
      if (!skillId) {
        return { success: false, error: "'skillId' is required for 'delete'" }
      }

      if (!isBuiltinSkillId(skillId)) {
        const actor = await getSkillActorContext(skillId, context.userId)
        if (!actor.skill || actor.skill.workspaceId !== workspaceId || !actor.hasWorkspaceAccess) {
          return { success: false, error: `Skill not found: ${skillId}` }
        }
        if (!actor.canEdit) {
          return {
            success: false,
            error: `Permission denied: deleting skill "${actor.skill.name}" requires skill editor access. Ask a skill editor to add you.`,
          }
        }
      }

      const deleted = await deleteSkill({ skillId, workspaceId })
      if (!deleted) {
        return { success: false, error: `Skill not found: ${skillId}` }
      }

      recordAudit({
        workspaceId,
        actorId: context.userId,
        action: AuditAction.SKILL_DELETED,
        resourceType: AuditResourceType.SKILL,
        resourceId: skillId,
        description: 'Deleted skill',
        metadata: { source: 'tool_input' },
      })
      captureServerEvent(
        context.userId,
        'skill_deleted',
        { skill_id: skillId, workspace_id: workspaceId, source: 'tool_input' },
        { groups: { workspace: workspaceId } }
      )

      return {
        success: true,
        output: {
          success: true,
          operation,
          skillId,
          message: 'Deleted skill',
        },
      }
    }

    return { success: false, error: `Unsupported operation for manage_skill: ${operation}` }
  } catch (error) {
    logger.error(
      context.messageId
        ? `manage_skill execution failed [messageId:${context.messageId}]`
        : 'manage_skill execution failed',
      {
        operation,
        workspaceId,
        error: toError(error).message,
      }
    )
    return {
      success: false,
      error: getErrorMessage(error, 'Failed to manage skill'),
    }
  }
}

function stringArg(params: Record<string, unknown>, key: string): string | undefined {
  const value = params[key]
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}
