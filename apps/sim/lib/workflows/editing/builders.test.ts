import {
  integrationsAvailabilityMock,
  integrationsAvailabilityMockFns,
} from '@sim/testing/mocks/integrations-availability.mock'
import { generateId } from '@sim/utils/id'
import type { Mock } from 'vitest'
import { describe, expect, it, vi } from 'vitest'
import {
  IMAGE_GENERATOR_DEFAULT_MODEL,
  IMAGE_GENERATOR_DEFAULT_PROVIDER,
} from '@/lib/image-generation/block-model-config'
import { DEFAULT_PERMISSION_GROUP_CONFIG } from '@/lib/permission-groups/fields'
import {
  applyBlockRetry,
  applyTriggerConfigToBlockSubblocks,
  createBlockFromParams,
  filterDisallowedTools,
  normalizeSubblockValue,
  normalizeTools,
  resolveBlockRetryUpdate,
} from '@/lib/workflows/editing/builders'
import type { SkippedItem } from '@/lib/workflows/editing/types'
import { TailscaleBlock } from '@/blocks/blocks/tailscale'
import { getAllBlocks, getBlock } from '@/blocks/registry'
import { prepareBlockState } from '@/stores/workflows/prepare-block-state'
import type { BlockState } from '@/stores/workflows/workflow/types'
import { tailscaleAuthorizeDeviceTool, tailscaleCreateAuthKeyTool } from '@/tools/tailscale'

const mockIsIntegrationDeploymentAvailable =
  integrationsAvailabilityMockFns.mockIsIntegrationDeploymentAvailableForVisibility

const mockGetAllBlocks = getAllBlocks as Mock
const mockGetBlock = getBlock as Mock
mockGetAllBlocks.mockImplementation(() => [
  apiBlockConfig,
  agentBlockConfig,
  conditionBlockConfig,
  knowledgeBlockConfig,
  slackBlockConfig,
  webhookBlockConfig,
  gatedOperationBlockConfig,
  imageGeneratorV2BlockConfig,
])
mockGetBlock.mockImplementation((type: string) => blocksByType[type])

vi.mock('@/lib/integrations/availability.server', () => integrationsAvailabilityMock)

const agentBlockConfig = {
  type: 'agent',
  name: 'Agent',
  outputs: {
    content: { type: 'string', description: 'Default content output' },
    interactionId: {
      type: 'string',
      condition: { field: 'model', value: ['deep-research-pro-preview-12-2025'] },
    },
  },
  subBlocks: [
    { id: 'model', type: 'combobox', defaultValue: 'gpt-5' },
    { id: 'responseFormat', type: 'response-format' },
    { id: 'tools', type: 'tool-input' },
  ],
}

const conditionBlockConfig = {
  type: 'condition',
  name: 'Condition',
  outputs: {},
  subBlocks: [{ id: 'conditions', type: 'condition-input' }],
}

const knowledgeBlockConfig = {
  type: 'knowledge',
  name: 'Knowledge',
  outputs: {},
  subBlocks: [
    { id: 'tagFilters', type: 'knowledge-tag-filters' },
    { id: 'documentTags', type: 'document-tag-entry' },
  ],
}

const slackBlockConfig = {
  type: 'slack',
  name: 'Slack',
  outputs: {},
  subBlocks: [{ id: 'channel', type: 'channel-selector' }],
}

const apiBlockConfig = {
  type: 'api',
  name: 'API',
  outputs: {},
  subBlocks: [
    {
      id: 'redirectPolicyVersion',
      type: 'short-input',
      hidden: true,
      defaultValue: 'standard-v1',
    },
    {
      id: 'sendCredentialsOnCrossOriginRedirect',
      type: 'switch',
      defaultValue: true,
    },
  ],
}

