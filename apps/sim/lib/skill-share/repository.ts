import { db } from '@sim/db'
import {
  organization,
  skill,
  skillService,
  skillShareCatalog,
  skillShareCatalogService,
  skillShareCopy,
  workspace,
} from '@sim/db/schema'
import { getErrorMessage, getPostgresConstraintName, getPostgresErrorCode } from '@sim/utils/errors'
import { generateId, generateShortId } from '@sim/utils/id'
import { and, asc, eq, ilike, inArray, isNull, or, sql } from 'drizzle-orm'
import { OrchestrationError } from '@/lib/core/orchestration/types'
import type { DbOrTx } from '@/lib/db/types'
import { skillShareContentHash, skillSharePayloadUnchanged } from '@/lib/skill-share/hash'
import { slugifySkillServiceName } from '@/lib/skill-share/service-slug'
import {
  decideShareAction,
  type ShareResultStatus,
  shareDecisionToResult,
} from '@/lib/skill-share/share-decision'
import { isBuiltinSkillId } from '@/lib/workflows/skills/builtin-skills'

export const MAX_SHARE_WORKSPACES = 200
/** Hard cap for general catalog skills copied into a newly created workspace. */
export const MAX_SEED_CATALOG_SKILLS = 200
/** Hard cap for the platform-admin workspace picker across every organization. */
export const MAX_WORKSPACE_SEARCH = 5_000
export const MAX_SERVICES_PER_CATALOG = 20

export type SkillShareType = 'general' | 'service'

export type PresenceStatus = 'absent' | 'in_sync' | 'edited' | 'name_clash' | 'source'

export interface SkillServiceRow {
  id: string
  name: string
  slug: string
  createdAt: Date
  updatedAt: Date
}

export interface CatalogListItem {
  id: string
  type: SkillShareType
  originSkillId: string
  originWorkspaceId: string
  originSkillName: string
  originSkillDescription: string
  originWorkspaceName: string
  services: SkillServiceRow[]
  inSyncCount: number
  editedCount: number
  createdAt: Date
  updatedAt: Date
}

export interface SourceSkillRow {
  id: string
  name: string
  description: string
  catalogId: string | null
}

export interface WorkspaceSearchRow {
  id: string
  name: string
  organizationName: string | null
}

export interface PresenceRow {
  workspaceId: string
  workspaceName: string
  status: PresenceStatus
}

export interface ShareWorkspaceResult {
  workspaceId: string
  workspaceName?: string
  status: ShareResultStatus
  message?: string
}

function uniqueViolation(error: unknown, constraint: string): boolean {
  return getPostgresErrorCode(error) === '23505' && getPostgresConstraintName(error) === constraint
}

function restrictViolation(error: unknown): boolean {
  return getPostgresErrorCode(error) === '23503'
}

export async function listSkillServices(): Promise<SkillServiceRow[]> {
  return db.select().from(skillService).orderBy(asc(skillService.name))
}

function parseServiceName(name: string): { trimmed: string; slug: string } {
  const trimmed = name.trim()
  try {
    return { trimmed, slug: slugifySkillServiceName(trimmed) }
  } catch {
    throw new OrchestrationError(
      'validation',
      'Service name must contain at least one letter or number'
    )
  }
}

