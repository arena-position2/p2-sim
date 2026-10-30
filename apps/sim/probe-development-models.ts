/**
 * Probes the exact Anthropic request shape used by the Development block generator
 * (model id + structured outputs beta + max_tokens) with a tiny prompt.
 * Delete after verification.
 */
// biome-ignore-all lint/suspicious/noConsole: one-off CLI probe prints pass/fail to the terminal
import Anthropic from '@anthropic-ai/sdk'
import { transformJSONSchema } from '@anthropic-ai/sdk/lib/transform-json-schema'

const apiKey = process.env.ANTHROPIC_API_KEY
if (!apiKey) {
  process.stderr.write('ANTHROPIC_API_KEY missing\n')
  process.exit(1)
}

const anthropic = new Anthropic({
  apiKey,
  defaultHeaders: { 'anthropic-beta': 'structured-outputs-2025-11-13' },
})

const schema = {
  type: 'object',
  properties: { ok: { type: 'boolean' } },
  required: ['ok'],
  additionalProperties: false,
}

const candidates: Array<{ model: string; maxTokens: number }> = [
  { model: 'claude-fable-5', maxTokens: 128_000 },
  { model: 'claude-opus-4-8', maxTokens: 128_000 },
  { model: 'claude-sonnet-4-6', maxTokens: 64_000 },
]

for (const { model, maxTokens } of candidates) {
  try {
    const stream = anthropic.messages.stream({
      model,
      max_tokens: maxTokens,
      messages: [{ role: 'user', content: 'Reply with {"ok": true}' }],
      output_config: {
        format: { type: 'json_schema', schema: transformJSONSchema(schema) },
      },
    })
    const message = await stream.finalMessage()
    const text = message.content.find((b) => b.type === 'text')
    process.stdout.write(
      `[PASS] ${model} (max_tokens=${maxTokens}) -> ${text?.type === 'text' ? text.text : '<no text>'}\n`
    )
  } catch (error) {
    const err = error as { status?: number; message?: string }
    process.stdout.write(
      `[FAIL] ${model} (max_tokens=${maxTokens}) -> status=${err.status} ${err.message}\n`
    )
  }
}