/** Mirrors generic_webhook: the token is pre-filled by a thunk, the URL is display-only. */
const webhookBlockConfig = {
  type: 'generic_webhook',
  name: 'Webhook Trigger',
  category: 'triggers',
  outputs: {},
  subBlocks: [
    { id: 'webhookUrlDisplay', type: 'short-input', readOnly: true, value: () => 'display-only' },
    { id: 'requireAuth', type: 'switch', defaultValue: true },
    { id: 'token', type: 'short-input', password: true, value: () => generateId() },
    { id: 'signingSecret', type: 'short-input', hidden: true, value: () => 'run-time-only' },
  ],
}

/** An operation dropdown pre-filled by a thunk, so the seed meets the permission gate. */
const gatedOperationBlockConfig = {
  type: 'gated',
  name: 'Gated',
  outputs: {},
  subBlocks: [
    {
      id: 'operation',
      type: 'dropdown',
      options: [
        { label: 'Canvas', id: 'canvas' },
        { label: 'Send', id: 'send' },
      ],
      value: () => 'canvas',
    },
  ],
  tools: {
    access: ['gated_canvas', 'gated_send'],
    config: {
      tool: ({ operation }: { operation?: string }) =>
        operation === 'canvas' ? 'gated_canvas' : 'gated_send',
    },
  },
}

const imageGeneratorV2BlockConfig = {
  type: 'image_generator_v2',
  name: 'Image Generator',
  outputs: {},
  subBlocks: [
    { id: 'provider', type: 'combobox', defaultValue: IMAGE_GENERATOR_DEFAULT_PROVIDER },
    { id: 'model', type: 'combobox', defaultValue: IMAGE_GENERATOR_DEFAULT_MODEL },
    { id: 'prompt', type: 'long-input' },
  ],
}

const gmailBlockConfig = {
  type: 'gmail',
  name: 'Gmail (Legacy)',
  hideFromToolbar: true,
  sunset: { status: 'legacy', replacedBy: 'gmail_v2' },
  outputs: {},
  subBlocks: [],
}

const gmailV2BlockConfig = {
  type: 'gmail_v2',
  name: 'Gmail',
  outputs: {},
  subBlocks: [{ id: 'operation', type: 'dropdown' }],
}

const scheduleBlockConfig = {
  type: 'schedule',
  name: 'Schedule',
  category: 'triggers',
  outputs: {},
  subBlocks: [
    { id: 'scheduleType', type: 'dropdown', mode: 'trigger' },
    { id: 'dailyTime', type: 'time-input', mode: 'trigger' },
    { id: 'timezone', type: 'dropdown', mode: 'trigger' },
  ],
}

const blocksByType: Record<string, unknown> = {
  tailscale: TailscaleBlock,
  api: apiBlockConfig,
  agent: agentBlockConfig,
  mothership: {
    ...agentBlockConfig,
    type: 'mothership',
    subBlocks: agentBlockConfig.subBlocks.map((subBlock) =>
      subBlock.id === 'model' ? { ...subBlock, defaultValue: 'claude-sonnet-5-5' } : subBlock
    ),
  },
  condition: conditionBlockConfig,
  knowledge: knowledgeBlockConfig,
  slack: slackBlockConfig,
  generic_webhook: webhookBlockConfig,
  gated: gatedOperationBlockConfig,
  image_generator_v2: imageGeneratorV2BlockConfig,
  gmail: gmailBlockConfig,
  gmail_v2: gmailV2BlockConfig,
  schedule: scheduleBlockConfig,
}