export async function createSkillService(name: string): Promise<SkillServiceRow> {
  const { trimmed, slug } = parseServiceName(name)
  const now = new Date()
  try {
    const [row] = await db
      .insert(skillService)
      .values({
        id: generateId(),
        name: trimmed,
        slug,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
    if (!row) throw new OrchestrationError('internal', 'Failed to create service')
    return row
  } catch (error) {
    if (
      uniqueViolation(error, 'skill_service_name_unique') ||
      uniqueViolation(error, 'skill_service_slug_unique')
    ) {
      throw new OrchestrationError('conflict', 'A service with this name already exists')
    }
    throw error
  }
}

export async function renameSkillService(
  serviceId: string,
  name: string
): Promise<SkillServiceRow> {
  const { trimmed } = parseServiceName(name)
  try {
    const [row] = await db
      .update(skillService)
      .set({ name: trimmed, updatedAt: new Date() })
      .where(eq(skillService.id, serviceId))
      .returning()
    if (!row) throw new OrchestrationError('not_found', 'Service not found')
    return row
  } catch (error) {
    if (uniqueViolation(error, 'skill_service_name_unique')) {
      throw new OrchestrationError('conflict', 'A service with this name already exists')
    }
    throw error
  }
}

export async function deleteSkillService(serviceId: string): Promise<void> {
  const [existing] = await db
    .select({ id: skillService.id })
    .from(skillService)
    .where(eq(skillService.id, serviceId))
    .limit(1)
  if (!existing) throw new OrchestrationError('not_found', 'Service not found')

  const [inUse] = await db
    .select({ catalogId: skillShareCatalogService.catalogId })
    .from(skillShareCatalogService)
    .where(eq(skillShareCatalogService.serviceId, serviceId))
    .limit(1)
  if (inUse) {
    throw new OrchestrationError(
      'conflict',
      'This service is still used by a catalog skill. Remove it from those skills first.'
    )
  }

  try {
    await db.delete(skillService).where(eq(skillService.id, serviceId))
  } catch (error) {
    if (restrictViolation(error)) {
      throw new OrchestrationError(
        'conflict',
        'This service is still used by a catalog skill. Remove it from those skills first.'
      )
    }
    throw error
  }
}

function toCount(value: unknown): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : 0
}

/**
 * Catalog rows with per-entry copy counts. Counts compare `skill.updatedAt` to
 * `skill_share_copy.syncedAt` so listing never loads copy bodies.
 */
async function loadShareCatalog(catalogIds?: string[]): Promise<CatalogListItem[]> {
  if (catalogIds && catalogIds.length === 0) return []

  const catalogs = await db
    .select({
      id: skillShareCatalog.id,
      type: skillShareCatalog.type,
      originSkillId: skillShareCatalog.originSkillId,
      originWorkspaceId: skillShareCatalog.originWorkspaceId,
      originSkillName: skill.name,
      originSkillDescription: skill.description,
      originWorkspaceName: workspace.name,
      createdAt: skillShareCatalog.createdAt,
      updatedAt: skillShareCatalog.updatedAt,
    })
    .from(skillShareCatalog)
    .innerJoin(skill, eq(skill.id, skillShareCatalog.originSkillId))
    .innerJoin(workspace, eq(workspace.id, skillShareCatalog.originWorkspaceId))
    .where(catalogIds ? inArray(skillShareCatalog.id, catalogIds) : undefined)
    .orderBy(asc(skill.name))

  if (catalogs.length === 0) return []

  const ids = catalogs.map((row) => row.id)
  const serviceRows = await db
    .select({
      catalogId: skillShareCatalogService.catalogId,
      id: skillService.id,
      name: skillService.name,
      slug: skillService.slug,
      createdAt: skillService.createdAt,
      updatedAt: skillService.updatedAt,
    })
    .from(skillShareCatalogService)
    .innerJoin(skillService, eq(skillService.id, skillShareCatalogService.serviceId))
    .where(inArray(skillShareCatalogService.catalogId, ids))
    .orderBy(asc(skillService.name))

  const copyCounts = await db
    .select({
      catalogId: skillShareCopy.catalogId,
      inSyncCount: sql`cast(count(*) filter (where ${skill.updatedAt} <= ${skillShareCopy.syncedAt}) as int)`,
      editedCount: sql`cast(count(*) filter (where ${skill.updatedAt} > ${skillShareCopy.syncedAt}) as int)`,
    })
    .from(skillShareCopy)
    .innerJoin(skill, eq(skill.id, skillShareCopy.copySkillId))
    .where(inArray(skillShareCopy.catalogId, ids))
    .groupBy(skillShareCopy.catalogId)

  const servicesByCatalog = new Map<string, SkillServiceRow[]>()
  for (const row of serviceRows) {
    const list = servicesByCatalog.get(row.catalogId) ?? []
    list.push({
      id: row.id,
      name: row.name,
      slug: row.slug,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    })
    servicesByCatalog.set(row.catalogId, list)
  }

  const countsByCatalog = new Map(
    copyCounts.map((row) => [
      row.catalogId,
      {
        inSyncCount: toCount(row.inSyncCount),
        editedCount: toCount(row.editedCount),
      },
    ])
  )

  return catalogs.map((row) => {
    const counts = countsByCatalog.get(row.id) ?? { inSyncCount: 0, editedCount: 0 }
    return {
      ...row,
      services: servicesByCatalog.get(row.id) ?? [],
      inSyncCount: counts.inSyncCount,
      editedCount: counts.editedCount,
    }
  })
}

export async function listShareCatalog(): Promise<CatalogListItem[]> {
  return loadShareCatalog()
}

export async function listSourceSkills(workspaceId: string): Promise<SourceSkillRow[]> {
  const [workspaceRow] = await db
    .select({ id: workspace.id })
    .from(workspace)
    .where(and(eq(workspace.id, workspaceId), isNull(workspace.archivedAt)))
    .limit(1)
  if (!workspaceRow) throw new OrchestrationError('not_found', 'Workspace not found')

  const rows = await db
    .select({
      id: skill.id,
      name: skill.name,
      description: skill.description,
      catalogId: skillShareCatalog.id,
    })
    .from(skill)
    .leftJoin(skillShareCatalog, eq(skillShareCatalog.originSkillId, skill.id))
    .leftJoin(skillShareCopy, eq(skillShareCopy.copySkillId, skill.id))
    .where(and(eq(skill.workspaceId, workspaceId), isNull(skillShareCopy.id)))
    .orderBy(asc(skill.name))

  return rows
    .filter((row) => !isBuiltinSkillId(row.id))
    .map((row) => ({
      id: row.id,
      name: row.name,
      description: row.description ?? '',
      catalogId: row.catalogId,
    }))
}

export async function searchShareWorkspaces(search: string): Promise<WorkspaceSearchRow[]> {
  const query = search.trim()
  const filters = [isNull(workspace.archivedAt)]
  if (query) {
    filters.push(
      or(
        eq(workspace.id, query),
        ilike(workspace.name, `%${query}%`),
        ilike(organization.name, `%${query}%`)
      )!
    )
  }

  return db
    .select({
      id: workspace.id,
      name: workspace.name,
      organizationName: organization.name,
    })
    .from(workspace)
    .leftJoin(organization, eq(workspace.organizationId, organization.id))
    .where(and(...filters))
    .orderBy(asc(organization.name), asc(workspace.name))
    .limit(MAX_WORKSPACE_SEARCH)
}

export async function getCatalogPresence(
  catalogId: string,
  workspaceIds: string[]
): Promise<{ originWorkspaceId: string; rows: PresenceRow[] }> {
  const catalog = await loadCatalogWithOrigin(catalogId)
  const filterIds = [...new Set(workspaceIds)].slice(0, MAX_WORKSPACE_SEARCH)
  const scoped = filterIds.length > 0

  const copies = await db
    .select({
      workspaceId: skillShareCopy.workspaceId,
      syncedContentHash: skillShareCopy.syncedContentHash,
      name: skill.name,
      description: skill.description,
      content: skill.content,
    })
    .from(skillShareCopy)
    .innerJoin(skill, eq(skill.id, skillShareCopy.copySkillId))
    .where(
      scoped
        ? and(
            eq(skillShareCopy.catalogId, catalogId),
            inArray(skillShareCopy.workspaceId, filterIds)
          )
        : eq(skillShareCopy.catalogId, catalogId)
    )

  const copyByWorkspace = new Map(copies.map((row) => [row.workspaceId, row]))

  const nameMatches = await db
    .select({ workspaceId: skill.workspaceId, id: skill.id })
    .from(skill)
    .where(
      scoped
        ? and(eq(skill.name, catalog.originName), inArray(skill.workspaceId, filterIds))
        : eq(skill.name, catalog.originName)
    )

  const nameClashWorkspaces = new Set(
    nameMatches
      .filter((row) => !copyByWorkspace.has(row.workspaceId ?? ''))
      .map((row) => row.workspaceId)
      .filter((id): id is string => Boolean(id))
  )

  const workspaceIdsToLoad = scoped
    ? filterIds
    : [...new Set([catalog.originWorkspaceId, ...copyByWorkspace.keys(), ...nameClashWorkspaces])]

  if (workspaceIdsToLoad.length === 0) {
    return { originWorkspaceId: catalog.originWorkspaceId, rows: [] }
  }

  const workspaces = await db
    .select({ id: workspace.id, name: workspace.name })
    .from(workspace)
    .where(and(inArray(workspace.id, workspaceIdsToLoad), isNull(workspace.archivedAt)))

  const rows: PresenceRow[] = workspaces.flatMap((ws): PresenceRow[] => {
    if (ws.id === catalog.originWorkspaceId) {
      return [{ workspaceId: ws.id, workspaceName: ws.name, status: 'source' as const }]
    }
    const copy = copyByWorkspace.get(ws.id)
    if (copy) {
      return [
        {
          workspaceId: ws.id,
          workspaceName: ws.name,
          status: skillSharePayloadUnchanged(copy, copy.syncedContentHash) ? 'in_sync' : 'edited',
        },
      ]
    }
    if (nameClashWorkspaces.has(ws.id)) {
      return [{ workspaceId: ws.id, workspaceName: ws.name, status: 'name_clash' as const }]
    }
    if (scoped) {
      return [{ workspaceId: ws.id, workspaceName: ws.name, status: 'absent' as const }]
    }
    return []
  })

  return { originWorkspaceId: catalog.originWorkspaceId, rows }
}

export async function publishSkillToCatalog(input: {
  originSkillId: string
  type: SkillShareType
  serviceIds: string[]
  createdBy: string
}): Promise<CatalogListItem> {
  if (isBuiltinSkillId(input.originSkillId)) {
    throw new OrchestrationError('validation', 'Built-in skills cannot be published to the catalog')
  }
  if (input.type === 'service' && input.serviceIds.length === 0) {
    throw new OrchestrationError('validation', 'Service skills require at least one service')
  }
  if (input.type === 'general' && input.serviceIds.length > 0) {
    throw new OrchestrationError('validation', 'General skills cannot be tagged with services')
  }
  if (input.serviceIds.length > MAX_SERVICES_PER_CATALOG) {
    throw new OrchestrationError(
      'validation',
      `A skill can have at most ${MAX_SERVICES_PER_CATALOG} services`
    )
  }

  const [origin] = await db
    .select({
      id: skill.id,
      workspaceId: skill.workspaceId,
      name: skill.name,
    })
    .from(skill)
    .where(eq(skill.id, input.originSkillId))
    .limit(1)
  if (!origin?.workspaceId) throw new OrchestrationError('not_found', 'Skill not found')

  const uniqueServiceIds = [...new Set(input.serviceIds)]
  if (uniqueServiceIds.length > 0) {
    const services = await db
      .select({ id: skillService.id })
      .from(skillService)
      .where(inArray(skillService.id, uniqueServiceIds))
    if (services.length !== uniqueServiceIds.length) {
      throw new OrchestrationError('not_found', 'One or more services were not found')
    }
  }

  const now = new Date()
  const catalogId = generateId()

  try {
    await db.transaction(async (tx) => {
      await tx.insert(skillShareCatalog).values({
        id: catalogId,
        originSkillId: origin.id,
        originWorkspaceId: origin.workspaceId as string,
        type: input.type,
        createdBy: input.createdBy,
        createdAt: now,
        updatedAt: now,
      })
      if (uniqueServiceIds.length > 0) {
        await tx.insert(skillShareCatalogService).values(
          uniqueServiceIds.map((serviceId) => ({
            catalogId,
            serviceId,
          }))
        )
      }
    })
  } catch (error) {
    if (uniqueViolation(error, 'skill_share_catalog_origin_skill_unique')) {
      throw new OrchestrationError('conflict', 'This skill is already in the share catalog')
    }
    throw error
  }

  const [published] = await loadShareCatalog([catalogId])
  if (!published) throw new OrchestrationError('internal', 'Failed to load published catalog entry')
  return published
}

export async function unpublishCatalogEntry(catalogId: string): Promise<void> {
  const [existing] = await db
    .select({ id: skillShareCatalog.id })
    .from(skillShareCatalog)
    .where(eq(skillShareCatalog.id, catalogId))
    .limit(1)
  if (!existing) throw new OrchestrationError('not_found', 'Catalog entry not found')
  await db.delete(skillShareCatalog).where(eq(skillShareCatalog.id, catalogId))
}

export async function shareCatalogToWorkspaces(input: {
  catalogId: string
  workspaceIds: string[]
  actorUserId: string
  overwriteEdited?: boolean
}): Promise<ShareWorkspaceResult[]> {
  const uniqueIds = [...new Set(input.workspaceIds)]
  if (uniqueIds.length === 0) {
    throw new OrchestrationError('validation', 'Select at least one workspace')
  }
  if (uniqueIds.length > MAX_SHARE_WORKSPACES) {
    throw new OrchestrationError(
      'validation',
      `Share at most ${MAX_SHARE_WORKSPACES} workspaces at a time`
    )
  }

  const catalog = await loadCatalogWithOrigin(input.catalogId)
  const originHash = skillShareContentHash({
    name: catalog.originName,
    description: catalog.originDescription,
    content: catalog.originContent,
  })
  const overwriteEdited = input.overwriteEdited === true

  const targets = await db
    .select({ id: workspace.id, name: workspace.name })
    .from(workspace)
    .where(and(inArray(workspace.id, uniqueIds), isNull(workspace.archivedAt)))
  const targetById = new Map(targets.map((row) => [row.id, row]))

  const copies = await db
    .select({
      id: skillShareCopy.id,
      workspaceId: skillShareCopy.workspaceId,
      copySkillId: skillShareCopy.copySkillId,
      syncedContentHash: skillShareCopy.syncedContentHash,
      name: skill.name,
      description: skill.description,
      content: skill.content,
    })
    .from(skillShareCopy)
    .innerJoin(skill, eq(skill.id, skillShareCopy.copySkillId))
    .where(
      and(eq(skillShareCopy.catalogId, catalog.id), inArray(skillShareCopy.workspaceId, uniqueIds))
    )
  const copyByWorkspace = new Map(copies.map((row) => [row.workspaceId, row]))

  const nameOwners = await db
    .select({ id: skill.id, workspaceId: skill.workspaceId })
    .from(skill)
    .where(and(eq(skill.name, catalog.originName), inArray(skill.workspaceId, uniqueIds)))
  const nameOwnerByWorkspace = new Map(
    nameOwners.flatMap((row) => (row.workspaceId ? [[row.workspaceId, row.id] as const] : []))
  )

  const now = new Date()
  const payload = {
    name: catalog.originName,
    description: catalog.originDescription,
    content: catalog.originContent,
  }
  const results: ShareWorkspaceResult[] = []
  const skillInserts: Array<{
    id: string
    workspaceId: string
    userId: string
    name: string
    description: string
    content: string
    createdAt: Date
    updatedAt: Date
  }> = []
  const copyInserts: Array<{
    id: string
    catalogId: string
    copySkillId: string
    workspaceId: string
    syncedContentHash: string
    syncedAt: Date
    createdAt: Date
    updatedAt: Date
  }> = []
  const updateSkillIds: string[] = []
  const updateCopyIds: string[] = []

  for (const workspaceId of uniqueIds) {
    const target = targetById.get(workspaceId)
    if (!target) {
      results.push({
        workspaceId,
        status: 'error',
        message: 'Workspace not found',
      })
      continue
    }

    const copyRow = copyByWorkspace.get(workspaceId)
    const nameOwnerId = nameOwnerByWorkspace.get(workspaceId)
    const decision = decideShareAction({
      isSourceWorkspace: workspaceId === catalog.originWorkspaceId,
      copyExists: Boolean(copyRow),
      copyUnedited: copyRow
        ? skillSharePayloadUnchanged(copyRow, copyRow.syncedContentHash)
        : false,
      nameClash: Boolean(nameOwnerId) && nameOwnerId !== copyRow?.copySkillId,
      overwriteEdited,
    })

    if (decision === 'update' && copyRow) {
      updateSkillIds.push(copyRow.copySkillId)
      updateCopyIds.push(copyRow.id)
    } else if (decision === 'create') {
      const copySkillId = generateShortId()
      skillInserts.push({
        id: copySkillId,
        workspaceId,
        userId: input.actorUserId,
        ...payload,
        createdAt: now,
        updatedAt: now,
      })
      copyInserts.push({
        id: generateId(),
        catalogId: catalog.id,
        copySkillId,
        workspaceId,
        syncedContentHash: originHash,
        syncedAt: now,
        createdAt: now,
        updatedAt: now,
      })
    }

    results.push({
      workspaceId,
      workspaceName: target.name,
      status: shareDecisionToResult(decision),
    })
  }

  const hasWrites =
    skillInserts.length > 0 ||
    copyInserts.length > 0 ||
    updateSkillIds.length > 0 ||
    updateCopyIds.length > 0
  if (!hasWrites) return results

  try {
    await db.transaction(async (tx) => {
      if (updateSkillIds.length > 0) {
        await tx
          .update(skill)
          .set({ ...payload, updatedAt: now })
          .where(inArray(skill.id, updateSkillIds))
      }
      if (updateCopyIds.length > 0) {
        await tx
          .update(skillShareCopy)
          .set({
            syncedContentHash: originHash,
            syncedAt: now,
            updatedAt: now,
          })
          .where(inArray(skillShareCopy.id, updateCopyIds))
      }
      if (skillInserts.length > 0) {
        await tx.insert(skill).values(skillInserts)
      }
      if (copyInserts.length > 0) {
        await tx.insert(skillShareCopy).values(copyInserts)
      }
    })
  } catch (error) {
    const message = getErrorMessage(error, 'Failed to share into workspaces')
    return results.map((result) =>
      result.status === 'created' || result.status === 'updated'
        ? { ...result, status: 'error' as const, message }
        : result
    )
  }

  return results
}

interface CatalogOrigin {
  id: string
  type: SkillShareType
  originSkillId: string
  originWorkspaceId: string
  originName: string
  originDescription: string
  originContent: string
}

async function loadCatalogWithOrigin(catalogId: string): Promise<CatalogOrigin> {
  const [row] = await db
    .select({
      id: skillShareCatalog.id,
      type: skillShareCatalog.type,
      originSkillId: skillShareCatalog.originSkillId,
      originWorkspaceId: skillShareCatalog.originWorkspaceId,
      originName: skill.name,
      originDescription: skill.description,
      originContent: skill.content,
    })
    .from(skillShareCatalog)
    .innerJoin(skill, eq(skill.id, skillShareCatalog.originSkillId))
    .where(eq(skillShareCatalog.id, catalogId))
    .limit(1)
  if (!row) throw new OrchestrationError('not_found', 'Catalog entry not found')
  return row
}

export async function listGeneralCatalogEntries(tx: DbOrTx = db): Promise<CatalogOrigin[]> {
  return tx
    .select({
      id: skillShareCatalog.id,
      type: skillShareCatalog.type,
      originSkillId: skillShareCatalog.originSkillId,
      originWorkspaceId: skillShareCatalog.originWorkspaceId,
      originName: skill.name,
      originDescription: skill.description,
      originContent: skill.content,
    })
    .from(skillShareCatalog)
    .innerJoin(skill, eq(skill.id, skillShareCatalog.originSkillId))
    .where(eq(skillShareCatalog.type, 'general'))
    .orderBy(asc(skillShareCatalog.createdAt))
    .limit(MAX_SEED_CATALOG_SKILLS)
}

/**
 * Installs general catalog skills into a newly created workspace in one write.
 * Skips the origin workspace, existing copies, and independent same-name skills.
 * Workspace create already treats seed failure as non-fatal.
 */
export async function seedGeneralSkillsIntoWorkspace(input: {
  workspaceId: string
  ownerUserId: string
}): Promise<void> {
  const entries = await listGeneralCatalogEntries()
  if (entries.length === 0) return

  const catalogIds = entries.map((entry) => entry.id)
  const copies = await db
    .select({
      catalogId: skillShareCopy.catalogId,
      copySkillId: skillShareCopy.copySkillId,
    })
    .from(skillShareCopy)
    .where(
      and(
        eq(skillShareCopy.workspaceId, input.workspaceId),
        inArray(skillShareCopy.catalogId, catalogIds)
      )
    )
  const copySkillIdByCatalog = new Map(copies.map((row) => [row.catalogId, row.copySkillId]))

  const existingSkills = await db
    .select({ name: skill.name })
    .from(skill)
    .where(eq(skill.workspaceId, input.workspaceId))
  const reservedNames = new Set(existingSkills.map((row) => row.name))

  const now = new Date()
  const skillInserts: Array<{
    id: string
    workspaceId: string
    userId: string
    name: string
    description: string
    content: string
    createdAt: Date
    updatedAt: Date
  }> = []
  const copyInserts: Array<{
    id: string
    catalogId: string
    copySkillId: string
    workspaceId: string
    syncedContentHash: string
    syncedAt: Date
    createdAt: Date
    updatedAt: Date
  }> = []

  for (const catalog of entries) {
    const copySkillId = copySkillIdByCatalog.get(catalog.id)
    const decision = decideShareAction({
      isSourceWorkspace: input.workspaceId === catalog.originWorkspaceId,
      copyExists: Boolean(copySkillId),
      copyUnedited: false,
      nameClash: reservedNames.has(catalog.originName),
    })
    if (decision !== 'create') continue

    reservedNames.add(catalog.originName)
    const newSkillId = generateShortId()
    skillInserts.push({
      id: newSkillId,
      workspaceId: input.workspaceId,
      userId: input.ownerUserId,
      name: catalog.originName,
      description: catalog.originDescription,
      content: catalog.originContent,
      createdAt: now,
      updatedAt: now,
    })
    copyInserts.push({
      id: generateId(),
      catalogId: catalog.id,
      copySkillId: newSkillId,
      workspaceId: input.workspaceId,
      syncedContentHash: skillShareContentHash({
        name: catalog.originName,
        description: catalog.originDescription,
        content: catalog.originContent,
      }),
      syncedAt: now,
      createdAt: now,
      updatedAt: now,
    })
  }

  if (skillInserts.length === 0) return

  await db.transaction(async (tx) => {
    await tx.insert(skill).values(skillInserts)
    await tx.insert(skillShareCopy).values(copyInserts)
  })
}
