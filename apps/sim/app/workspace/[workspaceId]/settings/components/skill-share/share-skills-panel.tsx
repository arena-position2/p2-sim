'use client'

import { useMemo, useRef, useState } from 'react'
import {
  Badge,
  Button,
  Chip,
  ChipCombobox,
  ChipDropdown,
  ChipInput,
  ChipSelect,
  Search,
  Switch,
  toast,
} from '@sim/emcn'
import { CircleCheck } from '@sim/emcn/icons'
import { getErrorMessage } from '@sim/utils/errors'
import { useParams } from 'next/navigation'
import {
  SKILL_SHARE_MAX_WORKSPACES_PER_REQUEST,
  type SkillShareCatalogEntry,
  type SkillSharePresenceStatus,
  type SkillShareType,
  type SkillShareWorkspace,
} from '@/lib/api/contracts/skill-share'
import { SEARCH_DEBOUNCE_MS } from '@/lib/url-state'
import { SkillTile } from '@/app/workspace/[workspaceId]/components'
import { SettingsEmptyState } from '@/app/workspace/[workspaceId]/settings/components/settings-empty-state'
import {
  RESOURCE_LIST_STACK,
  SettingsResourceRow,
} from '@/app/workspace/[workspaceId]/settings/components/settings-resource-row'
import { SettingsSection } from '@/app/workspace/[workspaceId]/settings/components/settings-section/settings-section'
import {
  usePublishSkillShare,
  useShareSkillCatalog,
  useSkillServices,
  useSkillShareCatalog,
  useSkillSharePresence,
  useSkillShareSourceSkills,
  useSkillShareWorkspaceSearch,
} from '@/hooks/queries/skill-share'
import { useDebounce } from '@/hooks/use-debounce'

const TYPE_OPTIONS = [
  { value: 'general', label: 'General' },
  { value: 'service', label: 'Service' },
] as const

const PRESENCE_LABEL: Record<SkillSharePresenceStatus, string> = {
  absent: 'Absent',
  in_sync: 'In sync',
  edited: 'Edited locally',
  name_clash: 'Name taken',
  source: 'Source',
}

const PERSONAL_ORG_SECTION = 'Personal'
const GENERAL_CATALOG_GROUP_ID = 'general'
const UNTAGGED_SERVICE_GROUP_ID = 'service:untagged'

interface CatalogGroup {
  id: string
  label: string
  entries: SkillShareCatalogEntry[]
}

function skillCountLabel(count: number): string {
  return count === 1 ? '1 skill' : `${count} skills`
}

function groupCatalogEntries(catalog: SkillShareCatalogEntry[]): CatalogGroup[] {
  const general: SkillShareCatalogEntry[] = []
  const untaggedService: SkillShareCatalogEntry[] = []
  const byService = new Map<string, { name: string; entries: SkillShareCatalogEntry[] }>()

  for (const entry of catalog) {
    if (entry.type === 'general') {
      general.push(entry)
      continue
    }
    if (entry.services.length === 0) {
      untaggedService.push(entry)
      continue
    }
    for (const service of entry.services) {
      const current = byService.get(service.id)
      if (current) current.entries.push(entry)
      else byService.set(service.id, { name: service.name, entries: [entry] })
    }
  }

  const groups: CatalogGroup[] = []
  if (general.length > 0) {
    groups.push({ id: GENERAL_CATALOG_GROUP_ID, label: 'General', entries: general })
  }
  if (untaggedService.length > 0) {
    groups.push({ id: UNTAGGED_SERVICE_GROUP_ID, label: 'Service', entries: untaggedService })
  }

  const serviceGroups = [...byService.entries()]
    .sort((left, right) => left[1].name.localeCompare(right[1].name))
    .map(([id, group]) => ({
      id: `service:${id}`,
      label: group.name,
      entries: group.entries,
    }))

  return [...groups, ...serviceGroups]
}

function workspaceOptionLabel(name: string, status?: SkillSharePresenceStatus): string {
  return status ? `${name} · ${PRESENCE_LABEL[status]}` : name
}

function organizationSectionLabel(organizationName: string | null): string {
  const trimmed = organizationName?.trim()
  return trimmed ? trimmed : PERSONAL_ORG_SECTION
}