describe('createBlockFromParams', () => {
  it.each([
    [{}, true],
    [{ authorized: false }, false],
  ] as const)(
    'preserves authorization intent from API block creation through the provider request for %j',
    (provided, expected) => {
      const block: BlockState = createBlockFromParams('device-authorization', {
        type: 'tailscale',
        name: 'Device authorization',
        inputs: {
          operation: 'authorize_device',
          apiKey: 'test-token',
          deviceId: 'device',
          ...provided,
        },
      })
      const values = Object.fromEntries(
        Object.entries(block.subBlocks).map(([id, field]) => [id, field.value])
      )
      const resolved = TailscaleBlock.tools?.config?.params?.(values)
      if (!resolved || typeof resolved.authorized !== 'boolean') {
        throw new Error('Authorization did not resolve to a boolean')
      }
      const body = tailscaleAuthorizeDeviceTool.request.body?.({
        apiKey: 'test-token',
        deviceId: 'device',
        authorized: resolved.authorized,
      })
      expect(body).toEqual({ authorized: expected })
    }
  )

  it('treats a null runtime switch as unset while preserving explicit false', () => {
    const transform = TailscaleBlock.tools?.config?.params
    if (!transform) throw new Error('Tailscale has no parameter transform')
    expect(transform({ operation: 'authorize_device', authorized: null })).toMatchObject({
      authorized: true,
    })
    expect(transform({ operation: 'authorize_device', authorized: 'false' })).toMatchObject({
      authorized: false,
    })
  })

  it('rejects an invalid authorization value before a provider request can change access', () => {
    const transform = TailscaleBlock.tools?.config?.params
    if (!transform) throw new Error('Tailscale has no parameter transform')
    expect(() => transform({ operation: 'authorize_device', authorized: 'invalid' })).toThrow()
  })

  it('keeps dormant values from blocking the selected operation', () => {
    const transform = TailscaleBlock.tools?.config?.params
    if (!transform) throw new Error('Tailscale has no parameter transform')
    expect(
      transform({
        operation: 'authorize_device',
        authorized: false,
        reusable: 'inactive value',
        expirySeconds: 'inactive value',
      })
    ).toMatchObject({ authorized: false })
  })

  it.each(['', '   ', null, undefined])(
    'omits cleared auth-key expiry %j so the provider default applies',
    (expirySeconds) => {
      const transform = TailscaleBlock.tools?.config?.params
      if (!transform) throw new Error('Tailscale has no parameter transform')
      const body = tailscaleCreateAuthKeyTool.request.body?.({
        apiKey: 'test-token',
        tailnet: '-',
        ...transform({ operation: 'create_auth_key', expirySeconds }),
      })
      expect(JSON.stringify(body)).not.toContain('"expirySeconds"')
    }
  )

  it('exposes the output ports of the seeded Agent default', () => {
    const block = createBlockFromParams(
      'agent-research-default',
      { type: 'agent', name: 'Agent' },
      undefined,
      undefined,
      {
        ...DEFAULT_PERMISSION_GROUP_CONFIG,
        defaultAgentModel: 'deep-research-pro-preview-12-2025',
      }
    )
    expect(block.outputs.interactionId).toEqual({ type: 'string' })
  })
  it('uses the group Agent default when creating an Agent without an explicit model', () => {
    const config = { ...DEFAULT_PERMISSION_GROUP_CONFIG, defaultAgentModel: 'gpt-4o' }
    const block = createBlockFromParams(
      'agent-default',
      { type: 'agent', name: 'Agent' },
      undefined,
      undefined,
      config
    )
    expect(block.subBlocks.model.value).toBe('gpt-4o')
  })

  it('preserves an explicitly selected model instead of applying the group Agent default', () => {
    const block = createBlockFromParams(
      'agent-explicit',
      { type: 'agent', name: 'Agent', inputs: { model: 'claude-sonnet-5-5' } },
      undefined,
      undefined,
      { ...DEFAULT_PERMISSION_GROUP_CONFIG, defaultAgentModel: 'gpt-4o' }
    )
    expect(block.subBlocks.model.value).toBe('claude-sonnet-5-5')
  })

  it.each([{ deniedModels: ['gpt-4o'] }, { allowedModelProviders: ['anthropic'] }])(
    'does not seed a group Agent default withheld by %j',
    (restrictions) => {
      const block = createBlockFromParams(
        'agent-denied-default',
        { type: 'agent', name: 'Agent' },
        undefined,
        undefined,
        { ...DEFAULT_PERMISSION_GROUP_CONFIG, defaultAgentModel: 'gpt-4o', ...restrictions }
      )
      expect(block.subBlocks.model.value).not.toBe('gpt-4o')
    }
  )

  it('uses the Agent default on canvas creation without changing other model-backed blocks', () => {
    const options = {
      id: 'canvas-default',
      name: 'Agent',
      position: { x: 0, y: 0 },
      agentDefaultModel: 'gpt-4o',
    }
    expect(prepareBlockState({ ...options, type: 'agent' }).subBlocks.model.value).toBe('gpt-4o')
    expect(prepareBlockState({ ...options, type: 'mothership' }).subBlocks.model.value).toBe(
      'claude-sonnet-5-5'
    )
  })

  it('creates a schedule block in trigger mode so its fields are visible', () => {
    const block = createBlockFromParams('sched-1', {
      type: 'schedule',
      name: 'Daily 9AM IST',
      inputs: {
        scheduleType: 'daily',
        dailyTime: '09:00',
        timezone: 'Asia/Kolkata',
      },
    })

    expect(block.type).toBe('schedule')
    expect(block.triggerMode).toBe(true)
    expect(block.subBlocks.scheduleType.value).toBe('daily')
    expect(block.subBlocks.dailyTime.value).toBe('09:00')
    expect(block.subBlocks.timezone.value).toBe('Asia/Kolkata')
  })

  it('stores the current successor when adding a sunset block type', () => {
    const block = createBlockFromParams('mail-1', {
      type: 'gmail',
      name: 'Gmail',
    })

    expect(block.type).toBe('gmail_v2')
  })

  it('derives agent outputs from responseFormat when outputs are not provided', () => {
    const block = createBlockFromParams('b-agent', {
      type: 'agent',
      name: 'Agent',
      inputs: {
        responseFormat: {
          type: 'object',
          properties: {
            answer: {
              type: 'string',
              description: 'Structured answer text',
            },
          },
          required: ['answer'],
        },
      },
      triggerMode: false,
    })

    expect(block.outputs.answer).toBeDefined()
    expect(block.outputs.answer.type).toBe('string')
  })

  it.each(['agent', 'mothership'])(
    'selects variable Tool Mode when a %s tool supplies an expression',
    (type) => {
      const block = createBlockFromParams('b-agent', {
        type,
        name: 'Agent',
        inputs: {
          tools: [
            {
              type: 'mcp',
              params: { serverId: 'server-1', toolName: 'search' },
              usageControlExpression: '<route.toolMode>',
            },
          ],
        },
      })

      expect(block.data.canonicalModes['0:agentToolUsageControl']).toBe('advanced')
    }
  )

  it('preserves configured subblock types and normalizes condition branch ids', () => {
    const block = createBlockFromParams('condition-1', {
      type: 'condition',
      name: 'Condition 1',
      inputs: {
        conditions: JSON.stringify([
          { id: 'arbitrary-if', title: 'if', value: 'true' },
          { id: 'arbitrary-else', title: 'else', value: '' },
        ]),
      },
      triggerMode: false,
    })

    expect(block.subBlocks.conditions.type).toBe('condition-input')

    const parsed = JSON.parse(block.subBlocks.conditions.value)
    expect(parsed[0].id).toBe('condition-1-if')
    expect(parsed[1].id).toBe('condition-1-else')
  })

  it('persists knowledge tag subblocks as JSON strings, not raw arrays', () => {
    const block = createBlockFromParams('kb-1', {
      type: 'knowledge',
      name: 'Knowledge 1',
      inputs: {
        tagFilters: [{ tagName: 'Department', tagSlot: 'tag1', tagValue: 'it' }],
        documentTags: [{ tagName: 'Team', tagSlot: 'tag2', value: 'infra' }],
      },
      triggerMode: false,
    })

    expect(typeof block.subBlocks.tagFilters.value).toBe('string')
    expect(typeof block.subBlocks.documentTags.value).toBe('string')

    const filters = JSON.parse(block.subBlocks.tagFilters.value)
    expect(filters[0].tagName).toBe('Department')
    expect(filters[0].id).toEqual(expect.any(String))
  })

  it('seeds declared defaults on programmatically created blocks (canvas parity)', () => {
    const block = createBlockFromParams('api-1', {
      type: 'api',
      name: 'API',
      triggerMode: false,
    })

    expect(block.subBlocks.redirectPolicyVersion.value).toBe('standard-v1')
    expect(block.subBlocks.sendCredentialsOnCrossOriginRedirect.value).toBe(true)
  })

  it('seeds Agent model defaultValue when Copilot omits inputs.model', () => {
    const block = createBlockFromParams('agent-1', {
      type: 'agent',
      name: 'My Agent',
      triggerMode: false,
    })

    expect(block.subBlocks.model.value).toBe('gpt-5')
  })

  it('keeps an explicit Agent model from Copilot inputs', () => {
    const block = createBlockFromParams('agent-1', {
      type: 'agent',
      name: 'My Agent',
      inputs: { model: 'claude-sonnet-5' },
      triggerMode: false,
    })

    expect(block.subBlocks.model.value).toBe('claude-sonnet-5')
  })

  it('leaves Agent model empty when the declared default is permission-denied', () => {
    const skippedItems: SkippedItem[] = []
    const block = createBlockFromParams(
      'agent-1',
      {
        type: 'agent',
        name: 'My Agent',
        triggerMode: false,
      },
      undefined,
      undefined,
      {
        ...DEFAULT_PERMISSION_GROUP_CONFIG,
        deniedModels: ['gpt-5'],
      },
      skippedItems
    )

    expect(block.subBlocks.model.value).toBeNull()
    expect(skippedItems.some((item) => item.type === 'model_not_allowed')).toBe(true)
  })

  it('seeds Image Generator provider+model defaults when Copilot omits them', () => {
    const block = createBlockFromParams('image-1', {
      type: 'image_generator_v2',
      name: 'Image Generator',
      triggerMode: false,
    })

    expect(block.subBlocks.provider.value).toBe(IMAGE_GENERATOR_DEFAULT_PROVIDER)
    expect(block.subBlocks.model.value).toBe(IMAGE_GENERATOR_DEFAULT_MODEL)
  })

  it('keeps explicit Image Generator provider/model from Copilot inputs', () => {
    const block = createBlockFromParams('image-1', {
      type: 'image_generator_v2',
      name: 'Image Generator',
      inputs: { provider: 'openai', model: 'gpt-image-2' },
      triggerMode: false,
    })

    expect(block.subBlocks.provider.value).toBe('openai')
    expect(block.subBlocks.model.value).toBe('gpt-image-2')
  })

  it('clears Image Generator provider+model together when the default model is denied', () => {
    const skippedItems: SkippedItem[] = []
    const block = createBlockFromParams(
      'image-1',
      {
        type: 'image_generator_v2',
        name: 'Image Generator',
        triggerMode: false,
      },
      undefined,
      undefined,
      {
        ...DEFAULT_PERMISSION_GROUP_CONFIG,
        deniedModels: [IMAGE_GENERATOR_DEFAULT_MODEL],
      },
      skippedItems
    )

    expect(block.subBlocks.provider.value).toBeNull()
    expect(block.subBlocks.model.value).toBeNull()
    expect(skippedItems.some((item) => item.type === 'model_not_allowed')).toBe(true)
  })

  /**
   * The editor pre-fills a webhook trigger's token from its `value()` thunk;
   * without the same seeding here a trigger added over the API deployed with
   * `token: null` and was refused as "authentication enabled but no token".
   */
  it('seeds editor defaults from value() thunks so an API-added webhook trigger has a token', () => {
    const block = createBlockFromParams('hook-1', {
      type: 'generic_webhook',
      name: 'Webhook',
      triggerMode: true,
    })

    expect(block.subBlocks.token.value).toEqual(expect.any(String))
    expect(block.subBlocks.token.value).not.toBe('')
    expect(block.subBlocks.webhookUrlDisplay.value).toBeNull()
    expect(block.subBlocks.signingSecret.value).toBeNull()
    expect(block.subBlocks.requireAuth.value).toBe(true)
  })

  it('never overrides an explicit input with a seeded default', () => {
    const explicit = createBlockFromParams('hook-1', {
      type: 'generic_webhook',
      name: 'Webhook',
      inputs: { token: 'my-token' },
    })
    const cleared = createBlockFromParams('hook-2', {
      type: 'generic_webhook',
      name: 'Webhook',
      inputs: { token: null },
    })

    expect(explicit.subBlocks.token.value).toBe('my-token')
    expect(cleared.subBlocks.token.value).toBeNull()
  })

  it('withholds a seeded operation the permission group denies without recording a skip', () => {
    const skippedItems: SkippedItem[] = []
    const denyCanvas = { ...DEFAULT_PERMISSION_GROUP_CONFIG, deniedTools: ['gated_canvas'] }

    const denied = createBlockFromParams(
      'g-1',
      { type: 'gated', name: 'Gated' },
      undefined,
      undefined,
      denyCanvas,
      skippedItems
    )
    const allowed = createBlockFromParams(
      'g-2',
      { type: 'gated', name: 'Gated' },
      undefined,
      undefined,
      DEFAULT_PERMISSION_GROUP_CONFIG,
      skippedItems
    )

    expect(denied.subBlocks.operation.value).toBeNull()
    expect(allowed.subBlocks.operation.value).toBe('canvas')
    expect(skippedItems).toEqual([])
  })
})

