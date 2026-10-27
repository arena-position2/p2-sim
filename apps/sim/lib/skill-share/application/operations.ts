import type { ApplicationOperation } from '@/lib/core/application'

function definePlatformAdminOperation<const Id extends string>(id: Id): ApplicationOperation<Id> {
  return Object.freeze({ id, capability: 'none' })
}

/**
 * Platform-admin skill-share operations. These are not workspace-scoped: the
 * caller is authorized as a platform admin, not as a workspace member.
 */
export const skillShareOperations = {
  listServices: definePlatformAdminOperation('skill_share.services.list'),
  createService: definePlatformAdminOperation('skill_share.services.create'),
  updateService: definePlatformAdminOperation('skill_share.services.update'),
  deleteService: definePlatformAdminOperation('skill_share.services.delete'),
  listCatalog: definePlatformAdminOperation('skill_share.catalog.list'),
  publishCatalog: definePlatformAdminOperation('skill_share.catalog.publish'),
  unpublishCatalog: definePlatformAdminOperation('skill_share.catalog.unpublish'),
  listSourceSkills: definePlatformAdminOperation('skill_share.source_skills.list'),
  searchWorkspaces: definePlatformAdminOperation('skill_share.workspaces.search'),
  getPresence: definePlatformAdminOperation('skill_share.presence.read'),
  share: definePlatformAdminOperation('skill_share.share'),
} as const
