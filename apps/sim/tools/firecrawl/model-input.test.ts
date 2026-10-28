import { describe, expect, it } from 'vitest'
import { RESOLVED_SECRET_PROVENANCE_FIELD } from '@/lib/execution/private-tool-metadata'
import { firecrawlParseInputSchema } from '@/lib/internal/firecrawl/schema'
import { ResolvedSecretTraceRegistry } from '@/executor/utils/resolved-secret-trace-registry'
import {
  applyFirecrawlFormatModelInput,
  applyFirecrawlScrapeOptionsModelInput,
  hasFirecrawlModelInputFormat,
  hasFirecrawlParseModelInput,
  selectFirecrawlFormatModelInput,
  selectFirecrawlScrapeOptionsModelInput,
} from '@/tools/firecrawl/model-input'
import { scrapeTool } from '@/tools/firecrawl/scrape'
import type { FirecrawlFormat, ScrapeOptions } from '@/tools/firecrawl/types'
import { projectToolModelInputParams } from '@/tools/request-transport'

describe('Firecrawl nested model input', () => {
  it('retains the private provenance envelope at the internal operation boundary', () => {
    const provenance = { version: 1 as const, complete: true, entries: [] }
    const parsed = firecrawlParseInputSchema.parse({
      apiKey: 'key',
      file: { key: 'file-key', name: 'report.pdf', size: 1 },
      [RESOLVED_SECRET_PROVENANCE_FIELD]: provenance,
    })

    expect(parsed[RESOLVED_SECRET_PROVENANCE_FIELD]).toStrictEqual(provenance)
  })

  it('selects only documented model instructions and schemas', () => {
    const formats: FirecrawlFormat[] = [
      'markdown',
      {
        type: 'json',
        prompt: 'extract pricing',
        schema: { type: 'object', description: 'pricing shape' },
        unrelated: 'transport-control',
      },
      { type: 'question', question: 'What changed?', quality: 80 },
      {
        type: 'changeTracking',
        prompt: 'summarize changes',
        schema: { type: 'object' },
        tag: 'release',
      },
      { type: 'screenshot', prompt: 'not-model-input', fullPage: true },
    ]

    expect(selectFirecrawlFormatModelInput(formats)).toStrictEqual([
      {},
      { prompt: 'extract pricing', schema: { type: 'object', description: 'pricing shape' } },
      { question: 'What changed?' },
      { prompt: 'summarize changes', schema: { type: 'object' } },
      {},
    ])
  })

  it('reapplies projected leaves without changing format controls or scrape options', () => {
    const original: ScrapeOptions = {
      formats: [
        {
          type: 'json',
          prompt: 'secret',
          schema: { type: 'object', description: 'secret' },
          unrelated: 'secret',
        },
        { type: 'screenshot', prompt: 'secret', fullPage: true },
      ],
      headers: { Authorization: 'secret' },
      onlyMainContent: true,
    }
    const projected = {
      formats: [
        {
          prompt: '{{SECRET}}',
          schema: { type: 'object', description: '{{SECRET}}' },
        },
        {},
      ],
    }

    expect(selectFirecrawlScrapeOptionsModelInput(original)).toStrictEqual({
      formats: [{ prompt: 'secret', schema: { type: 'object', description: 'secret' } }, {}],
    })
    expect(applyFirecrawlScrapeOptionsModelInput(original, projected)).toStrictEqual({
      formats: [
        {
          type: 'json',
          prompt: '{{SECRET}}',
          schema: { type: 'object', description: '{{SECRET}}' },
          unrelated: 'secret',
        },
        { type: 'screenshot', prompt: 'secret', fullPage: true },
      ],
      headers: { Authorization: 'secret' },
      onlyMainContent: true,
    })
    expect(original.formats?.[0]).toStrictEqual({
      type: 'json',
      prompt: 'secret',
      schema: { type: 'object', description: 'secret' },
      unrelated: 'secret',
    })
  })

  it('rejects projected arrays that do not preserve the original shape', () => {
    expect(() => applyFirecrawlFormatModelInput([{ type: 'json', prompt: 'extract' }], [])).toThrow(
      'Projected Firecrawl formats do not match the original formats'
    )
  })

  it('recognizes every Firecrawl format that invokes a model', () => {
    expect(hasFirecrawlModelInputFormat(['markdown', 'summary'])).toBe(true)
    expect(hasFirecrawlModelInputFormat([{ type: 'summary' }])).toBe(true)
    expect(hasFirecrawlModelInputFormat(['markdown', 'html'])).toBe(false)
  })

  it('gates parse file provenance on generation and effective PDF parser mode', () => {
    const pdf = { name: 'report.pdf', size: 1, type: 'application/pdf' }
    const docx = {
      name: 'report.docx',
      size: 1,
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    }

    expect(hasFirecrawlParseModelInput({ file: docx, formats: ['markdown'] })).toBe(false)
    expect(hasFirecrawlParseModelInput({ file: pdf, formats: ['markdown'] })).toBe(true)
    expect(
      hasFirecrawlParseModelInput({
        file: pdf,
        formats: ['markdown'],
        parsers: [{ type: 'pdf', mode: 'fast' }],
      })
    ).toBe(false)
    expect(
      hasFirecrawlParseModelInput({
        file: docx,
        formats: ['markdown'],
        parsers: [{ type: 'pdf', mode: 'ocr' }],
      })
    ).toBe(true)
    expect(
      hasFirecrawlParseModelInput({
        file: docx,
        formats: ['summary'],
        parsers: [{ type: 'pdf', mode: 'fast' }],
      })
    ).toBe(true)
  })

  it('ignores non-array format values instead of treating them as model input', () => {
    expect(selectFirecrawlFormatModelInput('markdown' as never)).toBeUndefined()
    expect(
      selectFirecrawlScrapeOptionsModelInput({
        formats: 'markdown' as never,
        onlyMainContent: true,
      })
    ).toStrictEqual({})
    expect(applyFirecrawlFormatModelInput('markdown', undefined)).toBe('markdown')
    expect(
      applyFirecrawlScrapeOptionsModelInput(
        { formats: 'markdown' as never, onlyMainContent: true },
        {}
      )
    ).toStrictEqual({ formats: 'markdown', onlyMainContent: true })
  })

  it('projects Firecrawl scrape block params with string formats', () => {
    const registry = new ResolvedSecretTraceRegistry()
    const params = {
      url: 'https://example.com',
      formats: ['markdown', 'html'],
      apiKey: 'fc-key',
      onlyMainContent: true,
      timeout: 60000,
    }

    expect(projectToolModelInputParams(scrapeTool, params, registry)).toEqual(params)
  })

  it('projects Firecrawl scrape from top-level formats when scrapeOptions is also present', () => {
    const registry = new ResolvedSecretTraceRegistry()
    const params = {
      url: 'https://example.com',
      formats: ['markdown'],
      scrapeOptions: { formats: 'markdown', headers: { Authorization: 'secret' } },
      apiKey: 'fc-key',
    }

    expect(projectToolModelInputParams(scrapeTool, params, registry)).toEqual(params)
  })
})