describe('filterDisallowedTools', () => {
  it('assigns canonical tool modes after removing disallowed tools', () => {
    const block = createBlockFromParams(
      'agent-1',
      {
        type: 'agent',
        name: 'Agent',
        inputs: {
          tools: [
            {
              type: 'mcp',
              params: { serverId: 'server-1', toolName: 'search' },
              usageControl: 'auto',
            },
            {
              type: 'custom-tool',
              customToolId: 'custom-1',
              usageControlExpression: '<route.toolMode>',
            },
          ],
        },
      },
      undefined,
      undefined,
      { ...DEFAULT_PERMISSION_GROUP_CONFIG, disableMcpTools: true }
    )

    expect(block.subBlocks.tools.value).toEqual([
      expect.objectContaining({ customToolId: 'custom-1' }),
    ])
    expect(block.data.canonicalModes).toEqual({ '0:agentToolUsageControl': 'advanced' })
  })

  it('removes unavailable integration tools even without a permission group', () => {
    mockIsIntegrationDeploymentAvailable.mockImplementation((type: string) => type !== 'slack')
    const skippedItems: Parameters<typeof filterDisallowedTools>[3] = []

    const tools = filterDisallowedTools(
      [{ type: 'slack' }, { type: 'custom-tool', customToolId: 'custom-1' }],
      null,
      'agent-1',
      skippedItems
    )

    expect(tools).toEqual([{ type: 'custom-tool', customToolId: 'custom-1' }])
    expect(skippedItems[0]?.reason).toContain('unavailable in this deployment')
  })
})

