/**
 * @vitest-environment jsdom
 * @vitest-environment-options { "url": "https://sim.test/workspace/workspace-1/chat/chat-1" }
 */

import { act, type ReactNode } from 'react'
import { authClientMock, authClientMockFns } from '@sim/testing/mocks/auth-client.mock'
import {
  createMockDeploymentShape,
  deploymentShapeMock,
  deploymentShapeMockFns,
} from '@sim/testing/mocks/deployment-shape.mock'
import { nextNavigationMock, nextNavigationMockFns } from '@sim/testing/mocks/next-navigation.mock'
import {
  organizationProviderMock,
  organizationProviderMockFns,
} from '@sim/testing/mocks/organization-provider.mock'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/hooks/queries/workspace-usage', () => ({
  useWorkspaceUsageGate: () => ({ isSuccess: false, data: undefined }),
}))

const {
  mockCredentialHost,
  mockRefetchPersonalEnvironment,
  mockRefetchWorkspaceCredentials,
  mockIsBrowserAgentAvailable,
  mockSavePersonalEnvironment,
  mockSendBrowserPanelAction,
  mockUpsertWorkspaceEnvironment,
  mockUseUserPermissionsContext,
  mockUpdateWorkspaceCredential,
  mockUseWorkspaceCredential,
  mockUseWorkspaceCredentials,
} = vi.hoisted(() => ({
  mockCredentialHost: vi.fn(({ children }: { children: ReactNode }) => children),
  mockUpdateWorkspaceCredential: vi.fn(async () => undefined),
  mockRefetchPersonalEnvironment: vi.fn(async () => ({ data: {} })),
  mockRefetchWorkspaceCredentials: vi.fn(async () => ({ data: [] })),
  mockIsBrowserAgentAvailable: vi.fn(() => false),
  mockSavePersonalEnvironment: vi.fn(async () => undefined),
  mockSendBrowserPanelAction: vi.fn(),
  mockUpsertWorkspaceEnvironment: vi.fn(async () => undefined),
  mockUseUserPermissionsContext: vi.fn(),
  mockUseWorkspaceCredential: vi.fn(),
  mockUseWorkspaceCredentials: vi.fn(),
}))

vi.mock('@/app/workspace/[workspaceId]/home/components/resource-workspace-host', () => ({
  ResourceWorkspaceHost: mockCredentialHost,
}))

vi.mock('@/app/o/[organizationId]/providers/organization-provider', () => organizationProviderMock)
vi.mock('@/app/workspace/[workspaceId]/providers/workspace-host-provider', () => ({
  useOptionalWorkspaceHostContext: () => null,
}))
vi.mock('@/lib/core/config/deployment-shape', () => deploymentShapeMock)
vi.mock('@/hooks/use-settings-navigation', () => ({
  useSettingsNavigation: () => ({ getSettingsHref: () => '/unexpected-workspace-settings' }),
}))

vi.mock('@/app/workspace/[workspaceId]/providers/workspace-permissions-provider', () => ({
  useUserPermissionsContext: mockUseUserPermissionsContext,
}))

vi.mock('next/navigation', () => nextNavigationMock)

vi.mock('@/lib/auth/client', () => authClientMock)
vi.mock('@/app/workspace/[workspaceId]/home/components/chat-surface-context', () => ({
  useChatSurface: () => ({
    SearchConnectionComponent: ({ onConnected }: { onConnected?: () => void }) => (
      <button type='button' onClick={onConnected}>
        Test Search connection
      </button>
    ),
  }),
}))

vi.mock('@/hooks/queries/credentials', () => ({
  useUpdateWorkspaceCredential: () => ({ mutateAsync: mockUpdateWorkspaceCredential }),
  useWorkspaceCredential: mockUseWorkspaceCredential,
  useWorkspaceCredentials: mockUseWorkspaceCredentials,
}))

vi.mock('@/hooks/queries/environment', () => ({
  usePersonalEnvironment: () => ({
    data: {},
    refetch: mockRefetchPersonalEnvironment,
  }),
  useSavePersonalEnvironment: () => ({
    isPending: false,
    mutateAsync: mockSavePersonalEnvironment,
  }),
  useUpsertWorkspaceEnvironment: () => ({
    isPending: false,
    mutateAsync: mockUpsertWorkspaceEnvironment,
  }),
}))

vi.mock('@/lib/browser-agent/transport', () => ({
  isBrowserAgentAvailable: mockIsBrowserAgentAvailable,
  sendBrowserPanelAction: mockSendBrowserPanelAction,
}))

import { toast } from '@sim/emcn'
import type { GenericSecretSource } from '@/lib/api/contracts/organization-secrets'
import {
  createOAuthChatAttempt,
  setOAuthChatAttemptStatus,
} from '@/lib/credentials/oauth-chat-attempt'
import {
  captureRevealedSimKeys,
  type RevealedSimKeysByMessage,
  redactSensitiveContent,
  restoreRevealedSimKeysForMessage,
} from '@/lib/mothership/chat/sim-key-redaction'
import type { CredentialItemData } from '@/app/workspace/[workspaceId]/home/components/message-content/components/special-tags/special-tags'
import { SpecialTags } from '@/app/workspace/[workspaceId]/home/components/message-content/components/special-tags/special-tags'
import { organizationSecretKeys } from '@/hooks/queries/organization-secrets'

const mockOrganizationContext = organizationProviderMockFns.mockUseOptionalOrganizationContext
const mockSession = authClientMockFns.mockUseSession
deploymentShapeMockFns.mockUseDeploymentShape.mockReturnValue(
  createMockDeploymentShape({ hosted: true })
)

const mockParams = nextNavigationMockFns.mockUseParams
mockParams.mockReturnValue({ workspaceId: 'workspace-1' })

/**
 * Minimal dependency-free render harness (the repo has no `@testing-library/react`). Mounts the
 * component in a real React 19 root under jsdom, matching the pattern in `use-autosave.test.tsx`.
 */
function renderCredentialLink(
  data: CredentialItemData | CredentialItemData[],
  onOptionSelect?: (message: string) => void
): {
  container: HTMLDivElement
  root: Root
} {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  const container = document.createElement('div')
  const root: Root = createRoot(container)
  act(() => {
    root.render(
      <SpecialTags
        segment={{ type: 'credential', data: Array.isArray(data) ? data : [data] }}
        onOptionSelect={onOptionSelect}
      />
    )
  })
  return { container, root }
}

