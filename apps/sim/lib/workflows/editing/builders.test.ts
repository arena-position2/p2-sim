/**
 * @vitest-environment node
 */
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

const { mockIsIntegrationDeploymentAvailable } = vi.hoisted(() => ({
  mockIsIntegrationDeploymentAvailable: vi.fn(() => true),
}))

vi.mock('@/lib/integrations/availability.server', () => ({
  isIntegrationDeploymentAvailableForVisibility: mockIsIntegrationDeploymentAvailable,
}))

const agentBlockConfig = {
  type: 'agent',
  name: 'Agent',
  outputs: {
    content: { type: 'string', description: 'Default content output' },
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
  api: apiBlockConfig,
  agent: agentBlockConfig,
  condition: conditionBlockConfig,
  knowledge: knowledgeBlockConfig,
  slack: slackBlockConfig,
  image_generator_v2: imageGeneratorV2BlockConfig,
  gmail: gmailBlockConfig,
  gmail_v2: gmailV2BlockConfig,
  schedule: scheduleBlockConfig,
}

vi.mock('@/blocks/registry', () => ({
  getAllBlocks: () => [
    apiBlockConfig,
    agentBlockConfig,
    conditionBlockConfig,
    knowledgeBlockConfig,
    slackBlockConfig,
    imageGeneratorV2BlockConfig,
  ],
  getBlock: (type: string) => blocksByType[type],
}))

describe('createBlockFromParams', () => {
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

  it('selects variable Tool Mode when an agent tool supplies an expression', () => {
    const block = createBlockFromParams('b-agent', {
      type: 'agent',
      name: 'Agent',
      inputs: {
        tools: [
          {
            type: 'custom-tool',
            customToolId: 'custom-1',
            usageControlExpression: '<route.toolMode>',
          },
        ],
      },
    })

    expect(block.data.canonicalModes['0:agentToolUsageControl']).toBe('advanced')
  })

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

  it('uses lowercase titles for default condition branches', () => {
    const block = createBlockFromParams('condition-1', {
      type: 'condition',
      name: 'Condition 1',
      triggerMode: false,
    })

    const conditions = JSON.parse(block.subBlocks.conditions.value)
    expect(conditions.map(({ title }: { title: string }) => title)).toEqual(['if', 'else'])
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

  it('defaults a custom tool reference without either permission field to Auto', () => {
    expect(normalizeTools([{ type: 'custom-tool', customToolId: 'custom-1' }])[0]).toMatchObject({
      usageControl: 'auto',
      usageControlExpression: undefined,
    })
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

  it('accepts a JSON string as input and still returns a string', () => {
    const result = normalizeSubblockValue('tagFilters', JSON.stringify([{ tagName: 'Department' }]))

    expect(typeof result).toBe('string')
    expect(JSON.parse(result as string)[0].tagName).toBe('Department')
  })

  it('leaves array-with-id subblocks that are not string-serialized as raw arrays', () => {
    const result = normalizeSubblockValue('inputFormat', [{ id: 'x', name: 'field' }])

    expect(Array.isArray(result)).toBe(true)
  })

  it('passes through subblock keys that need no normalization', () => {
    expect(normalizeSubblockValue('systemPrompt', 'hello')).toBe('hello')
  })

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

  it('keeps the existing entry metadata when the key already exists', () => {
    const block = {
      id: 'b1',
      type: 'slack',
      subBlocks: {
        channel: { id: 'channel', type: 'channel-selector', value: 'C-old' },
      } as Record<string, { id: string; type: string; value: unknown }>,
    }

    applyTriggerConfigToBlockSubblocks(block, { channel: 'C-new' })

    expect(block.subBlocks.channel).toEqual({
      id: 'channel',
      type: 'channel-selector',
      value: 'C-new',
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

  it('keeps configured numbers when retry is switched off', () => {
    const existing = { enabled: true, maxTries: 5, waitBetweenTriesMs: 250 }
    expect(resolveBlockRetryUpdate({ enabled: false }, existing)).toEqual({
      enabled: false,
      maxTries: 5,
      waitBetweenTriesMs: 250,
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

  it('clears the policy when null is sent', () => {
    const block: Record<string, unknown> = {
      type: 'agent',
      retry: { enabled: true, maxTries: 3, waitBetweenTriesMs: 1000 },
    }
    applyBlockRetry(block, null, { operationType: 'edit', blockId: 'b1' })
    expect(block.retry).toBeUndefined()
  })
})