describe('normalizeTools', () => {
  it('preserves a custom tool variable-backed usage mode', () => {
    expect(
      normalizeTools([
        {
          type: 'custom-tool',
          customToolId: 'custom-1',
          usageControl: 'auto',
          usageControlExpression: '<route.toolMode>',
        },
      ])
    ).toEqual([
      {
        type: 'custom-tool',
        customToolId: 'custom-1',
        usageControl: 'auto',
        usageControlExpression: '<route.toolMode>',
        isExpanded: true,
      },
    ])
  })
})

describe('normalizeSubblockValue', () => {
  it.each(['tagFilters', 'documentTags', 'conditions', 'routes'])(
    'serializes %s to a JSON string the subblock component can parse',
    (key) => {
      const result = normalizeSubblockValue(key, [{ id: 'not-a-uuid', title: 'a' }])

      expect(typeof result).toBe('string')
      expect(JSON.parse(result as string)[0].title).toBe('a')
    }
  )

  // Validation treats null as an explicit clear. Coercing it to "[]" would persist a value
  // where the caller asked for none, so the agent reads back an empty filter rather than an
  // absent one -- the same absent-vs-empty ambiguity that caused the original data loss.
  it.each(['tagFilters', 'documentTags', 'conditions', 'routes'])(
    'passes a null %s through as a clear rather than serializing it to "[]"',
    (key) => {
      expect(normalizeSubblockValue(key, null)).toBeNull()
      expect(normalizeSubblockValue(key, undefined)).toBeUndefined()
    }
  )

  it('still serializes an explicitly empty array, which clears the field with a value', () => {
    expect(normalizeSubblockValue('tagFilters', [])).toBe('[]')
  })

  it('replaces non-uuid ids so copilot-authored rows match UI-created ones', () => {
    const result = normalizeSubblockValue('tagFilters', [{ id: 'filter-1', tagName: 'Department' }])

    expect(JSON.parse(result as string)[0].id).not.toBe('filter-1')
  })
})

