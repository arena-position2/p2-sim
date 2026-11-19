'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Chip,
  ChipDropdown,
  type ChipDropdownOption,
  ChipModalField,
  InfoCard,
  InfoCardItem,
  InfoCardList,
} from '@sim/emcn'
import { createLogger } from '@sim/logger'
import { getErrorMessage } from '@sim/utils/errors'
import { ZoomIcon } from '@/components/icons'
import type { OrganizationOAuthAppSummary } from '@/lib/api/contracts/organization-oauth-apps'
import { useActiveOrganization, useSession } from '@/lib/auth/auth-client'
import { getCustomOAuthAppConfig, listCustomOAuthAppKeys } from '@/lib/oauth/custom-app-config'
import { isAdminOrOwner } from '@/lib/workspaces/organization'
import { SettingsPanel } from '@/app/workspace/[workspaceId]/settings/components/settings-panel'
import { useOrganization } from '@/hooks/queries/organization'
import {
  useDeleteOrganizationOAuthApp,
  useOrganizationOAuthApps,
  useUpsertOrganizationOAuthApp,
} from '@/hooks/queries/organization-oauth-apps'
import { useWorkspacesQuery } from '@/hooks/queries/workspace'
import { useSettingsDirtyStore } from '@/stores/settings/dirty/store'

const logger = createLogger('OAuthAppsSettings')

/** Stable module-level list — `listCustomOAuthAppKeys()` allocates a new array each call. */
const SUPPORTED_APP_KEYS = listCustomOAuthAppKeys()

/** Stable empty fallback so `data ?? EMPTY_APPS` does not allocate a new `[]` every render. */
const EMPTY_APPS: OrganizationOAuthAppSummary[] = []

const CUSTOM_APP_LABELS: Record<string, { name: string; description: string }> = {
  zoom: {
    name: 'Zoom',
    description:
      "Register your organization's Zoom Marketplace user app so teammates can connect Zoom using your client credentials.",
  },
  'zoom-admin': {
    name: 'Zoom Admin',
    description:
      "Register your organization's Zoom Marketplace admin app (separate client ID/secret from the user app) for account-wide admin scopes.",
  },
}

interface AppFormState {
  clientId: string
  clientSecret: string
  allowedWorkspaceIds: string[]
  saveError: string | null
}

function createEmptyForms(): Record<string, AppFormState> {
  return Object.fromEntries(
    SUPPORTED_APP_KEYS.map((appKey) => [
      appKey,
      { clientId: '', clientSecret: '', allowedWorkspaceIds: [], saveError: null },
    ])
  )
}

function buildServerSignature(apps: OrganizationOAuthAppSummary[]): string {
  return SUPPORTED_APP_KEYS.map((appKey) => {
    const app = apps.find((row) => row.appKey === appKey)
    const allowlist = (app?.allowedWorkspaceIds ?? []).slice().sort().join(',')
    return `${appKey}:${app?.id ?? ''}:${app?.clientId ?? ''}:${allowlist}`
  }).join('|')
}

const providerMeta = SUPPORTED_APP_KEYS.map((appKey) => {
  const config = getCustomOAuthAppConfig(appKey)
  const labels = CUSTOM_APP_LABELS[appKey] ?? {
    name: appKey,
    description: 'Custom OAuth app credentials for this provider.',
  }
  return { appKey, config, ...labels }
})

/**
 * Organization settings for bringing your own OAuth app credentials.
 * Providers come from `CUSTOM_OAUTH_APP_PROVIDERS` / `listCustomOAuthAppKeys()`.
 */