export function ShareSkillsPanel() {
  const params = useParams<{ workspaceId?: string }>()
  const currentWorkspaceId = params.workspaceId ?? ''

  const { data: services = [] } = useSkillServices()
  const {
    data: catalog = [],
    isLoading: catalogLoading,
    error: catalogError,
  } = useSkillShareCatalog()
  const publish = usePublishSkillShare()
  const share = useShareSkillCatalog()

  const [sourceSearch, setSourceSearch] = useState('')
  const [pickedSourceWorkspaceId, setPickedSourceWorkspaceId] = useState('')
  const [selectedSkillIds, setSelectedSkillIds] = useState<string[]>([])
  const [shareType, setShareType] = useState<SkillShareType>('general')
  const [serviceIds, setServiceIds] = useState<string[]>([])
  const [selectedWorkspaceIds, setSelectedWorkspaceIds] = useState<string[]>([])
  const [targetSearch, setTargetSearch] = useState('')
  const [overwriteEdited, setOverwriteEdited] = useState(false)
  const [pendingAction, setPendingAction] = useState<'publish' | 'share' | null>(null)
  const [shareSummary, setShareSummary] = useState<string | null>(null)
  const isBusy = pendingAction !== null

  const sourceWorkspaceId = currentWorkspaceId || pickedSourceWorkspaceId
  const needsSourcePicker = currentWorkspaceId.length === 0
  const debouncedSourceSearch = useDebounce(sourceSearch, SEARCH_DEBOUNCE_MS)
  const sourceWorkspaces = useSkillShareWorkspaceSearch(debouncedSourceSearch, needsSourcePicker)
  const sourceSkills = useSkillShareSourceSkills(sourceWorkspaceId)
  const debouncedTargetSearch = useDebounce(targetSearch, SEARCH_DEBOUNCE_MS)
  const targetWorkspaces = useSkillShareWorkspaceSearch(debouncedTargetSearch)
  const listedTargets = targetWorkspaces.data ?? []
  const knownWorkspacesById = useRef(new Map<string, SkillShareWorkspace>())
  const sourceSkillList = sourceSkills.data ?? []
  const skillById = useMemo(
    () => new Map(sourceSkillList.map((skill) => [skill.id, skill])),
    [sourceSkillList]
  )
  const selectedSkills = useMemo(
    () =>
      selectedSkillIds.flatMap((id) => {
        const skill = skillById.get(id)
        return skill ? [skill] : []
      }),
    [selectedSkillIds, skillById]
  )
  const unpublishedSelected = selectedSkills.filter((skill) => !skill.catalogId)
  const selectedCatalogIds = useMemo(() => {
    const ids = new Set<string>()
    for (const skill of selectedSkills) {
      if (skill.catalogId) ids.add(skill.catalogId)
    }
    for (const entry of catalog) {
      if (selectedSkillIds.includes(entry.originSkillId)) ids.add(entry.id)
    }
    return [...ids]
  }, [catalog, selectedSkillIds, selectedSkills])
  const selectedCatalogId = selectedCatalogIds[0] ?? ''
  const presence = useSkillSharePresence(selectedCatalogId)

  const presenceByWorkspace = useMemo(() => {
    const map = new Map<string, SkillSharePresenceStatus>()
    for (const row of presence.data?.rows ?? []) {
      map.set(row.workspaceId, row.status)
    }
    return map
  }, [presence.data])

  const selectedCatalog = catalog.find((entry) => entry.id === selectedCatalogId)
  const originWorkspaceId =
    presence.data?.originWorkspaceId ?? selectedCatalog?.originWorkspaceId ?? sourceWorkspaceId

  const skillOptions = useMemo(
    () =>
      sourceSkillList.map((skill) => ({
        value: skill.id,
        label: skill.catalogId ? `${skill.name} · In catalog` : skill.name,
      })),
    [sourceSkillList]
  )
  const allSkillsSelected =
    skillOptions.length > 0 &&
    skillOptions.every((option) => selectedSkillIds.includes(option.value))
  const catalogGroups = groupCatalogEntries(catalog)

  const handlePublish = async () => {
    if (unpublishedSelected.length === 0) return
    setPendingAction('publish')
    try {
      for (const skill of unpublishedSelected) {
        await publish.mutateAsync({
          originSkillId: skill.id,
          type: shareType,
          serviceIds: shareType === 'service' ? serviceIds : [],
        })
      }
      toast.success(
        unpublishedSelected.length === 1
          ? 'Skill published to catalog'
          : `${unpublishedSelected.length} skills published to catalog`
      )
    } catch (error) {
      toast.error(getErrorMessage(error, 'Failed to publish skills'))
    } finally {
      setPendingAction(null)
    }
  }

  const targetWorkspaceGroups = useMemo(() => {
    for (const workspace of listedTargets) {
      knownWorkspacesById.current.set(workspace.id, workspace)
    }

    const visible = listedTargets.filter((workspace) => workspace.id !== originWorkspaceId)
    const listedIds = new Set(visible.map((workspace) => workspace.id))
    const grouped = new Map<string, SkillShareWorkspace[]>()

    const addToGroup = (workspace: SkillShareWorkspace) => {
      const section = organizationSectionLabel(workspace.organizationName)
      const current = grouped.get(section)
      if (current) current.push(workspace)
      else grouped.set(section, [workspace])
    }

    for (const workspace of visible) {
      addToGroup(workspace)
    }
    for (const id of selectedWorkspaceIds) {
      if (listedIds.has(id) || id === originWorkspaceId) continue
      const workspace = knownWorkspacesById.current.get(id)
      if (workspace) addToGroup(workspace)
    }

    const sections = [...grouped.keys()].sort((left, right) => {
      if (left === PERSONAL_ORG_SECTION) return 1
      if (right === PERSONAL_ORG_SECTION) return -1
      return left.localeCompare(right)
    })

    return sections.map((section) => {
      const workspaces = [...(grouped.get(section) ?? [])].sort((left, right) =>
        left.name.localeCompare(right.name)
      )
      return {
        section,
        items: workspaces.map((workspace) => {
          const status = presenceByWorkspace.get(workspace.id)
          return {
            value: workspace.id,
            label: workspaceOptionLabel(workspace.name, status),
            icon: status === 'in_sync' ? CircleCheck : undefined,
            hidden: !listedIds.has(workspace.id),
          }
        }),
      }
    })
  }, [listedTargets, originWorkspaceId, presenceByWorkspace, selectedWorkspaceIds])
  const targetWorkspaceOptions = useMemo(
    () => targetWorkspaceGroups.flatMap((group) => group.items),
    [targetWorkspaceGroups]
  )
  const shareableTargetIds = useMemo(
    () => targetWorkspaceOptions.flatMap((option) => (option.hidden ? [] : [option.value])),
    [targetWorkspaceOptions]
  )
  const allTargetsSelected =
    shareableTargetIds.length > 0 &&
    shareableTargetIds.every((id) => selectedWorkspaceIds.includes(id))

  const handleSelectAllSkills = () => {
    if (allSkillsSelected) {
      setSelectedSkillIds([])
      return
    }
    setSelectedSkillIds(skillOptions.map((option) => option.value))
  }

  const handleToggleCatalogGroup = (skillIds: string[]) => {
    setSelectedSkillIds((current) => {
      const allSelected = skillIds.length > 0 && skillIds.every((id) => current.includes(id))
      if (allSelected) {
        const remove = new Set(skillIds)
        return current.filter((id) => !remove.has(id))
      }
      return [...new Set([...current, ...skillIds])]
    })
  }

  const handleSelectAll = () => {
    if (allTargetsSelected) {
      const listed = new Set(shareableTargetIds)
      setSelectedWorkspaceIds((current) => current.filter((id) => !listed.has(id)))
      return
    }
    setSelectedWorkspaceIds((current) => [...new Set([...current, ...shareableTargetIds])])
  }

  const handleShare = async () => {
    if (selectedCatalogIds.length === 0 || selectedWorkspaceIds.length === 0) return
    setPendingAction('share')
    setShareSummary(null)
    try {
      let created = 0
      let updated = 0
      let skipped = 0
      let failed = 0
      for (const catalogId of selectedCatalogIds) {
        for (
          let offset = 0;
          offset < selectedWorkspaceIds.length;
          offset += SKILL_SHARE_MAX_WORKSPACES_PER_REQUEST
        ) {
          const data = await share.mutateAsync({
            catalogId,
            workspaceIds: selectedWorkspaceIds.slice(
              offset,
              offset + SKILL_SHARE_MAX_WORKSPACES_PER_REQUEST
            ),
            overwriteEdited,
          })
          created += data.results.filter((row) => row.status === 'created').length
          updated += data.results.filter((row) => row.status === 'updated').length
          skipped += data.results.filter((row) => row.status.startsWith('skipped_')).length
          failed += data.results.filter((row) => row.status === 'error').length
        }
      }
      const message = `Share finished: ${created} created, ${updated} updated, ${skipped} skipped, ${failed} failed`
      setShareSummary(message)
      if (failed > 0) {
        toast.error(message)
      } else {
        toast.success(message)
      }
    } catch (error) {
      toast.error(getErrorMessage(error, 'Failed to share skills'))
    } finally {
      setPendingAction(null)
    }
  }

  return (
    <div className='flex flex-col gap-6'>
      <div className='flex flex-col gap-4'>
        <p className='text-[var(--text-secondary)] text-sm'>
          {needsSourcePicker
            ? 'Pick a source workspace, then copy its skills into selected workspaces.'
            : 'Copy skills from this workspace into selected workspaces.'}{' '}
          Locally edited copies are left alone unless you turn on overwrite. New workspaces
          automatically receive general catalog skills.
        </p>

        {needsSourcePicker && (
          <div className='flex flex-col gap-2'>
            <p className='text-[var(--text-muted)] text-caption'>Source workspace</p>
            <ChipInput
              icon={Search}
              value={sourceSearch}
              onChange={(event) => setSourceSearch(event.target.value)}
              placeholder='Search workspace name or paste ID'
            />
            {sourceWorkspaces.error && (
              <SettingsEmptyState variant='inline'>
                {sourceWorkspaces.error.message}
              </SettingsEmptyState>
            )}
            <div className={RESOURCE_LIST_STACK}>
              {(sourceWorkspaces.data ?? []).map((workspace) => (
                <SettingsResourceRow
                  key={workspace.id}
                  title={workspace.name}
                  description={workspace.organizationName ?? undefined}
                  onClick={() => {
                    setPickedSourceWorkspaceId(workspace.id)
                    setSelectedSkillIds([])
                  }}
                  clickLabel={`Use skills from ${workspace.name}`}
                  badge={
                    pickedSourceWorkspaceId === workspace.id ? <Badge>Selected</Badge> : undefined
                  }
                />
              ))}
            </div>
          </div>
        )}

        {sourceWorkspaceId && (
          <div className='flex flex-col gap-2'>
            <div className='flex items-center justify-between gap-2'>
              <p className='text-[var(--text-muted)] text-caption'>
                {needsSourcePicker ? 'Skills to share' : 'Skills in this workspace'}
              </p>
              <Chip onClick={handleSelectAllSkills} disabled={skillOptions.length === 0}>
                {allSkillsSelected ? 'Deselect all' : 'Select all'}
              </Chip>
            </div>
            {sourceSkills.error && (
              <SettingsEmptyState variant='inline'>{sourceSkills.error.message}</SettingsEmptyState>
            )}
            <ChipDropdown
              multiple
              searchable
              showAllOption={false}
              fullWidth
              align='start'
              options={skillOptions}
              value={selectedSkillIds}
              onChange={setSelectedSkillIds}
              disabled={sourceSkills.isLoading}
              allLabel={sourceSkills.isLoading ? 'Loading skills…' : 'Select skills'}
              searchPlaceholder='Search skills'
              aria-label='Skills to share'
            />
            {!sourceSkills.isLoading && !sourceSkills.error && sourceSkillList.length === 0 && (
              <SettingsEmptyState variant='inline'>
                No workspace skills to share from here.
              </SettingsEmptyState>
            )}
            <div className='flex flex-wrap items-center gap-2'>
              <ChipSelect
                value={shareType}
                onChange={(value) => {
                  const next = value as SkillShareType
                  setShareType(next)
                  if (next === 'general') setServiceIds([])
                }}
                options={[...TYPE_OPTIONS]}
                placeholder='Type'
              />
              {shareType === 'service' && (
                <ChipDropdown
                  multiple
                  searchable
                  showAllOption={false}
                  allLabel='Services'
                  searchPlaceholder='Search services'
                  placeholder='Services'
                  value={serviceIds}
                  onChange={setServiceIds}
                  options={services.map((service) => ({
                    value: service.id,
                    label: service.name,
                  }))}
                />
              )}
              <Button
                variant='primary'
                onClick={() => {
                  void handlePublish()
                }}
                disabled={
                  isBusy ||
                  unpublishedSelected.length === 0 ||
                  (shareType === 'service' && serviceIds.length === 0)
                }
              >
                {pendingAction === 'publish'
                  ? 'Publishing...'
                  : unpublishedSelected.length > 1
                    ? `Publish ${unpublishedSelected.length}`
                    : 'Publish'}
              </Button>
            </div>
            {publish.error && (
              <p className='text-[var(--text-error)] text-small'>{publish.error.message}</p>
            )}
          </div>
        )}

        <div className='h-px bg-[var(--border)]' />

        <div className='flex flex-col gap-4'>
          <p className='text-[var(--text-muted)] text-caption'>Catalog</p>
          {catalogLoading && (
            <SettingsEmptyState variant='inline'>Loading catalog…</SettingsEmptyState>
          )}
          {catalogError && (
            <SettingsEmptyState variant='inline'>
              {getErrorMessage(catalogError, 'Failed to load catalog')}
            </SettingsEmptyState>
          )}
          {catalog.length === 0 && !catalogLoading && (
            <SettingsEmptyState variant='inline'>No published skills yet.</SettingsEmptyState>
          )}
          {catalogGroups.map((group) => {
            const groupSkillIds = group.entries.map((entry) => entry.originSkillId)
            const groupSelected =
              groupSkillIds.length > 0 && groupSkillIds.every((id) => selectedSkillIds.includes(id))
            return (
              <div key={group.id} className='flex flex-col gap-2'>
                <div className='flex items-center justify-between gap-2'>
                  <p className='text-[var(--text-muted)] text-caption'>
                    {group.label} · {skillCountLabel(group.entries.length)}
                  </p>
                  <Chip
                    onClick={() => handleToggleCatalogGroup(groupSkillIds)}
                    disabled={groupSkillIds.length === 0}
                  >
                    {groupSelected ? 'Deselect all' : 'Select all'}
                  </Chip>
                </div>
                <div className={RESOURCE_LIST_STACK}>
                  {group.entries.map((entry) => (
                    <SettingsResourceRow
                      key={entry.id}
                      iconVariant='custom'
                      icon={<SkillTile />}
                      title={entry.originSkillName}
                      description={`${entry.originWorkspaceName}${
                        entry.services.length > 0
                          ? ` · ${entry.services.map((service) => service.name).join(', ')}`
                          : ''
                      } · ${entry.inSyncCount} in sync · ${entry.editedCount} edited`}
                      onClick={() => {
                        const skillId = entry.originSkillId
                        setSelectedSkillIds((current) =>
                          current.includes(skillId)
                            ? current.filter((id) => id !== skillId)
                            : [...current, skillId]
                        )
                      }}
                      clickLabel={`Share ${entry.originSkillName}`}
                      badge={
                        <span className='flex items-center gap-1'>
                          <Badge>{entry.type === 'general' ? 'General' : 'Service'}</Badge>
                          {selectedSkillIds.includes(entry.originSkillId) && (
                            <Badge>Selected</Badge>
                          )}
                        </span>
                      }
                    />
                  ))}
                </div>
              </div>
            )
          })}
        </div>
      </div>

      <SettingsSection
        label='Target workspaces'
        action={
          <Chip onClick={handleSelectAll} disabled={shareableTargetIds.length === 0}>
            {allTargetsSelected ? 'Deselect all' : 'Select all'}
          </Chip>
        }
      >
        <div className='flex flex-col gap-3'>
          <ChipCombobox
            multiSelect
            searchable
            showAllOption={false}
            align='start'
            dropdownWidth='trigger'
            className='w-full'
            options={targetWorkspaceOptions}
            groups={targetWorkspaceGroups}
            multiSelectValues={selectedWorkspaceIds}
            onMultiSelectChange={setSelectedWorkspaceIds}
            onSearchChange={setTargetSearch}
            isLoading={targetWorkspaces.isLoading}
            disabled={targetWorkspaces.isLoading && listedTargets.length === 0}
            placeholder='Select workspaces'
            searchPlaceholder='Search workspaces'
            emptyMessage={
              targetWorkspaces.error
                ? getErrorMessage(targetWorkspaces.error, 'Failed to load workspaces')
                : 'No workspaces match'
            }
          />
          {targetWorkspaces.error && (
            <SettingsEmptyState variant='inline'>
              {targetWorkspaces.error.message}
            </SettingsEmptyState>
          )}
          <div className='flex items-center justify-between gap-3'>
            <div className='flex flex-col gap-1'>
              <p className='text-[var(--text-secondary)] text-sm'>Overwrite edited copies</p>
              <p className='text-[var(--text-muted)] text-caption'>
                Replace copies even when their content no longer matches the catalog.
              </p>
            </div>
            <Switch
              checked={overwriteEdited}
              onCheckedChange={setOverwriteEdited}
              aria-label='Overwrite edited copies'
            />
          </div>
          <Button
            variant='primary'
            onClick={() => {
              void handleShare()
            }}
            disabled={
              isBusy || selectedWorkspaceIds.length === 0 || selectedCatalogIds.length === 0
            }
          >
            {pendingAction === 'share'
              ? 'Sharing...'
              : selectedCatalogIds.length > 1
                ? `Share ${selectedCatalogIds.length} to selected`
                : 'Share to selected'}
          </Button>
          {unpublishedSelected.length > 0 && selectedWorkspaceIds.length > 0 && (
            <p className='text-[var(--text-muted)] text-caption'>
              Publish selected skills first, then share.
            </p>
          )}
          {share.error && (
            <p className='text-[var(--text-error)] text-small'>{share.error.message}</p>
          )}
          {shareSummary && (
            <p className='text-[var(--text-secondary)] text-caption'>{shareSummary}</p>
          )}
        </div>
      </SettingsSection>
    </div>
  )
}
