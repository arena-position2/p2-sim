import { LLM_KEY_POOLS } from '@sim/deployment-config/env-capabilities'
import { env } from '@/lib/core/config/env'

/** Whether the platform holds at least one key for a provider, without selecting one. */
export function hasRotatingApiKey(provider: string): boolean {
  if (!(provider in LLM_KEY_POOLS)) return false
  const definition = LLM_KEY_POOLS[provider as keyof typeof LLM_KEY_POOLS]
  if (definition.keys.some((key) => Boolean(env[key]))) return true
  return 'fallbackKey' in definition && Boolean(env[definition.fallbackKey])
}

/**
 * Server-only Google keys used when the Gemini pool is empty.
 * `NEXT_PUBLIC_GOOGLE_API_KEY` is last because it ships to the browser and Google
 * rejects it once the key is reported as leaked.
 */
function legacyGoogleGenerativeLanguageKeys(): string[] {
  const keys: string[] = []
  const google = process.env.GOOGLE_API_KEY?.trim()
  if (google) keys.push(google)
  const nextPublic = process.env.NEXT_PUBLIC_GOOGLE_API_KEY?.trim()
  if (nextPublic && !keys.includes(nextPublic)) keys.push(nextPublic)
  return keys
}

/**
 * Picks the Gemini key to send. A caller-supplied key is used only when it is
 * not the public browser key; otherwise the server env pool (`GEMINI_API_KEY*`) wins.
 */
export function resolveGoogleGenerativeLanguageApiKey(suppliedKey?: string): string {
  const trimmed = suppliedKey?.trim()
  const nextPublic = process.env.NEXT_PUBLIC_GOOGLE_API_KEY?.trim()
  if (trimmed && trimmed !== nextPublic) return trimmed
  return getRotatingApiKey('google')
}

/**
 * Rotates through available API keys for a provider
 * @param provider - The provider to get a key for (e.g., 'openai')
 * @returns The selected API key
 * @throws Error if no API keys are configured for rotation
 */
export function getRotatingApiKey(provider: string): string {
  const isGoogleGenerativeLanguage =
    provider === 'google' || provider === 'gemini' || provider === 'vertex'
  const poolProvider = isGoogleGenerativeLanguage ? 'gemini' : provider

  if (!(poolProvider in LLM_KEY_POOLS)) {
    throw new Error(`No rotation implemented for provider: ${provider}`)
  }

  const definition = LLM_KEY_POOLS[poolProvider as keyof typeof LLM_KEY_POOLS]
  const keys = definition.keys.map((key) => env[key]).filter((key): key is string => Boolean(key))
  if (keys.length === 0 && 'fallbackKey' in definition) {
    const fallback = env[definition.fallbackKey]
    if (fallback) keys.push(fallback)
  }

  if (keys.length === 0 && isGoogleGenerativeLanguage) {
    keys.push(...legacyGoogleGenerativeLanguageKeys())
  }

  if (keys.length === 0) {
    if (isGoogleGenerativeLanguage) {
      throw new Error(
        'No API keys configured for rotation. Please configure GEMINI_API_KEY (or GEMINI_API_KEY_1..3), GOOGLE_API_KEY, or NEXT_PUBLIC_GOOGLE_API_KEY.'
      )
    }

    throw new Error(
      `No API keys configured for rotation. For ${provider}, set ${provider.toUpperCase()}_API_KEY and/or ${provider.toUpperCase()}_API_KEY_1 through _3.`
    )
  }

  // Simple round-robin rotation based on current minute
  // This distributes load across keys and is stateless
  const currentMinute = new Date().getMinutes()
  const keyIndex = currentMinute % keys.length

  return keys[keyIndex]
}