export function OAuthAppsSettings() {
  const { data: session } = useSession()
  const { data: activeOrganization } = useActiveOrganization()
  const organizationId = activeOrganization?.id

  const { data: organization, isLoading: orgLoading } = useOrganization(organizationId || '')
  const adminOrOwner = isAdminOrOwner(organization, session?.user?.email)

  const { data: appsData, isLoading: appsLoading } = useOrganizationOAuthApps(
    organizationId,
    Boolean(organizationId) && adminOrOwner
  )
  const apps = appsData ?? EMPTY_APPS
  /** Hide Zoom Admin until/unless the list API returns it (org allowlisted via ZOOM_ADMIN_ORG_IDS). */
  const visibleProviderMeta = useMemo(
    () =>
      providerMeta.filter(
        (provider) =>
          provider.appKey !== 'zoom-admin' || apps.some((app) => app.appKey === 'zoom-admin')
      ),
    [apps]
  )

  const { data: allWorkspaces = [] } = useWorkspacesQuery(Boolean(organizationId) && adminOrOwner)
  const orgWorkspaceOptions = useMemo<ChipDropdownOption[]>(
    () =>
      allWorkspaces
        .filter((workspace) => workspace.organizationId === organizationId)
        .map((workspace) => ({ value: workspace.id, label: workspace.name })),
    [allWorkspaces, organizationId]
  )

  const upsertApp = useUpsertOrganizationOAuthApp(organizationId || '')
  const deleteApp = useDeleteOrganizationOAuthApp(organizationId || '')

  const appsByKey = useMemo(() => {
    const map = new Map<string, OrganizationOAuthAppSummary>()
    for (const app of apps) {
      map.set(app.appKey, app)
    }
    return map
  }, [apps])

  const serverSignature = useMemo(() => buildServerSignature(apps), [apps])
  const lastServerSignatureRef = useRef<string | null>(null)

  const [forms, setForms] = useState<Record<string, AppFormState>>(createEmptyForms)

  /**
   * Clear any leftover unsaved-guard from a previous settings tab. Without this,
   * sidebar section switches and Back call `requestLeave` and appear to do
   * nothing when a discard dialog is pending but easy to miss.
   */
  useEffect(() => {
    useSettingsDirtyStore.getState().reset()
    return () => {
      useSettingsDirtyStore.getState().reset()
    }
  }, [])

  /**
   * Hydrate local fields only when the server snapshot actually changes — never
   * on incidental React Query array identity churn, so typing is not wiped and
   * the page does not re-enter setState loops that stall navigation.
   */
  useEffect(() => {
    if (appsLoading) return
    if (lastServerSignatureRef.current === serverSignature) return
    lastServerSignatureRef.current = serverSignature

    setForms(() => {
      const next = createEmptyForms()
      for (const appKey of SUPPORTED_APP_KEYS) {
        const saved = apps.find((row) => row.appKey === appKey)
        next[appKey] = {
          clientId: saved?.clientId ?? '',
          clientSecret: '',
          allowedWorkspaceIds: saved?.allowedWorkspaceIds ?? [],
          saveError: null,
        }
      }
      return next
    })
  }, [apps, appsLoading, serverSignature])

  const updateForm = (appKey: string, patch: Partial<AppFormState>) => {
    setForms((prev) => ({
      ...prev,
      [appKey]: { ...prev[appKey], ...patch },
    }))
  }

  const handleSave = async (appKey: string) => {
    if (!organizationId) return

    const form = forms[appKey]
    const saved = appsByKey.get(appKey)
    const isConfigured = Boolean(saved?.hasClientSecret && saved.clientId)
    const trimmedClientId = form.clientId.trim()
    const trimmedSecret = form.clientSecret.trim()

    updateForm(appKey, { saveError: null })

    if (!trimmedClientId) {
      updateForm(appKey, { saveError: 'Client ID is required.' })
      return
    }
    if (!isConfigured && !trimmedSecret) {
      updateForm(appKey, { saveError: 'Client secret is required.' })
      return
    }
    if (isConfigured && !trimmedSecret) {
      updateForm(appKey, { saveError: 'Enter the client secret to update credentials.' })
      return
    }

    try {
      await upsertApp.mutateAsync({
        appKey,
        clientId: trimmedClientId,
        clientSecret: trimmedSecret,
        ...(appKey === 'zoom-admin' ? { allowedWorkspaceIds: form.allowedWorkspaceIds } : {}),
      })
      updateForm(appKey, { clientSecret: '', saveError: null })
    } catch (error) {
      const message = getErrorMessage(error, `Failed to save ${appKey} OAuth app`)
      updateForm(appKey, { saveError: message })
      logger.error('Failed to save organization OAuth app', error)
    }
  }

  const handleClear = async (appKey: string) => {
    if (!organizationId) return
    const saved = appsByKey.get(appKey)
    if (!saved?.hasClientSecret) return

    updateForm(appKey, { saveError: null })
    try {
      await deleteApp.mutateAsync(appKey)
      updateForm(appKey, {
        clientId: '',
        clientSecret: '',
        allowedWorkspaceIds: [],
        saveError: null,
      })
    } catch (error) {
      const message = getErrorMessage(error, `Failed to remove ${appKey} OAuth app`)
      updateForm(appKey, { saveError: message })
      logger.error('Failed to delete organization OAuth app', error)
    }
  }

  if (!organizationId) {
    return (
      <SettingsPanel>
        <InfoCard>
          <InfoCardList>
            <InfoCardItem>
              Custom OAuth apps are only available for organization workspaces. Create or join an
              organization to configure Zoom Marketplace apps for your team.
            </InfoCardItem>
          </InfoCardList>
        </InfoCard>
      </SettingsPanel>
    )
  }

  if (orgLoading) {
    return <SettingsPanel />
  }

  if (!adminOrOwner) {
    return (
      <SettingsPanel>
        <InfoCard>
          <InfoCardList>
            <InfoCardItem>
              Only organization admins and owners can configure custom OAuth apps. Ask your
              organization admin to add your Zoom Marketplace credentials in this settings tab.
            </InfoCardItem>
          </InfoCardList>
        </InfoCard>
      </SettingsPanel>
    )
  }

  const origin = typeof window !== 'undefined' ? window.location.origin : ''

  return (
    <SettingsPanel>
      <InfoCard>
        <InfoCardList>
          <InfoCardItem>
            To keep existing Zoom connections working without reconnecting, paste the exact client
            ID and secret from the Marketplace apps that originally issued those tokens (the former
            ZOOM_* / ZOOM_ADMIN_* env values). Saving a different Marketplace app will require
            teammates to reconnect.
          </InfoCardItem>
        </InfoCardList>
      </InfoCard>

      {visibleProviderMeta.map(({ appKey, name, description }) => {
        const saved = appsByKey.get(appKey)
        const form = forms[appKey]
        const rowConfigured = Boolean(saved?.hasClientSecret && saved.clientId)
        const callbackPath = `/api/auth/oauth2/custom/${appKey}/callback`
        const callbackUrl = origin ? `${origin}${callbackPath}` : callbackPath

        return (
          <div key={appKey} className='flex flex-col gap-4'>
            <div className='flex items-start gap-3'>
              <div className='flex size-9 flex-shrink-0 items-center justify-center rounded-xl border border-[var(--border-1)] bg-[var(--surface-2)]'>
                <ZoomIcon className='size-[18px]' />
              </div>
              <div className='flex min-w-0 flex-col gap-1'>
                <p className='font-medium text-[var(--text-body)]'>{name}</p>
                <p className='text-[var(--text-muted)] text-caption'>{description}</p>
              </div>
            </div>

            <ChipModalField
              type='input'
              title='Client ID'
              value={form.clientId}
              onChange={(value) => updateForm(appKey, { clientId: value })}
              placeholder={`${name} OAuth Client ID`}
              autoComplete='off'
              disabled={appsLoading || upsertApp.isPending}
            />

            <ChipModalField
              type='input'
              title='Client Secret'
              value={form.clientSecret}
              onChange={(value) => updateForm(appKey, { clientSecret: value })}
              placeholder={
                rowConfigured ? 'Enter a new secret to update' : `${name} OAuth Client Secret`
              }
              autoComplete='off'
              hint={
                rowConfigured
                  ? 'Secret is stored encrypted and never shown again after saving.'
                  : undefined
              }
              disabled={appsLoading || upsertApp.isPending}
            />

            {appKey === 'zoom-admin' && (
              <>
                <ChipModalField type='custom' title='Allowed workspaces'>
                  <ChipDropdown
                    multiple
                    value={form.allowedWorkspaceIds}
                    onChange={(values) => updateForm(appKey, { allowedWorkspaceIds: values })}
                    options={orgWorkspaceOptions}
                    allLabel='Select workspaces'
                    showAllOption={false}
                    searchable
                    searchPlaceholder='Search workspaces...'
                    fullWidth
                    disabled={
                      appsLoading || upsertApp.isPending || orgWorkspaceOptions.length === 0
                    }
                  />
                </ChipModalField>
                <p className='text-[var(--text-muted)] text-caption'>
                  Leave empty to keep env ADMIN_WORKSPACE_IDS behavior. Selecting workspaces
                  restricts Zoom Admin to those workspaces only.
                </p>
              </>
            )}

            {form.saveError && (
              <p className='text-[var(--text-error)] text-caption'>{form.saveError}</p>
            )}

            <div className='flex flex-wrap items-center gap-2'>
              <Chip
                variant='primary'
                onClick={() => void handleSave(appKey)}
                disabled={upsertApp.isPending || deleteApp.isPending}
              >
                {upsertApp.isPending ? 'Saving...' : rowConfigured ? 'Update' : 'Save'}
              </Chip>
              {rowConfigured && (
                <Chip
                  onClick={() => void handleClear(appKey)}
                  disabled={upsertApp.isPending || deleteApp.isPending}
                >
                  {deleteApp.isPending ? 'Removing...' : 'Remove'}
                </Chip>
              )}
            </div>

            <p className='text-[var(--text-muted)] text-caption'>
              Redirect URI for this Marketplace app:{' '}
              <code className='text-[var(--text-body)]'>{callbackUrl}</code>
            </p>
          </div>
        )
      })}
    </SettingsPanel>
  )
}
