import { describe, expect, it } from 'vitest'
import {
  DEFAULT_LOCAL_COPILOT_CATALOG_ID,
  isLocalCopilotCatalogId,
  remapLegacyLocalCopilotCatalogId,
  resolveLocalCopilotCatalogId,
  resolveLocalCopilotRequestCatalogId,
} from '@/local-copilot/lib/model-catalog'

describe('local copilot model catalog', () => {
  it('defaults new Local Copilot chats to Claude Fable 5.1', () => {
    expect(DEFAULT_LOCAL_COPILOT_CATALOG_ID).toBe('bedrock-claude-fable-5-1')
  })

  it('removes retired gemini-2.5-pro from the live picker', () => {
    expect(isLocalCopilotCatalogId('gemini-2.5-pro')).toBe(false)
  })

  it('remaps retired gemini-2.5-pro onto Claude Fable 5.1', () => {
    expect(remapLegacyLocalCopilotCatalogId('gemini-2.5-pro')).toBe('bedrock-claude-fable-5-1')
    expect(resolveLocalCopilotCatalogId('gemini-2.5-pro')).toBe('bedrock-claude-fable-5-1')
    expect(resolveLocalCopilotRequestCatalogId('gemini-2.5-pro', 'gemini-3.8-flash')).toBe(
      'bedrock-claude-fable-5-1'
    )
    expect(resolveLocalCopilotRequestCatalogId(null, 'gemini-2.5-pro')).toBe(
      'bedrock-claude-fable-5-1'
    )
    expect(
      resolveLocalCopilotRequestCatalogId('gemini-3.8-flash', 'gemini-3.8-flash', 'gemini-2.5-pro')
    ).toBe('bedrock-claude-fable-5-1')
  })
})
