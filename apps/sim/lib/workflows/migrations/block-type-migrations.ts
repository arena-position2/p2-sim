import { createLogger } from '@sim/logger'
import type { BlockState, SubBlockState } from '@/stores/workflows/workflow/types'

const logger = createLogger('BlockTypeMigrations')

const OPENAI_MODEL_ALIASES: Record<string, string> = {
  'dall-e-3': 'gpt-image-1.5',
}

function getSubBlockValue(block: BlockState, id: string): unknown {
  return block.subBlocks?.[id]?.value
}

function getSubBlockType(block: BlockState, id: string): string {
  const type = block.subBlocks?.[id]?.type
  return typeof type === 'string' && type.length > 0 ? type : 'long-input'
}

function setSubBlockValue(block: BlockState, id: string, value: unknown): BlockState {
  const existing = block.subBlocks?.[id]
  return {
    ...block,
    subBlocks: {
      ...block.subBlocks,
      [id]: {
        id,
        type: (existing?.type ?? getSubBlockType(block, id)) as SubBlockState['type'],
        value: value as SubBlockState['value'],
      },
    },
  }
}

function resolveProviderFromModel(model: string): 'openai' | 'gemini' {
  if (model.startsWith('gemini-') || model.startsWith('imagen-')) {
    return 'gemini'
  }
  return 'openai'
}

function mapOpenAIModel(model: string): string {
  return OPENAI_MODEL_ALIASES[model] ?? model
}

function migrateImageGeneratorBlock(block: BlockState): BlockState {
  const rawModel = String(getSubBlockValue(block, 'model') ?? 'gpt-image-1.5')
  const provider = resolveProviderFromModel(rawModel)
  const model = provider === 'openai' ? mapOpenAIModel(rawModel) : rawModel

  let migrated: BlockState = {
    ...block,
    type: 'image_generator_v2',
  }

  migrated = setSubBlockValue(migrated, 'provider', provider)
  migrated = setSubBlockValue(migrated, 'model', model)

  const imageSize = getSubBlockValue(block, 'imageSize')
  if (provider === 'gemini' && imageSize) {
    migrated = setSubBlockValue(migrated, 'resolution', imageSize)
  }

  return migrated
}

/**
 * Migrates deprecated block types to their current replacements in saved workflows.
 */
export function migrateBlockTypes(blocks: Record<string, BlockState>): {
  blocks: Record<string, BlockState>
  migrated: boolean
} {
  let anyMigrated = false
  const result: Record<string, BlockState> = {}

  for (const [blockId, block] of Object.entries(blocks)) {
    if (block.type === 'image_generator') {
      anyMigrated = true
      const migratedBlock = migrateImageGeneratorBlock(block)
      logger.info('Migrated legacy image generator block', {
        blockId,
        fromType: block.type,
        toType: migratedBlock.type,
        model: getSubBlockValue(migratedBlock, 'model'),
        provider: getSubBlockValue(migratedBlock, 'provider'),
      })
      result[blockId] = migratedBlock
      continue
    }

    result[blockId] = block
  }

  return { blocks: result, migrated: anyMigrated }
}