describe('CredentialDisplay link tag', () => {
  beforeEach(() => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    mockParams.mockReturnValue({ workspaceId: 'workspace-1' })
    mockOrganizationContext.mockReturnValue(null)
    mockSession.mockReturnValue({ data: { user: { id: 'person' } } })
    mockCredentialHost.mockImplementation(({ children }: { children: ReactNode }) => children)
    window.localStorage.clear()
    window.history.replaceState({}, '', '/workspace/workspace-1/chat/chat-1')
    mockUseUserPermissionsContext.mockReturnValue({ canEdit: true })
    mockUseWorkspaceCredential.mockReturnValue({ data: null })
    mockUseWorkspaceCredentials.mockReturnValue({
      data: [],
      isFetched: true,
      refetch: mockRefetchWorkspaceCredentials,
    })
    mockIsBrowserAgentAvailable.mockReturnValue(false)
  })

  describe('organization Generic Secrets', () => {
    const secret: CredentialItemData = {
      type: 'secret_input',
      name: 'SERVICE_API_KEY',
      scope: 'organization',
    }
    let queryClient: QueryClient
    let root: Root
    let container: HTMLDivElement
    let onContinue: ReturnType<typeof vi.fn>

    beforeEach(() => {
      mockParams.mockReturnValue({ organizationId: 'org' } as never)
      mockOrganizationContext.mockReturnValue({
        organization: { id: 'org', name: 'Example' },
        viewer: { isAdmin: true },
      } as never)
      mockUseUserPermissionsContext.mockReturnValue({ canEdit: false })
      queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
      })
      container = document.createElement('div')
      document.body.appendChild(container)
      root = createRoot(container)
      onContinue = vi.fn()
      vi.spyOn(toast, 'error').mockImplementation(() => 'toast-id')
      vi.spyOn(toast, 'success').mockImplementation(() => 'toast-id')
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: true }), { status: 200 }))
      )
    })

    afterEach(() => {
      act(() => root.unmount())
      queryClient.clear()
      container.remove()
    })

    function render(
      data: CredentialItemData[] = [secret],
      mode: 'agent' | 'assistant' | 'plan' = 'plan'
    ) {
      act(() =>
        root.render(
          <QueryClientProvider client={queryClient}>
            <SpecialTags
              segment={{ type: 'credential', data }}
              requestMode={mode}
              onOptionSelect={onContinue}
            />
          </QueryClientProvider>
        )
      )
    }

    function setSource(source: GenericSecretSource | null) {
      queryClient.setQueryData(organizationSecretKeys.source('org'), { source })
    }

    function enter(name = 'SERVICE_API_KEY', value = 'typed-only-into-form') {
      const input = container.querySelector<HTMLInputElement>(`input[aria-label="${name}"]`)!
      expect(input).not.toBeNull()
      act(() => input.focus())
      act(() => {
        Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set?.call(
          input,
          value
        )
        input.dispatchEvent(new Event('input', { bubbles: true }))
      })
    }

    async function submit() {
      await act(async () => {
        Array.from(container.querySelectorAll('button'))
          .find((button) => button.textContent === 'Submit')
          ?.click()
      })
    }

    it.each(['member', 'missing'] as const)(
      'blocks shared setup for %s access without falling back to workspace secrets',
      (access) => {
        setSource(access === 'missing' ? null : { id: 'source', mode: 'organization' })
        mockOrganizationContext.mockReturnValue({
          organization: { id: 'org', name: 'Example' },
          viewer: { isAdmin: false },
        } as never)
        render()
        expect(container.textContent).toContain('Ask an organization admin')
        expect(container.querySelector('input')).toBeNull()
        expect(fetch).not.toHaveBeenCalled()
        expect(mockUpsertWorkspaceEnvironment).not.toHaveBeenCalled()
      }
    )

    it('clears every draft when the authenticated user changes', () => {
      setSource({ id: 'source', mode: 'member' })
      const data: CredentialItemData[] = [
        secret,
        { type: 'secret_input', name: 'PERSONAL_KEY', scope: 'personal' },
      ]
      render(data)
      enter()
      enter('PERSONAL_KEY', 'personal-only')
      mockSession.mockReturnValue({ data: { user: { id: 'another-person' } } })
      render(data)
      expect(
        container.querySelector<HTMLInputElement>('input[aria-label="SERVICE_API_KEY"]')?.value
      ).toBe('')
      expect(
        container.querySelector<HTMLInputElement>('input[aria-label="PERSONAL_KEY"]')?.value
      ).toBe('')
    })

    it('never renders organization inputs in Search mode or a workspace conversation', () => {
      setSource({ id: 'source', mode: 'organization' })
      render([secret], 'assistant')
      expect(container.querySelector('input')).toBeNull()
      mockParams.mockReturnValue({ workspaceId: 'workspace-1' })
      render()
      expect(container.textContent).toContain('require an organization conversation')
      expect(container.querySelector('input')).toBeNull()
      expect(fetch).not.toHaveBeenCalled()
    })

    it.each([403, 409])(
      'does not claim success or fall back after a %s refusal',
      async (status) => {
        setSource({ id: 'source', mode: 'member' })
        vi.mocked(fetch).mockResolvedValueOnce(
          new Response(JSON.stringify({ error: 'Access or configuration changed' }), { status })
        )
        if (status === 409)
          vi.mocked(fetch).mockResolvedValueOnce(
            new Response(JSON.stringify({ source: { id: 'new-source', mode: 'organization' } }), {
              status: 200,
            })
          )
        render()
        enter()
        await submit()
        expect(onContinue).not.toHaveBeenCalled()
        expect(mockUpsertWorkspaceEnvironment).not.toHaveBeenCalled()
        expect(mockSavePersonalEnvironment).not.toHaveBeenCalled()
        const patches = vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === 'PATCH')
        expect(patches).toHaveLength(1)
        expect(JSON.parse(String(patches[0][1]?.body))).toMatchObject({
          sourceId: 'source',
          mode: 'member',
        })
        if (status === 409) expect(container.querySelector('input')?.value).toBe('')
      }
    )
  })

  it('saves an organization credential into its explicit authorized workspace', async () => {
    mockParams.mockReturnValue({ organizationId: 'org' } as never)
    const { container, root } = renderCredentialLink(
      { type: 'secret_input', name: 'TOKEN', workspaceId: 'target-workspace' },
      vi.fn()
    )
    expect(mockCredentialHost).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: 'target-workspace', organizationId: 'org' }),
      undefined
    )
    const input = container.querySelector('input')!
    act(() => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set?.call(
        input,
        'test-token'
      )
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () =>
      Array.from(container.querySelectorAll('button'))
        .find((button) => button.textContent === 'Submit')
        ?.click()
    )
    expect(mockUpsertWorkspaceEnvironment).toHaveBeenCalledWith({
      workspaceId: 'target-workspace',
      variables: { TOKEN: 'test-token' },
    })
    act(() => root.unmount())
  })

  it.each(
    (
      [
        [{ type: 'secret_input', name: 'TOKEN' }],
        [
          { type: 'secret_input', name: 'A', workspaceId: 'workspace-a' },
          { type: 'secret_input', name: 'B', workspaceId: 'workspace-b' },
        ],
        [
          {
            type: 'link',
            provider: 'slack',
            workspaceId: 'workspace-a',
            value: 'https://sim.test/api/auth/oauth2/authorize?workspaceId=workspace-b',
          },
        ],
      ] satisfies CredentialItemData[][]
    ).map((data) => ({ data }))
  )('does not mount unscoped or conflicting organization controls: %j', ({ data }) => {
    mockParams.mockReturnValue({ organizationId: 'org', workspaceId: 'stale-workspace' } as never)
    const { container, root } = renderCredentialLink(data)
    expect(container.textContent).toContain('one explicit workspace target')
    expect(container.querySelector('input')).toBeNull()
    expect(mockCredentialHost).not.toHaveBeenCalled()
    expect(mockUpsertWorkspaceEnvironment).not.toHaveBeenCalled()
    act(() => root.unmount())
  })

  it('reveals a created key in organization chat after the live fill and after persistence', async () => {
    mockParams.mockReturnValue({ organizationId: 'org' } as never)
    const tag = (item: Record<string, string>) => `<credential>${JSON.stringify(item)}</credential>`
    const tagData = (content: string) =>
      JSON.parse(
        content.slice('<credential>'.length, -'</credential>'.length)
      ) as CredentialItemData
    const cache: RevealedSimKeysByMessage = new Map()
    captureRevealedSimKeys(cache, ['msg-1'], tag({ type: 'sim_key' }), [
      {
        toolCall: {
          name: 'generate_api_key',
          result: { success: true, output: { key: 'sk-sim-live', workspaceId: 'ws-1' } },
        },
      },
    ])
    const live = restoreRevealedSimKeysForMessage(
      { id: 'msg-1', role: 'assistant', content: tag({ type: 'sim_key' }) },
      cache
    ).content

    const writeText = vi.fn(async () => undefined)
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } })
    const copyButton = (container: HTMLElement) =>
      Array.from(container.querySelectorAll('button')).find(
        (button) => button.textContent === 'Copy to clipboard'
      )

    const liveView = renderCredentialLink(tagData(live))
    await act(async () => copyButton(liveView.container)?.click())
    expect(writeText).toHaveBeenCalledWith('sk-sim-live')
    act(() => liveView.root.unmount())

    const persisted = redactSensitiveContent(
      tag({ type: 'sim_key', workspaceId: 'ws-1', value: 'sk-sim-live' })
    )
    const persistedView = renderCredentialLink(tagData(persisted))
    expect(persistedView.container.querySelector('code')).not.toBeNull()
    expect(copyButton(persistedView.container)).toBeUndefined()
    expect(persistedView.container.textContent).not.toContain('sk-sim-live')
    act(() => persistedView.root.unmount())
  })

  it('renders a saved key masked in workspace chat even when its tag names another workspace', () => {
    const persisted = redactSensitiveContent(
      `<credential>${JSON.stringify({ type: 'sim_key', workspaceId: 'other-workspace', value: 'sk-sim-saved' })}</credential>`
    )
    const { container, root } = renderCredentialLink(
      JSON.parse(
        persisted.slice('<credential>'.length, -'</credential>'.length)
      ) as CredentialItemData
    )
    expect(container.querySelector('[role="status"]')).toBeNull()
    expect(container.querySelector('code')).not.toBeNull()
    expect(container.querySelector('button')).toBeNull()
    act(() => root.unmount())
  })

  it('does not mount credential inputs when the target host denies access', () => {
    mockParams.mockReturnValue({ organizationId: 'org' } as never)
    mockCredentialHost.mockReturnValue(null)
    const { container, root } = renderCredentialLink({
      type: 'secret_input',
      name: 'TOKEN',
      workspaceId: 'revoked-workspace',
    })
    expect(container.querySelector('input')).toBeNull()
    expect(mockUpsertWorkspaceEnvironment).not.toHaveBeenCalled()
    expect(mockUseWorkspaceCredentials).not.toHaveBeenCalled()
    act(() => root.unmount())
  })

  it('does not render an anchor for a javascript: scheme value', () => {
    const { container, root } = renderCredentialLink({
      type: 'link',
      provider: 'github',
      value: 'javascript:alert(1)',
    })

    expect(container.querySelector('a')).toBeNull()
    expect(container.textContent).toBe('')
    act(() => root.unmount())
  })

  it('does not render an anchor for a data: scheme value', () => {
    const { container, root } = renderCredentialLink({
      type: 'link',
      provider: 'github',
      value: 'data:text/html,<script>alert(1)</script>',
    })

    expect(container.querySelector('a')).toBeNull()
    expect(container.textContent).toBe('')
    act(() => root.unmount())
  })

  it('renders a working link for a real http(s) connect URL', () => {
    const url = 'https://sim.test/api/auth/oauth2/authorize?providerId=google-drive'
    const { container, root } = renderCredentialLink({
      type: 'link',
      provider: 'google-drive',
      value: url,
    })

    const link = container.querySelector('a')
    expect(link).not.toBeNull()
    expect(link?.getAttribute('href')).toBe(url)
    expect(container.textContent).toContain('Connect Google Drive')
    expect(container.textContent).toContain('Connect integrations')
    act(() => root.unmount())
  })

  it('continues the chat with provider names after integration setup', async () => {
    const container = document.createElement('div')
    const root: Root = createRoot(container)
    const onOptionSelect = vi.fn()
    const data: CredentialItemData[] = [
      {
        type: 'link',
        provider: 'google-email',
        value: 'https://sim.test/api/auth/oauth2/authorize?providerId=google-email',
      },
    ]
    const attempt = createOAuthChatAttempt({
      workspaceId: 'workspace-1',
      providerId: 'google-email',
      baseProviderId: 'google',
      displayName: 'Gmail',
      controlId: 'credential-card:0',
      baselineCredentialIds: [],
    })
    window.history.replaceState({}, '', `?oauthAttempt=${attempt.id}`)

    act(() => {
      root.render(
        <SpecialTags segment={{ type: 'credential', data }} onOptionSelect={onOptionSelect} />
      )
    })

    const submitButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Continue'
    )
    expect(submitButton?.disabled).toBe(false)
    mockRefetchWorkspaceCredentials.mockResolvedValueOnce({
      data: [
        {
          id: 'cred-gmail',
          providerId: 'google-email',
          updatedAt: '2026-10-23T00:00:00.000Z',
        },
      ],
    })
    act(() => {
      setOAuthChatAttemptStatus(attempt.id, 'connected')
    })
    await act(async () => {
      submitButton?.click()
    })

    expect(onOptionSelect).toHaveBeenCalledWith(
      'Credential setup submitted — {"integrations":[{"name":"google-email","status":"connected"}],"secrets":[]}'
    )
    expect(container.textContent).toContain('Gmail')
    expect(container.textContent).toContain('Connected')
    act(() => root.unmount())
  })

  it('reports each requested provider from the refetched credential list', async () => {
    mockRefetchWorkspaceCredentials.mockResolvedValueOnce({
      data: [
        {
          id: 'cred-gmail',
          providerId: 'google-email',
          updatedAt: '2026-10-23T00:00:00.000Z',
        },
      ],
    })
    const container = document.createElement('div')
    const root: Root = createRoot(container)
    const onOptionSelect = vi.fn()
    const data: CredentialItemData[] = [
      {
        type: 'link',
        provider: 'google-email',
        value: 'https://sim.test/api/auth/oauth2/authorize?providerId=google-email',
      },
      {
        type: 'link',
        provider: 'google-calendar',
        value: 'https://sim.test/api/auth/oauth2/authorize?providerId=google-calendar',
      },
    ]

    act(() => {
      root.render(
        <SpecialTags segment={{ type: 'credential', data }} onOptionSelect={onOptionSelect} />
      )
    })

    const continueButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Continue'
    )
    expect(container.textContent).toContain('Connect these, then continue.')
    await act(async () => {
      continueButton?.click()
    })

    expect(onOptionSelect).toHaveBeenCalledWith(
      'Credential setup submitted — {"integrations":[{"name":"google-email","status":"connected"},{"name":"google-calendar","status":"skipped"}],"secrets":[]}'
    )
    act(() => root.unmount())
  })

  it('shows not connected after an unfinished OAuth tab returns focus', async () => {
    const attempt = createOAuthChatAttempt({
      workspaceId: 'workspace-1',
      providerId: 'google-email',
      baseProviderId: 'google',
      displayName: 'Gmail',
      controlId: 'credential-card:0',
      baselineCredentialIds: [],
    })
    window.history.replaceState({}, '', `?oauthAttempt=${attempt.id}`)
    const { container, root } = renderCredentialLink({
      type: 'link',
      provider: 'google-email',
      value: 'https://sim.test/api/auth/oauth2/authorize?providerId=google-email',
    })

    expect(container.textContent).toContain('Waiting for Gmail connection')

    await act(async () => {
      window.dispatchEvent(new Event('blur'))
      window.dispatchEvent(new Event('focus'))
    })

    expect(container.textContent).toContain('Not connected — connect Gmail')
    act(() => root.unmount())
  })

  it('keeps a new-account link actionable when Gmail already has a credential', () => {
    mockUseWorkspaceCredentials.mockReturnValue({
      data: [{ id: 'existing-gmail', providerId: 'google' }],
      isFetched: true,
      refetch: mockRefetchWorkspaceCredentials,
    })
    const { container, root } = renderCredentialLink({
      type: 'link',
      provider: 'google-email',
      value: 'https://sim.test/api/auth/oauth2/authorize?providerId=google-email',
    })

    expect(container.textContent).toContain('Connect another Gmail')
    expect(container.textContent).not.toContain('Connected Gmail')
    expect(container.querySelector('a')?.getAttribute('aria-disabled')).toBe('false')
    act(() => root.unmount())
  })

  it('marks the row connected when a new matching credential appears elsewhere', async () => {
    const existingCredential = {
      id: 'existing-gmail',
      providerId: 'google',
      updatedAt: '2026-08-07T10:00:00Z',
    }
    let credentials = [existingCredential]
    mockUseWorkspaceCredentials.mockImplementation(() => ({
      data: credentials,
      isFetched: true,
      refetch: mockRefetchWorkspaceCredentials,
    }))
    const data: CredentialItemData = {
      type: 'link',
      provider: 'google-email',
      value: 'https://sim.test/api/auth/oauth2/authorize?providerId=google-email',
    }
    const { container, root } = renderCredentialLink(data)

    expect(container.textContent).toContain('Connect another Gmail')
    credentials = [
      existingCredential,
      { id: 'new-gmail', providerId: 'google', updatedAt: '2026-08-07T10:05:00Z' },
    ]
    await act(async () => {
      root.render(<SpecialTags segment={{ type: 'credential', data: [data] }} />)
    })

    expect(container.textContent).toContain('Connected Gmail')
    // A workspace-wide change cannot be attributed to one row, so it shows the
    // row as satisfied without disabling it — see the sibling-row case below.
    expect(container.querySelector('a')?.getAttribute('aria-disabled')).toBe('false')
    act(() => root.unmount())
  })

  it('refetches after returning from another tab and detects a new matching credential', async () => {
    const existingCredential = {
      id: 'existing-gmail',
      providerId: 'google',
      updatedAt: '2026-08-07T10:00:00Z',
    }
    mockUseWorkspaceCredentials.mockReturnValue({
      data: [existingCredential],
      isFetched: true,
      refetch: mockRefetchWorkspaceCredentials,
    })
    mockRefetchWorkspaceCredentials.mockResolvedValueOnce({
      data: [
        existingCredential,
        { id: 'new-gmail', providerId: 'google', updatedAt: '2026-08-07T10:05:00Z' },
      ],
    })
    const { container, root } = renderCredentialLink({
      type: 'link',
      provider: 'google-email',
      value: 'https://sim.test/api/auth/oauth2/authorize?providerId=google-email',
    })

    await act(async () => {
      window.dispatchEvent(new Event('blur'))
      window.dispatchEvent(new Event('focus'))
    })

    expect(mockRefetchWorkspaceCredentials).toHaveBeenCalledOnce()
    expect(container.textContent).toContain('Connected Gmail')
    act(() => root.unmount())
  })

  it('does not treat an unrelated update to a reconnect target as OAuth completion', async () => {
    let credentials = [{ id: 'cred-1', providerId: 'google', updatedAt: '2026-08-07T10:00:00Z' }]
    mockUseWorkspaceCredentials.mockImplementation(() => ({
      data: credentials,
      isFetched: true,
      refetch: mockRefetchWorkspaceCredentials,
    }))
    const data: CredentialItemData = {
      type: 'link',
      provider: 'google-email',
      value:
        'https://sim.test/api/auth/oauth2/authorize?providerId=google-email&credentialId=cred-1',
    }
    const { container, root } = renderCredentialLink(data)

    credentials = [{ ...credentials[0], updatedAt: '2026-08-07T10:05:00Z' }]
    await act(async () => {
      root.render(<SpecialTags segment={{ type: 'credential', data: [data] }} />)
    })

    expect(container.textContent).toContain('Reconnect Gmail')
    expect(container.textContent).not.toContain('Connected Gmail')
    act(() => root.unmount())
  })

  it('runs the connect in a popup so the chat tab never navigates', () => {
    const popup = { focus: vi.fn() }
    const openSpy = vi
      .spyOn(window, 'open')
      .mockReturnValue(popup as unknown as ReturnType<typeof window.open>)
    const { container, root } = renderCredentialLink({
      type: 'link',
      provider: 'google-email',
      value:
        'https://sim.test/api/auth/oauth2/authorize?providerId=google-email&callbackURL=https%3A%2F%2Fsim.test%2Fworkspace%2Fworkspace-1%2Fchat%2Fchat-1',
    })

    const link = container.querySelector('a')
    const defaultPrevented = !link?.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true })
    )

    expect(defaultPrevented).toBe(true)
    expect(popup.focus).toHaveBeenCalledOnce()
    const openedUrl = new URL(openSpy.mock.calls[0][0] as string)
    const callbackUrl = new URL(openedUrl.searchParams.get('callbackURL') ?? '')
    expect(callbackUrl.pathname).toBe('/oauth/chat-complete')
    // Named per attempt: a shared name would let a sibling row renavigate this
    // popup and strand this attempt with no return leg.
    const attemptId = callbackUrl.searchParams.get('oauthAttempt')
    expect(openSpy.mock.calls[0][1]).toBe(`sim-oauth-connect-${attemptId}`)
    openSpy.mockRestore()
    act(() => root.unmount())
  })

  it('keeps a cross-origin connect URL on the anchor instead of a popup', () => {
    const openSpy = vi.spyOn(window, 'open')
    const { container, root } = renderCredentialLink({
      type: 'link',
      provider: 'google-email',
      value:
        'https://evil.example/api/auth/oauth2/authorize?providerId=google-email&callbackURL=https%3A%2F%2Fevil.example%2Fsink',
    })

    const link = container.querySelector('a')
    link?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))

    // The anchor carries rel='noopener noreferrer'; window.open would not.
    expect(openSpy).not.toHaveBeenCalled()
    expect(link?.getAttribute('rel')).toBe('noopener noreferrer')
    openSpy.mockRestore()
    act(() => root.unmount())
  })

  it('announces the connection once the popup publishes its verdict', async () => {
    const toastSuccess = vi.spyOn(toast, 'success').mockImplementation(() => '')
    const popup = { focus: vi.fn(), closed: false }
    const openSpy = vi
      .spyOn(window, 'open')
      .mockReturnValue(popup as unknown as ReturnType<typeof window.open>)
    const { container, root } = renderCredentialLink({
      type: 'link',
      provider: 'google-email',
      value:
        'https://sim.test/api/auth/oauth2/authorize?providerId=google-email&callbackURL=https%3A%2F%2Fsim.test%2Fworkspace%2Fworkspace-1%2Fchat%2Fchat-1',
    })

    await act(async () => {
      container
        .querySelector('a')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })
    const attemptId = new URL(
      new URL(openSpy.mock.calls[0][0] as string).searchParams.get('callbackURL') ?? ''
    ).searchParams.get('oauthAttempt') as string

    expect(toastSuccess).not.toHaveBeenCalled()
    await act(async () => {
      setOAuthChatAttemptStatus(attemptId, 'connected')
    })

    expect(toastSuccess).toHaveBeenCalledWith('Gmail connected successfully.')
    openSpy.mockRestore()
    toastSuccess.mockRestore()
    act(() => root.unmount())
  })

  it('settles the row when the popup dies on a page that publishes no verdict', async () => {
    // A denied consent lands on /oauth-error, which never writes a verdict and
    // never self-closes. The row must not defer to it forever.
    const popup = {
      focus: vi.fn(),
      closed: false,
      location: { origin: 'https://sim.test', pathname: '/oauth-error' },
    }
    const openSpy = vi
      .spyOn(window, 'open')
      .mockReturnValue(popup as unknown as ReturnType<typeof window.open>)
    const { container, root } = renderCredentialLink({
      type: 'link',
      provider: 'google-email',
      value:
        'https://sim.test/api/auth/oauth2/authorize?providerId=google-email&callbackURL=https%3A%2F%2Fsim.test%2Fworkspace%2Fworkspace-1%2Fchat%2Fchat-1',
    })

    await act(async () => {
      container
        .querySelector('a')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })
    await act(async () => {
      window.dispatchEvent(new Event('blur'))
      window.dispatchEvent(new Event('focus'))
    })

    expect(container.textContent).toContain('Not connected — connect Gmail')
    openSpy.mockRestore()
    act(() => root.unmount())
  })

  it('keeps the row retryable when the verdict lands but no credential appears', async () => {
    // The credential-draft failure is swallowed server-side, so the flow can
    // report success with nothing in the workspace. Label follows the verdict;
    // the control must stay clickable so the user can try again.
    const toastSuccess = vi.spyOn(toast, 'success').mockImplementation(() => '')
    const popup = { focus: vi.fn(), closed: false }
    const openSpy = vi
      .spyOn(window, 'open')
      .mockReturnValue(popup as unknown as ReturnType<typeof window.open>)
    const { container, root } = renderCredentialLink({
      type: 'link',
      provider: 'google-email',
      value:
        'https://sim.test/api/auth/oauth2/authorize?providerId=google-email&callbackURL=https%3A%2F%2Fsim.test%2Fworkspace%2Fworkspace-1%2Fchat%2Fchat-1',
    })

    await act(async () => {
      container
        .querySelector('a')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })
    const attemptId = new URL(
      new URL(openSpy.mock.calls[0][0] as string).searchParams.get('callbackURL') ?? ''
    ).searchParams.get('oauthAttempt') as string
    await act(async () => {
      setOAuthChatAttemptStatus(attemptId, 'connected')
    })

    expect(container.textContent).toContain('Connected Gmail')
    expect(container.querySelector('a')?.getAttribute('aria-disabled')).toBe('false')
    openSpy.mockRestore()
    toastSuccess.mockRestore()
    act(() => root.unmount())
  })

  it('keeps waiting when the tab is refocused while the connect popup is still open', async () => {
    const popup = {
      focus: vi.fn(),
      closed: false,
      // Still on the provider's pages: reading location across origins throws.
      get location(): Location {
        throw new DOMException('cross-origin', 'SecurityError')
      },
    }
    const openSpy = vi
      .spyOn(window, 'open')
      .mockReturnValue(popup as unknown as ReturnType<typeof window.open>)
    const { container, root } = renderCredentialLink({
      type: 'link',
      provider: 'google-email',
      value:
        'https://sim.test/api/auth/oauth2/authorize?providerId=google-email&callbackURL=https%3A%2F%2Fsim.test%2Fworkspace%2Fworkspace-1%2Fchat%2Fchat-1',
    })

    await act(async () => {
      container
        .querySelector('a')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })
    await act(async () => {
      window.dispatchEvent(new Event('blur'))
      window.dispatchEvent(new Event('focus'))
    })

    expect(container.textContent).toContain('Waiting for Gmail connection')
    openSpy.mockRestore()
    act(() => root.unmount())
  })

  it('settles the row from the popup watcher when the flow ends with no event in this tab', async () => {
    // A provider interstitial (Trello parks on one for ~3s) bounces to the
    // workspace root without ever reaching the completion page. Neither page
    // publishes a verdict, and a user who never leaves this tab gets no focus
    // event either — only the watcher can end the wait.
    vi.useFakeTimers()
    const popup = {
      focus: vi.fn(),
      closed: false,
      location: { origin: 'https://sim.test', pathname: '/api/auth/trello/callback' },
    }
    const openSpy = vi
      .spyOn(window, 'open')
      .mockReturnValue(popup as unknown as ReturnType<typeof window.open>)
    const { container, root } = renderCredentialLink({
      type: 'link',
      provider: 'google-email',
      value:
        'https://sim.test/api/auth/oauth2/authorize?providerId=google-email&callbackURL=https%3A%2F%2Fsim.test%2Fworkspace%2Fworkspace-1%2Fchat%2Fchat-1',
    })

    await act(async () => {
      container
        .querySelector('a')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000)
    })

    // The interstitial is not terminal, so the row is still deferring.
    expect(container.textContent).toContain('Waiting for Gmail connection')

    popup.location.pathname = '/workspace'
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000)
    })

    expect(container.textContent).toContain('Not connected — connect Gmail')
    vi.useRealTimers()
    openSpy.mockRestore()
    act(() => root.unmount())
  })

  it('does not fail the row when a disowned popup handle reports closed', async () => {
    // A provider page with COOP `same-origin` disowns the window, and the
    // disowned handle reports `closed` for a consent screen that is still
    // running. The watcher must not read that as an ending: publishing 'failed'
    // here would fight a live flow, and the row would invite a rival retry.
    vi.useFakeTimers()
    const popup = { focus: vi.fn(), closed: true }
    const openSpy = vi
      .spyOn(window, 'open')
      .mockReturnValue(popup as unknown as ReturnType<typeof window.open>)
    const { container, root } = renderCredentialLink({
      type: 'link',
      provider: 'google-email',
      value:
        'https://sim.test/api/auth/oauth2/authorize?providerId=google-email&callbackURL=https%3A%2F%2Fsim.test%2Fworkspace%2Fworkspace-1%2Fchat%2Fchat-1',
    })

    await act(async () => {
      container
        .querySelector('a')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000)
    })

    expect(container.textContent).toContain('Waiting for Gmail connection')
    expect(container.textContent).not.toContain('Not connected')

    // Indistinguishable from a popup the user simply closed, so the wait is
    // bounded rather than indefinite: past the safety timeout the row decides
    // from the credential list instead of waiting on a verdict that never came.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(10 * 60 * 1000)
    })

    expect(container.textContent).toContain('Not connected — connect Gmail')
    vi.useRealTimers()
    openSpy.mockRestore()
    act(() => root.unmount())
  })

  it('holds the deadline open while the popup is live, then settles once it is not', async () => {
    // A consent screen can outlive the safety timeout. Expiring against a live
    // window would spend the bound early and leave nothing to catch the popup
    // dying unobservably later, so the deadline waits instead of firing.
    vi.useFakeTimers()
    const popup = {
      focus: vi.fn(),
      closed: false,
      // Still on the provider's pages: reading location across origins throws.
      get location(): Location {
        throw new DOMException('cross-origin', 'SecurityError')
      },
    }
    const openSpy = vi
      .spyOn(window, 'open')
      .mockReturnValue(popup as unknown as ReturnType<typeof window.open>)
    const { container, root } = renderCredentialLink({
      type: 'link',
      provider: 'google-email',
      value:
        'https://sim.test/api/auth/oauth2/authorize?providerId=google-email&callbackURL=https%3A%2F%2Fsim.test%2Fworkspace%2Fworkspace-1%2Fchat%2Fchat-1',
    })

    await act(async () => {
      container
        .querySelector('a')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(11 * 60 * 1000)
    })

    expect(container.textContent).toContain('Waiting for Gmail connection')

    // Dies unobservably well after the original deadline — the watcher releases
    // the handle without a verdict, so only a still-armed deadline can settle.
    popup.closed = true
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000)
    })

    expect(container.textContent).toContain('Not connected — connect Gmail')
    vi.useRealTimers()
    openSpy.mockRestore()
    act(() => root.unmount())
  })

  it('keeps the unobservable deadline across a remount', async () => {
    // The transcript virtualizes, so a row can scroll away mid-connect and come
    // back with no window handle and no blur behind it. The deadline is derived
    // from the attempt's requestedAt rather than held in the effect, so the
    // remounted row inherits the remaining time instead of waiting forever.
    vi.useFakeTimers()
    const popup = { focus: vi.fn(), closed: false }
    const openSpy = vi
      .spyOn(window, 'open')
      .mockReturnValue(popup as unknown as ReturnType<typeof window.open>)
    const data: CredentialItemData = {
      type: 'link',
      provider: 'google-email',
      value:
        'https://sim.test/api/auth/oauth2/authorize?providerId=google-email&callbackURL=https%3A%2F%2Fsim.test%2Fworkspace%2Fworkspace-1%2Fchat%2Fchat-1',
    }
    const first = renderCredentialLink(data)

    await act(async () => {
      first.container
        .querySelector('a')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })
    popup.closed = true
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60 * 1000)
    })
    act(() => first.root.unmount())

    const second = renderCredentialLink(data)
    expect(second.container.textContent).toContain('Waiting for Gmail connection')

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10 * 60 * 1000)
    })

    expect(second.container.textContent).toContain('Not connected — connect Gmail')
    vi.useRealTimers()
    openSpy.mockRestore()
    act(() => second.root.unmount())
  })

  it('still announces the connection when the watcher released the popup first', async () => {
    // The watcher drops the window handle as soon as it stops being observable,
    // which routinely happens before React applies the storage-driven verdict.
    // The announcement has to survive that, so it cannot be gated on the handle.
    vi.useFakeTimers()
    const toastSuccess = vi.spyOn(toast, 'success').mockImplementation(() => '')
    const popup = { focus: vi.fn(), closed: false }
    const openSpy = vi
      .spyOn(window, 'open')
      .mockReturnValue(popup as unknown as ReturnType<typeof window.open>)
    const { container, root } = renderCredentialLink({
      type: 'link',
      provider: 'google-email',
      value:
        'https://sim.test/api/auth/oauth2/authorize?providerId=google-email&callbackURL=https%3A%2F%2Fsim.test%2Fworkspace%2Fworkspace-1%2Fchat%2Fchat-1',
    })

    await act(async () => {
      container
        .querySelector('a')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })
    const attemptId = new URL(
      new URL(openSpy.mock.calls[0][0] as string).searchParams.get('callbackURL') ?? ''
    ).searchParams.get('oauthAttempt') as string

    popup.closed = true
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000)
    })
    await act(async () => {
      setOAuthChatAttemptStatus(attemptId, 'connected')
    })

    expect(toastSuccess).toHaveBeenCalledWith('Gmail connected successfully.')
    vi.useRealTimers()
    openSpy.mockRestore()
    toastSuccess.mockRestore()
    act(() => root.unmount())
  })

  it('focuses the live popup instead of starting a rival attempt on a repeat click', async () => {
    const toastSuccess = vi.spyOn(toast, 'success').mockImplementation(() => '')
    const popup = {
      focus: vi.fn(),
      closed: false,
      // Still on the provider's pages: reading location across origins throws.
      get location(): Location {
        throw new DOMException('cross-origin', 'SecurityError')
      },
    }
    const openSpy = vi
      .spyOn(window, 'open')
      .mockReturnValue(popup as unknown as ReturnType<typeof window.open>)
    const { container, root } = renderCredentialLink({
      type: 'link',
      provider: 'google-email',
      value:
        'https://sim.test/api/auth/oauth2/authorize?providerId=google-email&callbackURL=https%3A%2F%2Fsim.test%2Fworkspace%2Fworkspace-1%2Fchat%2Fchat-1',
    })
    const link = container.querySelector('a')

    await act(async () => {
      link?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })
    const attemptId = new URL(
      new URL(openSpy.mock.calls[0][0] as string).searchParams.get('callbackURL') ?? ''
    ).searchParams.get('oauthAttempt') as string
    await act(async () => {
      link?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })

    // No second window, and no second attempt to strand the first one's verdict.
    expect(openSpy).toHaveBeenCalledOnce()
    expect(popup.focus).toHaveBeenCalledTimes(2)

    await act(async () => {
      setOAuthChatAttemptStatus(attemptId, 'connected')
    })

    expect(container.textContent).toContain('Connected Gmail')
    openSpy.mockRestore()
    toastSuccess.mockRestore()
    act(() => root.unmount())
  })

  it('locks the row once the popup verdict is corroborated by a refetched credential', async () => {
    const toastSuccess = vi.spyOn(toast, 'success').mockImplementation(() => '')
    const popup = { focus: vi.fn(), closed: false }
    const openSpy = vi
      .spyOn(window, 'open')
      .mockReturnValue(popup as unknown as ReturnType<typeof window.open>)
    mockRefetchWorkspaceCredentials.mockResolvedValue({
      data: [{ id: 'new-gmail', providerId: 'google', updatedAt: '2026-08-07T10:05:00Z' }],
    })
    const { container, root } = renderCredentialLink({
      type: 'link',
      provider: 'google-email',
      value:
        'https://sim.test/api/auth/oauth2/authorize?providerId=google-email&callbackURL=https%3A%2F%2Fsim.test%2Fworkspace%2Fworkspace-1%2Fchat%2Fchat-1',
    })

    await act(async () => {
      container
        .querySelector('a')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    })
    const attemptId = new URL(
      new URL(openSpy.mock.calls[0][0] as string).searchParams.get('callbackURL') ?? ''
    ).searchParams.get('oauthAttempt') as string
    await act(async () => {
      setOAuthChatAttemptStatus(attemptId, 'connected')
    })

    // The popup flow never blurs this tab, so this refetch is the only one that
    // can corroborate the verdict and let the control lock.
    expect(mockRefetchWorkspaceCredentials).toHaveBeenCalled()
    expect(container.textContent).toContain('Connected Gmail')
    expect(container.querySelector('a')?.getAttribute('aria-disabled')).toBe('true')
    openSpy.mockRestore()
    toastSuccess.mockRestore()
    act(() => root.unmount())
  })

  it('navigates the tab through the same completion page when the popup is blocked', () => {
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(null)
    const { container, root } = renderCredentialLink({
      type: 'link',
      provider: 'google-email',
      value:
        'https://sim.test/api/auth/oauth2/authorize?providerId=google-email&callbackURL=https%3A%2F%2Fsim.test%2Fworkspace%2Fworkspace-1%2Fchat%2Fchat-1',
    })

    const link = container.querySelector('a')
    const defaultPrevented = !link?.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true })
    )

    expect(defaultPrevented).toBe(false)
    const callbackUrl = new URL(
      new URL(link?.getAttribute('href') ?? '').searchParams.get('callbackURL') ?? ''
    )
    expect(callbackUrl.pathname).toBe('/oauth/chat-complete')
    expect(callbackUrl.searchParams.get('oauthAttempt')).not.toBeNull()
    openSpy.mockRestore()
    act(() => root.unmount())
  })

  it('waits for the credential baseline before opening an OAuth link', () => {
    mockUseWorkspaceCredentials.mockReturnValue({
      data: undefined,
      isFetched: false,
      refetch: mockRefetchWorkspaceCredentials,
    })
    const { container, root } = renderCredentialLink({
      type: 'link',
      provider: 'google-email',
      value: 'https://sim.test/api/auth/oauth2/authorize?providerId=google-email',
    })

    const link = container.querySelector('a')
    expect(container.textContent).toContain('Checking Gmail connections')
    expect(link?.getAttribute('aria-disabled')).toBe('true')
    expect(link?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))).toBe(
      false
    )
    act(() => root.unmount())
  })

  it('keeps a sibling row for the same provider clickable when one connects', async () => {
    const existingCredential = {
      id: 'existing-gmail',
      providerId: 'google',
      updatedAt: '2026-08-07T10:00:00Z',
    }
    let credentials = [existingCredential]
    mockUseWorkspaceCredentials.mockImplementation(() => ({
      data: credentials,
      isFetched: true,
      refetch: mockRefetchWorkspaceCredentials,
    }))
    const data: CredentialItemData[] = [
      {
        type: 'link',
        provider: 'google-email',
        value: 'https://sim.test/api/auth/oauth2/authorize?providerId=google-email',
      },
      {
        type: 'link',
        provider: 'google-email',
        value: 'https://sim.test/api/auth/oauth2/authorize?providerId=google-email',
      },
    ]
    const { container, root } = renderCredentialLink(data)

    credentials = [
      existingCredential,
      { id: 'new-gmail', providerId: 'google', updatedAt: '2026-08-07T10:05:00Z' },
    ]
    await act(async () => {
      root.render(<SpecialTags segment={{ type: 'credential', data }} />)
    })

    const rows = container.querySelectorAll('a')
    expect(rows).toHaveLength(2)
    for (const row of rows) {
      expect(row.getAttribute('aria-disabled')).toBe('false')
    }
    act(() => root.unmount())
  })

  it('applies OAuth completion only to the card that launched it', () => {
    const data: CredentialItemData[] = [
      {
        type: 'link',
        provider: 'google-email',
        value: 'https://sim.test/api/auth/oauth2/authorize?providerId=google-email',
      },
    ]
    const attempt = createOAuthChatAttempt({
      workspaceId: 'workspace-1',
      providerId: 'google-email',
      baseProviderId: 'google',
      displayName: 'Gmail',
      controlId: 'message-2:0:0',
      baselineCredentialIds: [],
    })
    window.history.replaceState({}, '', `?oauthAttempt=${attempt.id}`)
    const container = document.createElement('div')
    const root: Root = createRoot(container)

    act(() => {
      root.render(
        <>
          <SpecialTags segment={{ type: 'credential', data }} interactionId='message-1:0' />
          <SpecialTags segment={{ type: 'credential', data }} interactionId='message-2:0' />
        </>
      )
      setOAuthChatAttemptStatus(attempt.id, 'connected')
    })

    expect(container.textContent?.match(/Connected Gmail/g)).toHaveLength(1)
    expect(container.textContent?.match(/Connect Gmail/g)).toHaveLength(1)
    act(() => root.unmount())
  })

  it('renders nothing when the user cannot edit, regardless of URL safety', () => {
    mockUseUserPermissionsContext.mockReturnValue({ canEdit: false })
    const { container, root } = renderCredentialLink({
      type: 'link',
      provider: 'github',
      value: 'https://github.com/login/oauth/authorize',
    })

    expect(container.querySelector('a')).toBeNull()
    expect(container.textContent).toBe('')
    act(() => root.unmount())
  })

  it('keeps canonical secret indexes when permission filtering hides a workspace row', async () => {
    mockUseUserPermissionsContext.mockReturnValue({ canEdit: false })
    const container = document.createElement('div')
    const root = createRoot(container)
    const onOptionSelect = vi.fn()
    const data: CredentialItemData[] = [
      { type: 'secret_input', name: 'WORKSPACE_KEY', scope: 'workspace' },
      { type: 'secret_input', name: 'PERSONAL_KEY', scope: 'personal' },
    ]

    act(() => {
      root.render(
        <SpecialTags segment={{ type: 'credential', data }} onOptionSelect={onOptionSelect} />
      )
    })

    const input = container.querySelector('input')
    expect(input?.getAttribute('placeholder')).toBe('Paste PERSONAL_KEY')
    act(() => {
      if (!input) return
      const valueSetter = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value'
      )?.set
      valueSetter?.call(input, 'personal-secret')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    const submitButton = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Submit'
    )
    await act(async () => submitButton?.click())

    expect(mockSavePersonalEnvironment).toHaveBeenCalledWith({
      variables: { PERSONAL_KEY: 'personal-secret' },
    })
    expect(onOptionSelect).toHaveBeenCalledWith(
      'Credential setup submitted — {"integrations":[],"secrets":[{"name":"WORKSPACE_KEY","status":"skipped"},{"name":"PERSONAL_KEY","status":"saved"}]}'
    )
    act(() => root.unmount())
  })
})

describe('UsageUpgradeDisplay', () => {
  it("shows a job run's own spend cap without an account billing action", () => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    const container = document.createElement('div')
    const root = createRoot(container)
    act(() => {
      root.render(
        <SpecialTags
          segment={{
            type: 'usage_upgrade',
            data: {
              reason: 'job_run_budget',
              action: 'increase_limit',
              message: 'This scheduled job run reached its $5.00 spend limit.',
            },
          }}
        />
      )
    })

    expect(container.querySelector('a')).toBeNull()
    act(() => root.unmount())
  })
})
