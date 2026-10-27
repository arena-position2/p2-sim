/**
 * Coerces common model aliases into the canonical generate_image `prompt` field
 * before AJV / local validation.
 */
export function normalizeGenerateImageArgs(args: Record<string, unknown>): Record<string, unknown> {
  const prompt = resolveGenerateImagePrompt(args)
  if (!prompt) return { ...args }
  return { ...args, prompt }
}

/**
 * Accepts common model aliases (`description`, `text`, `query`, nested `args`)
 * for generate_image when the model omits the required `prompt` key.
 */
export function resolveGenerateImagePrompt(args: Record<string, unknown>): string | null {
  const candidates = [
    args.prompt,
    args.description,
    args.text,
    args.query,
    args.content,
    args.caption,
    args.message,
    args.image_prompt,
    args.imagePrompt,
  ]

  const nested =
    args.args && typeof args.args === 'object' && !Array.isArray(args.args)
      ? (args.args as Record<string, unknown>)
      : null
  if (nested) {
    candidates.push(
      nested.prompt,
      nested.description,
      nested.text,
      nested.query,
      nested.content,
      nested.caption,
      nested.message,
      nested.image_prompt,
      nested.imagePrompt
    )
  }

  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim()) {
      return candidate.trim()
    }
  }

  return null
}
