import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { isImmutableE2BTemplateRef, isValidE2BTemplateName } from '@sim/utils/sandbox-references'
import {
  MOTHERSHIP_E2B_DEFAULT_BASE_TEMPLATE,
  MOTHERSHIP_E2B_DEFAULT_TEMPLATE_NAME,
} from '@/scripts/mothership-sandbox-packages'
import { upsertEnvVar } from '@/scripts/upsert-env-var'

export const MOTHERSHIP_E2B_ENV_KEY = 'MOTHERSHIP_E2B_TEMPLATE_ID'

export interface MothershipBuildArgs {
  templateName: string
  baseTemplate: string
  pipExtras: string[]
  skipCache: boolean
  writeEnv: boolean
}

/**
 * Prefers the already-configured mothership template id so rebuilds update that
 * alias instead of minting `sim-mothership`.
 *
 * Pass `null` to force the fallback alias (ignores process env). Omit the arg
 * to read `process.env.MOTHERSHIP_E2B_TEMPLATE_ID`.
 */
export function resolveDefaultMothershipTemplateName(
  configured: string | null | undefined = process.env.MOTHERSHIP_E2B_TEMPLATE_ID
): string {
  const trimmed = configured?.trim()
  if (trimmed && isValidE2BTemplateName(trimmed)) return trimmed
  return MOTHERSHIP_E2B_DEFAULT_TEMPLATE_NAME
}

function assertMothershipTemplateName(
  value: string,
  flag: '--name' | 'MOTHERSHIP_E2B_TEMPLATE_ID'
): string {
  if (isImmutableE2BTemplateRef(value)) {
    throw new Error(
      `${flag} must be a mutable template alias, not an immutable <template>:<build-id>. Rebuilding updates the alias in place.`
    )
  }
  if (!isValidE2BTemplateName(value)) {
    throw new Error(
      `${flag} must be an E2B template name or team/name reference (no :build-id). Rebuilding keeps this same id.`
    )
  }
  return value
}

/** Parses CLI flags for the mothership E2B builder. */
export function parseMothershipBuildArgs(
  argv: readonly string[],
  configuredTemplateId = process.env.MOTHERSHIP_E2B_TEMPLATE_ID
): MothershipBuildArgs {
  const pipExtras: string[] = []
  let templateName = resolveDefaultMothershipTemplateName(configuredTemplateId)
  let baseTemplate: string | undefined
  let skipCache = false
  let writeEnv = true

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--no-cache') {
      skipCache = true
      continue
    }
    if (arg === '--no-write-env') {
      writeEnv = false
      continue
    }
    if (arg === '--name') {
      const value = argv[++i]
      if (!value || value.startsWith('--')) throw new Error('--name requires a template name')
      templateName = assertMothershipTemplateName(value, '--name')
      continue
    }
    if (arg === '--base-template') {
      const value = argv[++i]
      if (!value || value.startsWith('--')) {
        throw new Error('--base-template requires a template name or immutable name:build-id')
      }
      if (!isValidE2BTemplateName(value) && !isImmutableE2BTemplateRef(value)) {
        throw new Error(
          '--base-template must be an E2B template name or immutable <template>:<build-id>'
        )
      }
      baseTemplate = value
      continue
    }
    if (arg === '--pip') {
      const value = argv[++i]
      if (!value || value.startsWith('--')) {
        throw new Error('--pip requires a PyPI spec (e.g. requests==2.32.4)')
      }
      pipExtras.push(value)
      continue
    }
    throw new Error(`Unknown argument: ${arg}`)
  }

  // Default base = the same configured template so package updates layer onto the
  // existing image. Fall back to code-interpreter only when no mothership id exists.
  const resolvedBase =
    baseTemplate ??
    (configuredTemplateId?.trim() && isValidE2BTemplateName(configuredTemplateId.trim())
      ? configuredTemplateId.trim()
      : MOTHERSHIP_E2B_DEFAULT_BASE_TEMPLATE)

  return {
    templateName,
    baseTemplate: resolvedBase,
    pipExtras,
    skipCache,
    writeEnv,
  }
}

/**
 * Writes MOTHERSHIP_E2B_TEMPLATE_ID to the same alias used for the rebuild.
 * Does not invent a new id when the value is already correct.
 */
export async function writeMothershipTemplateEnv(
  templateName: string,
  envPaths: readonly string[]
): Promise<string[]> {
  const updated: string[] = []
  for (const envPath of envPaths) {
    let contents: string
    try {
      contents = await readFile(envPath, 'utf8')
    } catch (error) {
      const code =
        error && typeof error === 'object' && 'code' in error
          ? (error as { code?: string }).code
          : undefined
      if (code === 'ENOENT') continue
      throw error
    }
    const next = upsertEnvVar(contents, MOTHERSHIP_E2B_ENV_KEY, templateName)
    if (next !== contents) {
      await mkdir(path.dirname(envPath), { recursive: true })
      await writeFile(envPath, next, 'utf8')
    }
    updated.push(envPath)
  }
  return updated
}

/** Candidate dotenv paths when the builder runs from apps/sim or the repo root. */
export function defaultMothershipEnvPaths(cwd = process.cwd()): string[] {
  return [
    ...new Set([
      path.resolve(cwd, '.env'),
      path.resolve(cwd, 'apps/sim/.env'),
      path.resolve(cwd, '../.env'),
    ]),
  ]
}