describe('applyTriggerConfigToBlockSubblocks', () => {
  it('uses the registry type for declared keys and short-input only for undeclared keys', () => {
    const block = { id: 'b1', type: 'slack', subBlocks: {} as Record<string, unknown> }

    applyTriggerConfigToBlockSubblocks(block, { channel: 'C123', customField: 'x' })

    expect(block.subBlocks.channel).toEqual({
      id: 'channel',
      type: 'channel-selector',
      value: 'C123',
    })
    expect(block.subBlocks.customField).toEqual({
      id: 'customField',
      type: 'short-input',
      value: 'x',
    })
  })
})

describe('block retry policy', () => {
  it('defaults the numbers when only enabling', () => {
    expect(resolveBlockRetryUpdate({ enabled: true }, undefined)).toEqual({
      enabled: true,
      maxTries: 3,
      waitBetweenTriesMs: 1000,
    })
  })

  it('treats numbers alone as an intent to retry', () => {
    expect(resolveBlockRetryUpdate({ maxTries: 4 }, undefined)).toMatchObject({
      enabled: true,
      maxTries: 4,
    })
  })

  it('clamps out-of-range values instead of rejecting them', () => {
    expect(resolveBlockRetryUpdate({ enabled: true, maxTries: 99 }, undefined).maxTries).toBe(5)
    expect(resolveBlockRetryUpdate({ enabled: true, maxTries: 1 }, undefined).maxTries).toBe(2)
    expect(
      resolveBlockRetryUpdate({ enabled: true, waitBetweenTriesMs: 999999 }, undefined)
        .waitBetweenTriesMs
    ).toBe(5000)
  })

  it('applies a policy to an eligible block', () => {
    const block: Record<string, unknown> = { type: 'agent' }
    applyBlockRetry(
      block,
      { enabled: true, maxTries: 4 },
      {
        operationType: 'edit',
        blockId: 'b1',
      }
    )
    expect(block.retry).toMatchObject({ enabled: true, maxTries: 4 })
  })

  it('reports why an ineligible block cannot retry instead of storing dead config', () => {
    const skippedItems: SkippedItem[] = []
    const block: Record<string, unknown> = { type: 'agent', triggerMode: true }

    applyBlockRetry(
      block,
      { enabled: true },
      {
        operationType: 'edit',
        blockId: 'b1',
        skippedItems,
      }
    )

    expect(block.retry).toBeUndefined()
    expect(skippedItems).toHaveLength(1)
    expect(skippedItems[0]).toMatchObject({ type: 'retry_not_supported', blockId: 'b1' })
  })
})
