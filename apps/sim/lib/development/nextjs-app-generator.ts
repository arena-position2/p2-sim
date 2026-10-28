import { AsyncLocalStorage } from 'node:async_hooks'
import { existsSync } from 'fs'
import { mkdir, rm, writeFile } from 'fs/promises'
import { dirname, join, normalize, relative } from 'path'
import Anthropic from '@anthropic-ai/sdk'
import { transformJSONSchema } from '@anthropic-ai/sdk/lib/transform-json-schema'
import { createLogger } from '@sim/logger'
import { toError } from '@sim/utils/errors'
import { createAnthropicMessage } from '@/lib/anthropic/create-message'
import type { ModelUsageByModel } from '@/lib/billing/core/record-model-usage'
import { getRotatingApiKey } from '@/lib/core/config/api-keys'
import { env } from '@/lib/core/config/env'
import { prepareGeneratedAppForDatabaseDeploy } from '@/lib/development/apply-generated-app-database'
import { appendArenaSystemPrompt } from '@/lib/development/arena/prompts'
import {
  deployPreparedVercelProject,
  prepareVercelProjectForDeploy,
} from '@/lib/development/deploy-generated-app-to-vercel'
import {
  formatBuildErrorsSummary,
  logGeneratedAppValidationErrors,
} from '@/lib/development/format-generated-app-build-errors'
import { findMonorepoRoot, getGeneratedAppDir } from '@/lib/development/generated-apps-paths'
import {
  buildRepoSummaryContent,
  ensureRepoSummaryFile,
  GENERATED_APP_APP_ROUTER_DOCUMENT_GUIDANCE,
  GENERATED_APP_AUTH_GUIDANCE,
  GENERATED_APP_COMMON_FAILURES_GUIDANCE,
  GENERATED_APP_COMPONENT_FILES_GUIDANCE,
  GENERATED_APP_DATABASE_EDIT_GUIDANCE,
  GENERATED_APP_DATABASE_FILE_PATHS,
  GENERATED_APP_DATABASE_GUIDANCE,
  GENERATED_APP_DEPENDENCY_GUIDANCE,
  GENERATED_APP_GENERATION_MANDATES,
  GENERATED_APP_IMPORT_GUIDANCE,
  GENERATED_APP_JSX_GUIDANCE,
  GENERATED_APP_NO_TESTS_GUIDANCE,
  GENERATED_APP_NULL_SAFETY_GUIDANCE,
  GENERATED_APP_PAGE_CLIENT_CONTRACT_GUIDANCE,
  GENERATED_APP_PRISMA_ALIGNMENT_GUIDANCE,
  GENERATED_APP_README_GUIDANCE,
  GENERATED_APP_REFERENCE_PDF_GUIDANCE,
  GENERATED_APP_REPO_SUMMARY_GUIDANCE,
  GENERATED_APP_REPO_SUMMARY_PATH,
  GENERATED_APP_STYLING_GUIDANCE,
  GENERATED_APP_TYPESCRIPT_GUIDANCE,
  GENERATED_APP_VALIDATION_GUIDANCE,
  GENERATED_APP_ZERO_ERRORS_GUIDANCE,
  normalizeGeneratedAppFiles,
  PINNED_NEXT_VERSION,
  PINNED_REACT_VERSION,
} from '@/lib/development/normalize-generated-app-files'
import {
  ensureGitHubRepository,
  pushGeneratedAppToGitHub,
} from '@/lib/development/push-generated-app-to-github'
import {
  DEVELOPMENT_REQUIRES_DATABASE,
  resolveDevelopmentDeployEnv,
} from '@/lib/development/resolve-development-env'
import type { DevelopmentReferenceMedia } from '@/lib/development/resolve-development-reference-image'
import {
  validateGeneratedAppPreDeploy,
  validateGeneratedAppProductionBuild,
} from '@/lib/development/validate-generated-app-build'
import {
  collectReferencedAliasPathsInFiles,
  formatStructureValidationIssues,
  validateGeneratedAppStructure,
} from '@/lib/development/validate-generated-app-structure'
import { supportsTemperature } from '@/providers/models'

const logger = createLogger('NextjsAppGenerator')

type LlmUsageAccumulator = Map<string, { inputTokens: number; outputTokens: number }>

const llmUsageStorage = new AsyncLocalStorage<LlmUsageAccumulator>()
const arenaModeStorage = new AsyncLocalStorage<boolean>()

function isArenaMode(): boolean {
  return arenaModeStorage.getStore() === true
}

async function runWithArenaMode<T>(arenaMode: boolean, fn: () => Promise<T>): Promise<T> {
  return arenaModeStorage.run(arenaMode, fn)
}

function runWithLlmUsageTracking<T>(fn: () => Promise<T>): Promise<T> {
  return llmUsageStorage.run(new Map(), fn)
}

function trackLlmUsage(
  model: string,
  usage: { input_tokens?: number; output_tokens?: number } | undefined
): void {
  if (!usage) return
  const inputTokens = usage.input_tokens ?? 0
  const outputTokens = usage.output_tokens ?? 0
  if (inputTokens <= 0 && outputTokens <= 0) return

  const acc = llmUsageStorage.getStore()
  if (!acc) return

  const existing = acc.get(model) ?? { inputTokens: 0, outputTokens: 0 }
  acc.set(model, {
    inputTokens: existing.inputTokens + inputTokens,
    outputTokens: existing.outputTokens + outputTokens,
  })
}

function getTrackedLlmUsage(): ModelUsageByModel | undefined {
  const acc = llmUsageStorage.getStore()
  if (!acc || acc.size === 0) return undefined
  return Object.fromEntries(acc)
}

/** Creation and edit/repair both use Claude Fable. Override via DEVELOPMENT_ANTHROPIC_CREATION_MODEL / DEVELOPMENT_ANTHROPIC_EDIT_MODEL. */
const DEFAULT_CREATION_MODEL = 'claude-fable-5'
const DEFAULT_EDIT_MODEL = 'claude-fable-5'

type DevelopmentModelPurpose = 'creation' | 'edit'

function resolveEnvModel(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    const trimmed = value?.trim()
    if (trimmed) {
      return trimmed
    }
  }
  return undefined
}

function getDevelopmentModelId(purpose: DevelopmentModelPurpose): string {
  if (purpose === 'edit') {
    return (
      resolveEnvModel(
        env.DEVELOPMENT_ANTHROPIC_EDIT_MODEL,
        process.env.DEVELOPMENT_ANTHROPIC_EDIT_MODEL
      ) ?? DEFAULT_EDIT_MODEL
    )
  }

  return (
    resolveEnvModel(
      process.env.DEVELOPMENT_ANTHROPIC_CREATION_MODEL,
      process.env.DEVELOPMENT_ANTHROPIC_MODEL
    ) ?? DEFAULT_CREATION_MODEL
  )
}
const STRUCTURED_OUTPUTS_BETA = 'structured-outputs-2025-11-13'
/** Opus 4.8+ supports 128k output; Sonnet 4.6 caps at 64k. */
const DEFAULT_MAX_OUTPUT_TOKENS = 128_000
/** More files allow complex multi-page apps without stub components. */
const MAX_GENERATED_FILES = 45
const FILES_PER_BATCH = 10
const MAX_LLM_CONTINUATION_TURNS = 1
const MAX_OPTIONAL_PAGE_PATHS = 24

const REQUIRED_APP_FILE_PATHS = [
  'package.json',
  'tsconfig.json',
  'next.config.ts',
  'postcss.config.mjs',
  'tailwind.config.ts',
  'app/layout.tsx',
  'app/page.tsx',
  'app/not-found.tsx',
  'app/globals.css',
  '.gitignore',
  'README.md',
  GENERATED_APP_REPO_SUMMARY_PATH,
  '.env.example',
] as const
/** Max LLM repair rounds after a failed pre-deploy build/typecheck before deploy. */
const MAX_BUILD_REPAIR_ROUNDS = 3
const MAX_BUILD_LOG_CHARS = 12_000

const APP_SPEC_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    appName: { type: 'string' },
    repoName: { type: 'string' },
    description: { type: 'string' },
    features: { type: 'array', items: { type: 'string' } },
    requiresDatabase: { type: 'boolean' },
    files: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string' },
        },
        required: ['path', 'content'],
        additionalProperties: false,
      },
    },
  },
  required: ['appName', 'repoName', 'description', 'features', 'requiresDatabase', 'files'],
  additionalProperties: false,
}

const APP_MANIFEST_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    appName: { type: 'string' },
    repoName: { type: 'string' },
    description: { type: 'string' },
    features: { type: 'array', items: { type: 'string' } },
    requiresDatabase: { type: 'boolean' },
    filePaths: { type: 'array', items: { type: 'string' } },
  },
  required: ['appName', 'repoName', 'description', 'features', 'requiresDatabase', 'filePaths'],
  additionalProperties: false,
}

const FILE_BATCH_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    files: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string' },
        },
        required: ['path', 'content'],
        additionalProperties: false,
      },
    },
  },
  required: ['files'],
  additionalProperties: false,
}

interface LlmAppManifest {
  appName: string
  repoName: string
  description: string
  features: string[]
  requiresDatabase?: boolean
  filePaths: string[]
}

export interface GenerateNextjsAppInput {
  userInput: string
  repoName?: string
  privateRepo?: boolean
  referenceImage?: DevelopmentReferenceMedia
  /** When true, inject Arena iframe emailId scaffold and Arena system-prompt mandates. */
  arenaMode?: boolean
}

export interface GeneratedAppFile {
  path: string
  content: string
}

export interface GenerateNextjsAppResult {
  success: boolean
  appName?: string
  repoName?: string
  description?: string
  features?: string[]
  outputPath?: string
  absoluteOutputPath?: string
  fileCount?: number
  buildValidated?: boolean
  buildOutput?: string
  gitPushed?: boolean
  githubHtmlUrl?: string
  githubCloneUrl?: string
  githubOwner?: string
  githubRepoName?: string
  gitPushError?: string
  vercelDeployed?: boolean
  vercelUrl?: string
  vercelDeploymentUrl?: string
  vercelProjectId?: string
  vercelDeploymentId?: string
  vercelInspectorUrl?: string
  vercelDeployError?: string
  requiresDatabase?: boolean
  databaseProvisioned?: boolean
  neonProjectId?: string
  databaseProvisionError?: string
  error?: string
  mode?: 'generate' | 'edit'
  /** Aggregated LLM token usage keyed by model id (for usage_log billing). */
  llmUsage?: ModelUsageByModel
}

interface LlmAppSpec {
  appName: string
  repoName: string
  description: string
  features: string[]
  requiresDatabase?: boolean
  files: GeneratedAppFile[]
}

/**
 * Converts a display name into a safe repository folder name.
 */
export function slugifyRepoName(name: string): string {
  return (
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 64) || 'generated-app'
  )
}

/**
 * Ensures a relative file path cannot escape the output directory.
 */
export function sanitizeRelativeFilePath(filePath: string): string | null {
  const normalized = normalize(filePath.replace(/\\/g, '/'))
  if (normalized.startsWith('..') || normalized.startsWith('/')) {
    return null
  }
  return normalized
}

function extractJsonFromLlmText(text: string): string {
  const trimmed = text.trim()

  /** Structured outputs return raw JSON; do not scan for inner ``` (common in file contents). */
  if (trimmed.startsWith('{')) {
    return trimmed
  }

  const fencePrefix = /^```(?:json)?\s*\n?/i
  if (fencePrefix.test(trimmed)) {
    const withoutOpen = trimmed.replace(fencePrefix, '')
    const closeIdx = withoutOpen.lastIndexOf('```')
    if (closeIdx >= 0) {
      const inner = withoutOpen.slice(0, closeIdx).trim()
      if (inner.startsWith('{')) {
        return inner
      }
    }
  }

  const firstBrace = trimmed.indexOf('{')
  const lastBrace = trimmed.lastIndexOf('}')
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return trimmed.slice(firstBrace, lastBrace + 1)
  }
  return trimmed
}

function parseAppSpecJson(text: string): LlmAppSpec {
  const jsonText = extractJsonFromLlmText(text)

  try {
    const parsed = JSON.parse(jsonText) as LlmAppSpec | null
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('Model returned null or non-object JSON for app generation')
    }
    return parsed
  } catch (error) {
    const message = toError(error).message
    if (message.includes('null or non-object JSON')) {
      throw error
    }
    if (!jsonText.trimStart().startsWith('{')) {
      const preview = text.trim().slice(0, 120).replace(/\s+/g, ' ')
      throw new Error(
        `Model returned non-JSON (${preview}…). Try a simpler app description with fewer pages.`
      )
    }
    throw new Error(
      `Failed to parse generated app JSON (${message}). Try a simpler app description with fewer pages.`
    )
  }
}

function createDevelopmentAnthropicClient(apiKey: string): Anthropic {
  return new Anthropic({
    apiKey,
    defaultHeaders: { 'anthropic-beta': STRUCTURED_OUTPUTS_BETA },
  })
}

function truncateBuildLog(output: string): string {
  if (output.length <= MAX_BUILD_LOG_CHARS) {
    return output
  }
  return `${output.slice(-MAX_BUILD_LOG_CHARS)}\n…(truncated)`
}

/** Development block always provisions Neon Postgres + Prisma for generated apps. */
function resolveRequiresDatabase(_spec: Pick<LlmAppSpec, 'requiresDatabase' | 'files'>): boolean {
  return DEVELOPMENT_REQUIRES_DATABASE
}

interface NormalizeAppSpecOptions {
  /** Skip the file-count cap — use for edit/repair flows that merge with an existing repo. */
  preserveAllFiles?: boolean
  /** Recorded in REPO_SUMMARY.md when the spec is normalized. */
  latestUserRequest?: string
  /**
   * Skip file patching and scaffold injection — use on PARTIAL file sets (repair
   * responses) that are merged into the full spec and re-normalized afterwards,
   * so injected fallbacks (schema, README) cannot clobber real files on merge.
   */
  skipFileNormalization?: boolean
  /** When true, inject Arena iframe emailId scaffold into the generated app. */
  arenaMode?: boolean
}

/**
 * Caps file count for LLM-generated apps while always keeping required scaffolding
 * (package.json, Tailwind config, Prisma files, etc.).
 */
export function capGeneratedAppFiles(
  files: GeneratedAppFile[],
  maxFiles: number,
  requiresDatabase: boolean
): GeneratedAppFile[] {
  if (files.length <= maxFiles) {
    return files
  }

  const requiredPaths = new Set<string>(REQUIRED_APP_FILE_PATHS)
  requiredPaths.add('next-env.d.ts')
  requiredPaths.add(GENERATED_APP_REPO_SUMMARY_PATH)
  if (requiresDatabase) {
    for (const path of GENERATED_APP_DATABASE_FILE_PATHS) {
      requiredPaths.add(path)
    }
  }

  const importReferencedPaths = collectReferencedAliasPathsInFiles(files)
  for (const path of importReferencedPaths) {
    requiredPaths.add(path)
  }

  const required: GeneratedAppFile[] = []
  const optional: GeneratedAppFile[] = []
  const seen = new Set<string>()

  for (const file of files) {
    const path = file.path.replace(/\\/g, '/')
    if (seen.has(path)) {
      continue
    }
    seen.add(path)

    if (requiredPaths.has(path)) {
      required.push({ ...file, path })
    } else {
      optional.push({ ...file, path })
    }
  }

  const optionalBudget = Math.max(0, maxFiles - required.length)
  const capped = [...required, ...optional.slice(0, optionalBudget)]

  logger.warn('Capped generated file list while preserving required scaffolding', {
    before: files.length,
    after: capped.length,
    max: maxFiles,
    dropped: files.length - capped.length,
  })

  return capped
}

function normalizeAppSpec(
  parsed: LlmAppSpec,
  repoNameHint?: string,
  options: NormalizeAppSpecOptions = {}
): LlmAppSpec {
  if (!parsed.appName || !parsed.files?.length) {
    throw new Error('LLM response missing required appName or files')
  }

  parsed.repoName = slugifyRepoName(parsed.repoName || repoNameHint || parsed.appName)
  parsed.requiresDatabase = resolveRequiresDatabase(parsed)

  if (!options.preserveAllFiles && parsed.files.length > MAX_GENERATED_FILES) {
    parsed.files = capGeneratedAppFiles(
      parsed.files,
      MAX_GENERATED_FILES,
      parsed.requiresDatabase ?? DEVELOPMENT_REQUIRES_DATABASE
    )
  }

  if (!options.skipFileNormalization) {
    parsed.files = normalizeGeneratedAppFiles(parsed.files, {
      requiresDatabase: parsed.requiresDatabase,
      appName: parsed.appName,
      description: parsed.description,
      features: parsed.features,
      repoName: parsed.repoName,
      latestUserRequest: options.latestUserRequest,
      arenaMode: options.arenaMode ?? isArenaMode(),
    })
  }

  return parsed
}

function getAnthropicApiKey(): string {
  try {
    return getRotatingApiKey('anthropic')
  } catch {
    throw new Error(
      'ANTHROPIC_API_KEY is not configured. Set ANTHROPIC_API_KEY or ANTHROPIC_API_KEY_1 through _3 to enable Next.js app generation.'
    )
  }
}

function getMaxOutputTokens(modelId: string): number {
  if (/claude-sonnet-4-[0-5]/.test(modelId) || modelId === 'claude-sonnet-4-6') {
    return 64_000
  }
  return DEFAULT_MAX_OUTPUT_TOKENS
}

function getMessageText(message: Anthropic.Messages.Message): string {
  const text = message.content
    .filter((block): block is Anthropic.Messages.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('')
  if (!text.trim()) {
    throw new Error('LLM did not return text content for app generation')
  }
  return text
}

function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = []
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size))
  }
  return chunks
}

function sortManifestFilePaths(paths: string[]): string[] {
  const priority = (path: string): [number, string] => {
    const normalized = path.replace(/\\/g, '/')
    const exact: Record<string, number> = {
      'package.json': 0,
      'tsconfig.json': 1,
      'next.config.ts': 2,
      'postcss.config.mjs': 3,
      'tailwind.config.ts': 4,
      '.gitignore': 5,
      '.env.example': 6,
      'README.md': 7,
      [GENERATED_APP_REPO_SUMMARY_PATH]: 8,
      'lib/types.ts': 20,
      'lib/actions.ts': 21,
      'lib/auth.ts': 22,
      'lib/prisma.ts': 23,
      'lib/crypto.ts': 24,
      'app/globals.css': 40,
      'app/layout.tsx': 41,
      'app/not-found.tsx': 42,
      'app/error.tsx': 43,
      'app/page.tsx': 44,
    }
    if (exact[normalized] !== undefined) {
      return [exact[normalized], normalized]
    }
    if (normalized.startsWith('prisma/')) {
      return [15, normalized]
    }
    if (normalized.startsWith('lib/')) {
      return [26, normalized]
    }
    if (normalized.startsWith('components/')) {
      return [35, normalized]
    }
    if (normalized.startsWith('app/api/')) {
      return [55, normalized]
    }
    if (normalized.startsWith('app/')) {
      return [50, normalized]
    }
    return [60, normalized]
  }

  return [...paths].sort((left, right) => {
    const [leftPriority, leftPath] = priority(left)
    const [rightPriority, rightPath] = priority(right)
    return leftPriority !== rightPriority
      ? leftPriority - rightPriority
      : leftPath.localeCompare(rightPath)
  })
}

function mergeManifestFilePaths(
  manifestPaths: string[],
  requiresDatabase = DEVELOPMENT_REQUIRES_DATABASE
): string[] {
  const normalized = manifestPaths.map((p) => p.replace(/\\/g, '/').trim()).filter(Boolean)
  const requiredSet = new Set<string>(REQUIRED_APP_FILE_PATHS)
  if (requiresDatabase) {
    for (const path of GENERATED_APP_DATABASE_FILE_PATHS) {
      requiredSet.add(path)
    }
  }
  const optional = normalized.filter((p) => !requiredSet.has(p)).slice(0, MAX_OPTIONAL_PAGE_PATHS)
  const merged = sortManifestFilePaths([...new Set([...requiredSet, ...optional])])
  return merged.slice(0, MAX_GENERATED_FILES)
}

function isLikelyTruncationOrParseFailure(error: unknown): boolean {
  const message = toError(error).message.toLowerCase()
  return (
    message.includes('truncat') ||
    message.includes('max_tokens') ||
    message.includes('parse') ||
    message.includes('json') ||
    message.includes('non-json')
  )
}

async function requestStructuredLlm(
  anthropic: Anthropic,
  systemPrompt: string,
  messages: Anthropic.Messages.MessageParam[],
  schema: Record<string, unknown>,
  purpose: DevelopmentModelPurpose
): Promise<Anthropic.Messages.Message> {
  const modelId = getDevelopmentModelId(purpose)
  const message = await createAnthropicMessage(anthropic, {
    model: modelId,
    max_tokens: getMaxOutputTokens(modelId),
    ...(supportsTemperature(modelId) ? { temperature: 0.2 } : {}),
    system: systemPrompt,
    messages,
    output_config: {
      format: {
        type: 'json_schema',
        schema: transformJSONSchema(schema),
      },
    },
  })
  trackLlmUsage(modelId, message.usage)
  return message
}

function augmentSystemPromptForReferenceImage(
  systemPrompt: string,
  referenceMedia?: DevelopmentReferenceMedia
): string {
  const prompt = appendArenaSystemPrompt(systemPrompt, isArenaMode())
  if (!referenceMedia) {
    return prompt
  }
  return `${prompt}\n\n- ${GENERATED_APP_REFERENCE_PDF_GUIDANCE}`
}

function buildReferenceContentBlock(
  referenceMedia: DevelopmentReferenceMedia
): Anthropic.Messages.ContentBlockParam {
  if (referenceMedia.mediaType !== 'application/pdf') {
    throw new Error('Reference media must be a PDF')
  }

  return {
    type: 'document',
    source: {
      type: 'base64',
      media_type: 'application/pdf',
      data: referenceMedia.base64,
    },
  }
}

function buildUserMessageContent(
  text: string,
  referenceMedia?: DevelopmentReferenceMedia
): Anthropic.Messages.MessageParam['content'] {
  if (!referenceMedia) {
    return text
  }

  return [
    buildReferenceContentBlock(referenceMedia),
    {
      type: 'text',
      text: `Reference design PDF attached — read every page and treat it as the visual source of truth. Match layout, color palette, typography, spacing, borders, component hierarchy, and visible copy. Define theme tokens in app/globals.css and tailwind.config.ts from the PDF colors and fonts — do not use a generic default theme.\n\n${text}`,
    },
  ]
}

/**
 * Requests JSON from the model; on max_tokens, continues the same JSON across turns and merges text.
 */
async function requestStructuredJsonWithContinuations<T>(
  anthropic: Anthropic,
  systemPrompt: string,
  initialUserPrompt: string,
  schema: Record<string, unknown>,
  parse: (text: string) => T,
  referenceImage?: DevelopmentReferenceMedia,
  purpose: DevelopmentModelPurpose = 'creation'
): Promise<T> {
  const messages: Anthropic.Messages.MessageParam[] = [
    {
      role: 'user',
      content: buildUserMessageContent(initialUserPrompt, referenceImage),
    },
  ]
  let accumulated = ''

  for (let turn = 0; turn <= MAX_LLM_CONTINUATION_TURNS; turn++) {
    const message = await requestStructuredLlm(
      anthropic,
      augmentSystemPromptForReferenceImage(systemPrompt, referenceImage),
      messages,
      schema,
      purpose
    )
    const text = getMessageText(message)

    accumulated = turn === 0 ? text : `${accumulated}${text}`

    if (message.stop_reason !== 'max_tokens') {
      return parse(accumulated)
    }

    logger.warn('LLM response hit max_tokens; requesting continuation', { turn: turn + 1 })

    messages.push({ role: 'assistant', content: text })
    messages.push({
      role: 'user',
      content:
        'Your previous JSON response was cut off. Continue from the exact cut-off point and output ONLY the remaining characters needed to complete the JSON object. Do not repeat content from the start.',
    })
  }

  return parse(accumulated)
}

const SINGLE_SHOT_SYSTEM_PROMPT = `You are a senior full-stack engineer. Generate a focused Next.js ${PINNED_NEXT_VERSION} App Router app (React ${PINNED_REACT_VERSION}) in ONE response.

Respond ONLY with JSON matching the provided schema. No markdown or code fences.

${GENERATED_APP_GENERATION_MANDATES}

Constraints:
- At most ${MAX_GENERATED_FILES} files total — use as many as needed but no more
- Required: ${REQUIRED_APP_FILE_PATHS.join(', ')} plus pages and components (max ${MAX_OPTIONAL_PAGE_PATHS} extra files)
- Generate ALL components/*.tsx files BEFORE or WITH the pages that import them — never leave dangling @/components imports
- Every component MUST contain complete, real, working UI code — NEVER a stub, placeholder, or a component that renders only its own name as text
- Reuse components; keep page files short; put shared styles in app/globals.css
- app/ at project root only (not src/app/)
- ${GENERATED_APP_ZERO_ERRORS_GUIDANCE}
- ${GENERATED_APP_COMMON_FAILURES_GUIDANCE}
- ${GENERATED_APP_DEPENDENCY_GUIDANCE}
- ${GENERATED_APP_TYPESCRIPT_GUIDANCE}
- ${GENERATED_APP_NULL_SAFETY_GUIDANCE}
- ${GENERATED_APP_STYLING_GUIDANCE}
- ${GENERATED_APP_IMPORT_GUIDANCE}
- ${GENERATED_APP_COMPONENT_FILES_GUIDANCE}
- ${GENERATED_APP_PAGE_CLIENT_CONTRACT_GUIDANCE}
- ${GENERATED_APP_JSX_GUIDANCE}
- ${GENERATED_APP_APP_ROUTER_DOCUMENT_GUIDANCE}
- ${GENERATED_APP_DATABASE_GUIDANCE}
- ${GENERATED_APP_PRISMA_ALIGNMENT_GUIDANCE}
- ${GENERATED_APP_AUTH_GUIDANCE}
- ${GENERATED_APP_README_GUIDANCE}
- ${GENERATED_APP_REPO_SUMMARY_GUIDANCE}
- ${GENERATED_APP_NO_TESTS_GUIDANCE}
- ${GENERATED_APP_VALIDATION_GUIDANCE}
- NEVER use localStorage.setItem or sessionStorage.setItem to persist app data — use Prisma server actions when requiresDatabase is true
- Valid TypeScript, zero syntax/semantic/build errors, no secrets`

const MANIFEST_SYSTEM_PROMPT = `You are a senior full-stack engineer planning a Next.js ${PINNED_NEXT_VERSION} App Router project (React ${PINNED_REACT_VERSION}).

Respond ONLY with JSON matching the provided schema. List file paths only — do NOT include file contents.

${GENERATED_APP_GENERATION_MANDATES}

Constraints:
- At most ${MAX_GENERATED_FILES} file paths — list EVERY file the app truly needs so no component is left as a stub
- Include every required path: ${REQUIRED_APP_FILE_PATHS.join(', ')}
- List ALL components/*.tsx paths first (Navbar, Footer, *Client components) — then list app routes that import them
- Always include app/not-found.tsx (required) — list it before other app routes
- List lib/types.ts and lib/actions.ts before any app/**/page.tsx paths
- Add up to ${MAX_OPTIONAL_PAGE_PATHS} optional page/component paths — for multi-page apps, list all page routes and shared components
- Use app/ at project root (not src/app/)
- ${GENERATED_APP_ZERO_ERRORS_GUIDANCE}
- ${GENERATED_APP_COMMON_FAILURES_GUIDANCE}
- ${GENERATED_APP_DEPENDENCY_GUIDANCE}
- ${GENERATED_APP_STYLING_GUIDANCE}
- ${GENERATED_APP_IMPORT_GUIDANCE}
- ${GENERATED_APP_COMPONENT_FILES_GUIDANCE}
- ${GENERATED_APP_PAGE_CLIENT_CONTRACT_GUIDANCE}
- ${GENERATED_APP_JSX_GUIDANCE}
- ${GENERATED_APP_APP_ROUTER_DOCUMENT_GUIDANCE}
- ${GENERATED_APP_DATABASE_GUIDANCE}
- ${GENERATED_APP_PRISMA_ALIGNMENT_GUIDANCE}
- ${GENERATED_APP_AUTH_GUIDANCE}
- ${GENERATED_APP_README_GUIDANCE}
- ${GENERATED_APP_REPO_SUMMARY_GUIDANCE}
- ${GENERATED_APP_NO_TESTS_GUIDANCE}
- ${GENERATED_APP_VALIDATION_GUIDANCE}
- NEVER use localStorage.setItem or sessionStorage.setItem to persist app data — use Prisma server actions when requiresDatabase is true
- Never include secrets`

const FILE_BATCH_SYSTEM_PROMPT = `You are a senior full-stack engineer writing files for a Next.js ${PINNED_NEXT_VERSION} App Router project.

Respond ONLY with JSON matching the provided schema: a "files" array with path and content for each requested path.

${GENERATED_APP_GENERATION_MANDATES}

Constraints:
- Return EVERY requested path with complete, real, working file content — NEVER a stub or a component that renders only its own name as text
- Every component file must render actual UI — buttons, inputs, text, layout — not placeholder content like "<div>ComponentName</div>"
- TypeScript strict, no any, no @ts-ignore
- Keep individual files concise; share styles in app/globals.css
- ${GENERATED_APP_ZERO_ERRORS_GUIDANCE}
- ${GENERATED_APP_COMMON_FAILURES_GUIDANCE}
- ${GENERATED_APP_DEPENDENCY_GUIDANCE}
- ${GENERATED_APP_TYPESCRIPT_GUIDANCE}
- ${GENERATED_APP_NULL_SAFETY_GUIDANCE}
- ${GENERATED_APP_STYLING_GUIDANCE}
- ${GENERATED_APP_IMPORT_GUIDANCE}
- ${GENERATED_APP_COMPONENT_FILES_GUIDANCE}
- ${GENERATED_APP_PAGE_CLIENT_CONTRACT_GUIDANCE}
- ${GENERATED_APP_JSX_GUIDANCE}
- ${GENERATED_APP_APP_ROUTER_DOCUMENT_GUIDANCE}
- ${GENERATED_APP_DATABASE_GUIDANCE}
- ${GENERATED_APP_PRISMA_ALIGNMENT_GUIDANCE}
- ${GENERATED_APP_AUTH_GUIDANCE}
- ${GENERATED_APP_README_GUIDANCE}
- ${GENERATED_APP_REPO_SUMMARY_GUIDANCE}
- ${GENERATED_APP_NO_TESTS_GUIDANCE}
- ${GENERATED_APP_VALIDATION_GUIDANCE}
- NEVER use localStorage.setItem or sessionStorage.setItem to persist app data — use Prisma server actions when requiresDatabase is true
- Code must compile with zero syntax, semantic, and next build errors when combined with other project files
- Never include secrets`

async function requestAppManifestFromLlm(
  anthropic: Anthropic,
  userInput: string,
  repoNameHint?: string,
  referenceImage?: DevelopmentReferenceMedia
): Promise<LlmAppManifest> {
  const userPrompt = repoNameHint
    ? `User request:\n${userInput}\n\nPreferred repository folder name: ${repoNameHint}`
    : `User request:\n${userInput}`

  const manifest = await requestStructuredJsonWithContinuations(
    anthropic,
    MANIFEST_SYSTEM_PROMPT,
    userPrompt,
    APP_MANIFEST_JSON_SCHEMA,
    (text) => JSON.parse(extractJsonFromLlmText(text)) as LlmAppManifest,
    referenceImage
  )

  if (!manifest.appName || !manifest.filePaths?.length) {
    throw new Error('LLM manifest missing appName or filePaths')
  }

  manifest.repoName = slugifyRepoName(manifest.repoName || repoNameHint || manifest.appName)
  manifest.requiresDatabase = resolveRequiresDatabase({
    requiresDatabase: manifest.requiresDatabase,
    files: manifest.filePaths.map((path) => ({ path, content: '' })),
  })
  manifest.filePaths = mergeManifestFilePaths(manifest.filePaths, manifest.requiresDatabase)

  return manifest
}

async function requestFileBatchFromLlm(
  anthropic: Anthropic,
  options: {
    paths: string[]
    userInput: string
    appName: string
    description: string
    existingPaths?: string[]
    referenceImage?: DevelopmentReferenceMedia
  },
  allowBatchRetry = true
): Promise<GeneratedAppFile[]> {
  const { paths, userInput, appName, description, referenceImage } = options

  const existingPaths = options.existingPaths ?? []

  const normalizedPaths = paths.map((path) => path.replace(/\\/g, '/'))
  const batchHasAppPages = normalizedPaths.some((path) => /^app\/[^/]+\/page\.tsx$/.test(path))
  const batchHasApiRoutes = normalizedPaths.some((path) => /^app\/api\/.+\/route\.ts$/.test(path))
  const batchIncludesActions = normalizedPaths.includes('lib/actions.ts')
  const actionsCoGenerationNote =
    (batchHasAppPages || batchHasApiRoutes) && !batchIncludesActions
      ? `\nMANDATORY: This batch includes app pages or API routes. You MUST ALSO return lib/actions.ts in files[] with export async function for EVERY symbol those files import from @/lib/actions. Return the complete lib/actions.ts — merge with patterns from existing files if needed.\n`
      : ''

  const userPrompt = `App name: ${appName}
Description: ${description}

Original user request:
${userInput}

Generate complete contents for these paths only:
${paths.map((p) => `- ${p}`).join('\n')}
${actionsCoGenerationNote}
${
  existingPaths.length > 0
    ? `Already generated paths (you may import from @/ only if the target is in this list or in the batch above):\n${existingPaths.map((p) => `- ${p}`).join('\n')}`
    : ''
}`

  const result = await requestStructuredJsonWithContinuations(
    anthropic,
    FILE_BATCH_SYSTEM_PROMPT,
    userPrompt,
    FILE_BATCH_JSON_SCHEMA,
    (text) => {
      const parsed = JSON.parse(extractJsonFromLlmText(text)) as {
        files?: GeneratedAppFile[]
      } | null
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('LLM file batch response was null or not an object')
      }
      return parsed
    },
    referenceImage
  )

  const byPath = new Map<string, GeneratedAppFile>()
  for (const file of result.files ?? []) {
    if (file.path && typeof file.content === 'string') {
      byPath.set(file.path.replace(/\\/g, '/'), file)
    }
  }

  const files: GeneratedAppFile[] = []
  const missing: string[] = []

  for (const path of paths) {
    const file = byPath.get(path)
    if (file) {
      files.push(file)
    } else {
      missing.push(path)
    }
  }

  if (missing.length === 0) {
    return files
  }

  if (paths.length === 1) {
    throw new Error(`Failed to generate file content for: ${missing.join(', ')}`)
  }

  if (!allowBatchRetry) {
    throw new Error(`Failed to generate file content for: ${missing.join(', ')}`)
  }

  logger.warn('Batch missing files; retrying batch once', { missing })
  const retryFiles = await requestFileBatchFromLlm(
    anthropic,
    { paths: missing, userInput, appName, description, referenceImage },
    false
  )
  files.push(...retryFiles)

  return files
}

async function requestSingleShotAppSpecFromLlm(
  userInput: string,
  repoNameHint?: string,
  referenceImage?: DevelopmentReferenceMedia
): Promise<LlmAppSpec> {
  const anthropic = createDevelopmentAnthropicClient(getAnthropicApiKey())
  const userPrompt = repoNameHint
    ? `User request:\n${userInput}\n\nPreferred repository folder name: ${repoNameHint}`
    : `User request:\n${userInput}`

  logger.info('Generating app in a single LLM request', {
    hasReferenceImage: Boolean(referenceImage),
  })

  const parsed = await requestStructuredJsonWithContinuations(
    anthropic,
    SINGLE_SHOT_SYSTEM_PROMPT,
    userPrompt,
    APP_SPEC_JSON_SCHEMA,
    (text) => parseAppSpecJson(text),
    referenceImage
  )

  return normalizeAppSpec(parsed, repoNameHint)
}

/**
 * Fallback: manifest + parallel file batches when single-shot output is too large.
 */
async function requestBatchedAppSpecFromLlm(
  userInput: string,
  repoNameHint?: string,
  referenceImage?: DevelopmentReferenceMedia
): Promise<LlmAppSpec> {
  const anthropic = createDevelopmentAnthropicClient(getAnthropicApiKey())
  const manifest = await requestAppManifestFromLlm(
    anthropic,
    userInput,
    repoNameHint,
    referenceImage
  )

  const pathBatches = chunkArray(manifest.filePaths, FILES_PER_BATCH)

  logger.info('Generating app files in parallel batches', {
    totalPaths: manifest.filePaths.length,
    batches: pathBatches.length,
  })

  const allFiles: GeneratedAppFile[] = []

  for (const paths of pathBatches) {
    const batchFiles = await requestFileBatchFromLlm(anthropic, {
      paths,
      userInput,
      appName: manifest.appName,
      description: manifest.description,
      existingPaths: [...manifest.filePaths, ...allFiles.map((f) => f.path.replace(/\\/g, '/'))],
      referenceImage,
    })
    allFiles.push(...batchFiles)
  }

  return normalizeAppSpec(
    {
      appName: manifest.appName,
      repoName: manifest.repoName,
      description: manifest.description,
      features: manifest.features,
      requiresDatabase: manifest.requiresDatabase,
      files: allFiles,
    },
    repoNameHint
  )
}

/** Full app JSON in one call (used for build repair). */
async function requestFullAppSpecFromLlm(
  systemPrompt: string,
  userPrompt: string,
  repoNameHint?: string,
  options: NormalizeAppSpecOptions = {}
): Promise<LlmAppSpec> {
  const anthropic = createDevelopmentAnthropicClient(getAnthropicApiKey())

  const parsed = await requestStructuredJsonWithContinuations(
    anthropic,
    systemPrompt,
    userPrompt,
    APP_SPEC_JSON_SCHEMA,
    (text) => parseAppSpecJson(text),
    undefined,
    'edit'
  )

  return normalizeAppSpec(parsed, repoNameHint, options)
}

async function generateAppSpecWithLlm(
  userInput: string,
  repoNameHint?: string,
  referenceImage?: DevelopmentReferenceMedia
): Promise<LlmAppSpec> {
  try {
    return await requestSingleShotAppSpecFromLlm(userInput, repoNameHint, referenceImage)
  } catch (error) {
    if (!isLikelyTruncationOrParseFailure(error)) {
      throw error
    }
    logger.warn('Single-shot app generation failed; using batched fallback', {
      error: toError(error).message,
      hasReferenceImage: Boolean(referenceImage),
    })
    return requestBatchedAppSpecFromLlm(userInput, repoNameHint, referenceImage)
  }
}

/** Per-file and total char budgets for repair/edit prompt file context. */
const MAX_REPAIR_CONTEXT_FILE_CHARS = 12_000
const MAX_REPAIR_CONTEXT_TOTAL_CHARS = 260_000

const EDIT_DATABASE_CONTEXT_PATHS = [
  'prisma/schema.prisma',
  'lib/prisma.ts',
  'lib/actions.ts',
  'lib/types.ts',
] as const

/** Max non-pinned paths the select-pass may request for edit context. */
const MAX_EDIT_SELECTED_PATHS = 20

/** Always included in edit context when present (cheap, high-leverage anchors). */
const EDIT_ALWAYS_PIN_PATHS = ['package.json', 'app/layout.tsx', 'app/globals.css'] as const

const EDIT_FILE_SELECTION_SYSTEM_PROMPT = `You select which files an engineer must read to fulfill an edit on an existing Next.js App Router app.

Respond ONLY with JSON matching the schema: { "paths": string[] }.

Rules:
- Choose the minimum paths required to understand and implement the edit
- Prefer pages, components, actions, types, and config the request clearly touches
- Include obvious import dependencies named in the summary when relevant
- At most ${MAX_EDIT_SELECTED_PATHS} paths
- Paths must match the file index exactly — never invent paths`

const EDIT_FILE_SELECTION_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    paths: {
      type: 'array',
      items: { type: 'string' },
      maxItems: MAX_EDIT_SELECTED_PATHS,
    },
  },
  required: ['paths'],
  additionalProperties: false,
}

function collectPrismaModelNames(schema: string): Set<string> {
  const names = new Set<string>()
  for (const match of schema.matchAll(/model\s+(\w+)\s*\{/g)) {
    names.add(match[1])
  }
  return names
}

/**
 * Lists scalar columns per model so the edit LLM sees exactly what must not be dropped.
 */
function summarizePrismaScalarFields(schema: string): string {
  const modelNames = collectPrismaModelNames(schema)
  const lines: string[] = []
  const modelBlockPattern = /model\s+(\w+)\s*\{([\s\S]*?)\n\}/g
  const fieldPattern = /^(\w+)\s+(\w+)(\[\])?(\?)?\s*/

  for (const match of schema.matchAll(modelBlockPattern)) {
    const modelName = match[1]
    const scalarFields: string[] = []

    for (const rawLine of match[2].split('\n')) {
      const line = rawLine.trim()
      if (!line || line.startsWith('//') || line.startsWith('@@')) {
        continue
      }

      const fieldMatch = fieldPattern.exec(line)
      if (!fieldMatch) {
        continue
      }

      const fieldName = fieldMatch[1]
      const type = fieldMatch[2]
      const isList = Boolean(fieldMatch[3])
      if (isList || modelNames.has(type)) {
        continue
      }

      scalarFields.push(fieldName)
    }

    if (scalarFields.length > 0) {
      lines.push(`- ${modelName}: ${scalarFields.join(', ')}`)
    }
  }

  return lines.join('\n')
}

function getFileContentByPath(files: GeneratedAppFile[], path: string): string | undefined {
  const normalized = path.replace(/\\/g, '/')
  return files.find((file) => file.path.replace(/\\/g, '/') === normalized)?.content
}

/**
 * Prominent database baseline for edit prompts — full schema plus immutable column checklist.
 */
function buildEditDatabaseContext(existingFiles: GeneratedAppFile[]): string {
  const schema = getFileContentByPath(existingFiles, 'prisma/schema.prisma')
  if (!schema?.trim()) {
    return ''
  }

  const fieldSummary = summarizePrismaScalarFields(schema)
  const sections = [
    '═══ LIVE DATABASE BASELINE (ALWAYS return this file; ADD columns only — NEVER edit/drop/retype existing fields) ═══',
    'Neon Postgres already has rows. Vercel runs prisma db push with no --accept-data-loss.',
    'ABSOLUTE: do not drop, omit, rename, retype, or edit any immutable scalar column. Unused columns stay in the schema.',
    'MANDATORY: every edit response MUST include prisma/schema.prisma — copy the schema below verbatim and ADD only new columns/models if needed.',
    '',
    'Immutable scalar columns (every name AND type must remain unchanged in your output — including createdAt / updatedAt):',
    fieldSummary || '(no models parsed)',
    '',
    '--- prisma/schema.prisma (SOURCE OF TRUTH — always return this file; add-only, do not regenerate) ---',
    schema,
  ]

  for (const path of EDIT_DATABASE_CONTEXT_PATHS) {
    if (path === 'prisma/schema.prisma') {
      continue
    }
    const content = getFileContentByPath(existingFiles, path)
    if (content?.trim()) {
      sections.push('', `--- ${path} ---`, content)
    }
  }

  return sections.join('\n')
}

/**
 * Prominent schema baseline for repair prompts — prefers the deployed schema
 * (pre-edit) over the current working copy so dropped columns are visible.
 */
function buildPrismaSchemaBaselineContext(
  files: GeneratedAppFile[],
  originalPrismaSchema?: string
): string {
  const schema = originalPrismaSchema?.trim()
    ? originalPrismaSchema
    : getFileContentByPath(files, 'prisma/schema.prisma')
  if (!schema?.trim()) {
    return ''
  }

  const fieldSummary = summarizePrismaScalarFields(schema)
  return [
    '═══ LIVE DATABASE SCHEMA BASELINE (prisma/schema.prisma as deployed — ADD columns only; NEVER drop/rename/retype existing ones) ═══',
    'The live Neon Postgres database matches this schema and has rows. Deploy runs prisma db push with NO --accept-data-loss, so ANY dropped or altered column fails the deploy with potential_dataloss.',
    'If you return prisma/schema.prisma, it MUST contain every model and every scalar column listed below unchanged (same name, same type, same attributes). You may ONLY ADD new models, columns, relations, or enums.',
    'If the current repository copy of prisma/schema.prisma is missing any column listed below, that is a bug — restore the missing column exactly as written here.',
    '',
    'Immutable scalar columns (every one must appear unchanged in any schema you return):',
    fieldSummary || '(no models parsed)',
    '',
    '--- prisma/schema.prisma (deployed baseline) ---',
    schema,
  ].join('\n')
}

/**
 * Serializes the current file set for repair and edit prompts so changes are
 * grounded in the real code instead of re-guessed from the app description.
 */
function buildRepairFileContext(
  files: GeneratedAppFile[],
  options: { extraSkipPaths?: Iterable<string> } = {}
): string {
  const skipPaths = new Set<string>([GENERATED_APP_REPO_SUMMARY_PATH, 'README.md', 'next-env.d.ts'])
  for (const path of options.extraSkipPaths ?? []) {
    skipPaths.add(path.replace(/\\/g, '/'))
  }
  const sections: string[] = []
  let total = 0

  for (const file of files) {
    const path = file.path.replace(/\\/g, '/')
    if (skipPaths.has(path)) {
      continue
    }

    const content =
      file.content.length > MAX_REPAIR_CONTEXT_FILE_CHARS
        ? `${file.content.slice(0, MAX_REPAIR_CONTEXT_FILE_CHARS)}\n…(truncated)`
        : file.content
    const section = `--- ${path} ---\n${content}`

    if (total + section.length > MAX_REPAIR_CONTEXT_TOTAL_CHARS) {
      sections.push(`--- ${path} --- (omitted for length)`)
      continue
    }

    total += section.length
    sections.push(section)
  }

  return sections.join('\n\n')
}

async function repairAppSpecWithLlm(
  spec: LlmAppSpec,
  buildLog: string,
  userInput: string,
  options: { originalPrismaSchema?: string } = {}
): Promise<LlmAppSpec> {
  const repairSystemPrompt = `You are a senior full-stack engineer fixing a Next.js ${PINNED_NEXT_VERSION} App Router project that failed pre-deploy validation (structure checks and/or npm install + prisma generate + next build in E2B).

Respond ONLY with JSON matching the provided schema.

The user message contains the CURRENT contents of every repository file. Treat them as the source of truth: read the files named in the build log, fix the reported errors with minimal targeted edits, and keep every cross-file contract (types, exports, prop names, Prisma fields) consistent with the files you are NOT changing.
Return ONLY the files you change or add — complete final contents for each returned file. Unchanged files are preserved automatically; do NOT echo them back, and do NOT rewrite files the build log does not implicate unless a fix requires it.

${GENERATED_APP_GENERATION_MANDATES}

${GENERATED_APP_ZERO_ERRORS_GUIDANCE}

Fix ALL errors in the build log so the app passes: npm install, prisma generate when Prisma is used, and next build with ZERO compile or prerender errors.
Fix ALL structure validation issues listed in the build log, including missing @/ imports, props interfaces, "use client" placement, Prisma usage, Tailwind config, and build scripts.
The build log below is the source of truth — resolve every error it reports, using the exact file names, symbols, and types it names. Do not guess at unrelated changes.
When the build log says "Missing file for import @/components/X", ADD components/X.tsx with full UI — every imported component must exist in files[].
When the build log says "imports X from @/lib/actions but lib/actions.ts does not export it", ADD \`export async function X\` to lib/actions.ts (implement the query the page needs) in the same response.
When the build log contains "Html should not be imported outside of pages/_document" or "Error occurred prerendering page \\"/404\\"", REPLACE app/not-found.tsx with the canonical zero-import template (plain <main> only — no layout components, no next/document, no <Html>); scan every file for remaining Html/Head/Main/NextScript usage and remove it.
Common TypeScript error codes and their generic fixes:
- TS18047 / TS2531 "possibly null": add \`if (!x) return\` guards after getContext('2d'), ref.current, .find(), getElementById, searchParams.get() — never use the \`!\` assertion
- TS2305 "has no exported member": export the missing symbol from the module that defines it, in the same response as the importer
- TS2307 "Cannot find module": add the imported package to package.json dependencies (and its @types/* to devDependencies when it ships no types)
- npm ETARGET / "No matching version found for caniuse-lite": REMOVE caniuse-lite, browserslist, and update-browserslist-db from package.json dependencies, devDependencies, and overrides — do NOT pin them; delete any package-lock.json
- TS2322 "IntrinsicAttributes & XxxClientProps" / missing prop: make page JSX prop names exactly match the Client component's Props interface; include every prop; update page AND component together
- TS2322/TS2538/TS2464 involving \`unknown\`: replace \`unknown\`/\`unknown[]\` props and \`.map()\` params with concrete interfaces from lib/types.ts (string ids/labels)
- TS1109 "Expression expected": usually a split import — give each package its own \`import { ... } from '...'\` block
- TS2459 "declares X locally, but it is not exported": import the type from @/lib/types, not @/lib/actions
- TS2304 "Cannot find name": add the missing \`import type\` (from @/lib/types) or define the type locally
- TS2345 "Date not assignable to string": widen date/time helpers to accept \`string | Date\`, or pass \`.toISOString()\`
- TS1005 "'>' expected": fix JSX — \`return (\` with the opening tag on one line, never \`return\` then a newline before \`<\`
- TS2353/TS2339/TS2551 in lib/actions.ts: align Prisma include/select keys and field access with prisma/schema.prisma; keep lib/types.ts in sync
If the build log flags localStorage/sessionStorage usage, replace every occurrence with Prisma server actions or API routes — NEVER store app data in localStorage.
${GENERATED_APP_COMMON_FAILURES_GUIDANCE}
${GENERATED_APP_DEPENDENCY_GUIDANCE}
${GENERATED_APP_TYPESCRIPT_GUIDANCE}
${GENERATED_APP_NULL_SAFETY_GUIDANCE}
${GENERATED_APP_STYLING_GUIDANCE}
${GENERATED_APP_IMPORT_GUIDANCE}
${GENERATED_APP_COMPONENT_FILES_GUIDANCE}
${GENERATED_APP_PAGE_CLIENT_CONTRACT_GUIDANCE}
${GENERATED_APP_JSX_GUIDANCE}
${GENERATED_APP_APP_ROUTER_DOCUMENT_GUIDANCE}
${GENERATED_APP_DATABASE_EDIT_GUIDANCE}
${GENERATED_APP_PRISMA_ALIGNMENT_GUIDANCE}
${GENERATED_APP_AUTH_GUIDANCE}
${GENERATED_APP_README_GUIDANCE}
${GENERATED_APP_REPO_SUMMARY_GUIDANCE}
${GENERATED_APP_NO_TESTS_GUIDANCE}
${GENERATED_APP_VALIDATION_GUIDANCE}
When the user message contains a "LIVE DATABASE SCHEMA BASELINE" section, that schema is the authoritative shape of the live database: any prisma/schema.prisma you return MUST be a strict superset of it — every listed model and scalar column unchanged, additions only, drops NEVER.
When fixing prisma/schema.prisma errors: RESTORE any dropped columns (e.g. updatedAt DateTime @updatedAt). Never "fix" a deploy by removing fields — add defaults or optionality instead.
When the build log contains "potential_dataloss", "--accept-data-loss", or "You are about to drop the column \`X\` on the \`Y\` table": the LIVE database still has column X even if the current schema file omits it — ADD column X back to model Y in prisma/schema.prisma with its original name/type plus @default(...) (e.g. \`updatedAt DateTime @updatedAt @default(now())\`) or optional ?. NEVER resolve it by leaving the column out, adding --accept-data-loss / --force-reset, or editing the build script — restoring the column in the schema is the ONLY valid fix.
Keep the same app purpose and repo name unless a rename is required to fix the build.
Prefer minimal, targeted file changes over rewriting unrelated files.
Do not leave broken imports, invalid JSX, or conflicting app/ and src/app/ directories.`

  const schemaBaseline = buildPrismaSchemaBaselineContext(spec.files, options.originalPrismaSchema)

  const userPrompt = `Original request:\n${userInput}

App name: ${spec.appName}
Repository name: ${spec.repoName}

${schemaBaseline ? `${schemaBaseline}\n\n` : ''}Build log (errors to fix):
${truncateBuildLog(buildLog)}

Current repository files (source of truth — fix the errors above IN this code):

${buildRepairFileContext(spec.files)}

Return ONLY the files you changed or added (complete final contents each) so the app passes npm install, prisma generate (when used), and next build.`

  const repaired = await requestFullAppSpecFromLlm(repairSystemPrompt, userPrompt, spec.repoName, {
    preserveAllFiles: spec.files.length > MAX_GENERATED_FILES,
    skipFileNormalization: true,
  })

  const mergedFiles = mergeEditedFiles(spec.files, repaired.files)

  return normalizeAppSpec(
    {
      ...spec,
      appName: repaired.appName || spec.appName,
      description: repaired.description || spec.description,
      features: repaired.features?.length ? repaired.features : spec.features,
      requiresDatabase: repaired.requiresDatabase ?? spec.requiresDatabase,
      repoName: spec.repoName,
      files: mergedFiles,
    },
    spec.repoName,
    { preserveAllFiles: true, latestUserRequest: userInput }
  )
}

async function writeAppFiles(outputDir: string, files: GeneratedAppFile[]): Promise<number> {
  let written = 0

  for (const file of files) {
    const safePath = sanitizeRelativeFilePath(file.path)
    if (!safePath) {
      logger.warn('Skipping unsafe generated file path', { path: file.path })
      continue
    }
    if (typeof file.content !== 'string') {
      logger.warn('Skipping generated file with non-string content', { path: file.path })
      continue
    }

    const fullPath = join(/* turbopackIgnore: true */ outputDir, safePath)
    await mkdir(dirname(fullPath), { recursive: true })
    await writeFile(fullPath, file.content, 'utf-8')
    written++
  }

  return written
}

interface BuildRepairResult {
  spec: LlmAppSpec
  buildValidated: boolean
  buildOutput: string
  repairRounds: number
}

function startGitHubRepositoryPrepIfConfigured(params: {
  repoName: string
  description: string
  githubToken?: string
  vercelToken?: string
  githubOwner?: string
  privateRepo?: boolean
}): ReturnType<typeof ensureGitHubRepository> | null {
  if (!params.githubToken || !params.vercelToken) {
    return null
  }

  logger.info('Ensuring GitHub repository in parallel with validation', {
    repoName: params.repoName,
  })

  return ensureGitHubRepository({
    repoName: params.repoName,
    description: params.description,
    githubToken: params.githubToken,
    githubOwner: params.githubOwner,
    privateRepo: params.privateRepo,
  })
}

/**
 * Runs structure validation, fast compile checks (with LLM repair), then one final production build.
 */
interface ValidateAndRepairOptions {
  /** Deployed prisma/schema.prisma content — enables db push migration-safety checks on edits. */
  originalPrismaSchema?: string
  /** When true, keep Arena iframe emailId scaffold during repair normalization. */
  arenaMode?: boolean
}

async function validateAndRepairUntilBuildPasses(
  outputDir: string,
  spec: LlmAppSpec,
  userInput: string,
  options: ValidateAndRepairOptions = {}
): Promise<BuildRepairResult> {
  let currentSpec = spec
  let buildOutput = ''
  let repairRounds = 0
  const validationOptions = { requiresDatabase: DEVELOPMENT_REQUIRES_DATABASE }

  for (let round = 0; round <= MAX_BUILD_REPAIR_ROUNDS; round++) {
    currentSpec.requiresDatabase = resolveRequiresDatabase(currentSpec)
    currentSpec.files = normalizeGeneratedAppFiles(currentSpec.files, {
      requiresDatabase: DEVELOPMENT_REQUIRES_DATABASE,
      appName: currentSpec.appName,
      description: currentSpec.description,
      features: currentSpec.features,
      repoName: currentSpec.repoName,
      latestUserRequest: userInput,
      arenaMode: options.arenaMode ?? isArenaMode(),
    })
    await writeAppFiles(outputDir, currentSpec.files)

    const structureResult = validateGeneratedAppStructure(currentSpec.files, {
      requiresDatabase: DEVELOPMENT_REQUIRES_DATABASE,
      originalPrismaSchema: options.originalPrismaSchema,
    })

    if (!structureResult.valid) {
      buildOutput = `Structure validation failed:\n${formatStructureValidationIssues(structureResult.issues)}`
      logGeneratedAppValidationErrors({
        phase: 'structure',
        round,
        output: buildOutput,
        issues: structureResult.issues,
      })

      if (round >= MAX_BUILD_REPAIR_ROUNDS) {
        break
      }

      repairRounds += 1
      logger.warn('Generated app structure validation failed, requesting LLM repair', {
        round: repairRounds,
        issueCount: structureResult.issues.length,
      })

      currentSpec = await repairAppSpecWithLlm(
        currentSpec,
        `${buildOutput}\n\nFix every structure issue above before the app can build.`,
        userInput,
        { originalPrismaSchema: options.originalPrismaSchema }
      )
      continue
    }

    const fastResult = await validateGeneratedAppPreDeploy(
      outputDir,
      currentSpec.files,
      validationOptions
    )
    buildOutput = `[${fastResult.method}:typecheck] ${fastResult.output}`

    if (!fastResult.validated) {
      logGeneratedAppValidationErrors({
        phase: 'typecheck',
        round,
        output: fastResult.output,
      })

      if (round >= MAX_BUILD_REPAIR_ROUNDS) {
        break
      }

      repairRounds += 1
      logger.warn('Generated app typecheck failed, requesting LLM repair', {
        round: repairRounds,
        maxRounds: MAX_BUILD_REPAIR_ROUNDS,
        method: fastResult.method,
      })

      currentSpec = await repairAppSpecWithLlm(currentSpec, fastResult.output, userInput, {
        originalPrismaSchema: options.originalPrismaSchema,
      })

      const nextCacheDir = join(/* turbopackIgnore: true */ outputDir, '.next')
      if (existsSync(nextCacheDir)) {
        await rm(nextCacheDir, { recursive: true, force: true })
      }
      continue
    }

    const finalResult = await validateGeneratedAppProductionBuild(
      outputDir,
      currentSpec.files,
      validationOptions
    )
    buildOutput = `[${fastResult.method}:typecheck]\n${fastResult.output}\n\n[${finalResult.method}:build]\n${finalResult.output}`

    if (finalResult.validated) {
      return {
        spec: currentSpec,
        buildValidated: true,
        buildOutput,
        repairRounds,
      }
    }

    logGeneratedAppValidationErrors({
      phase: 'build',
      round,
      output: finalResult.output,
    })

    if (round >= MAX_BUILD_REPAIR_ROUNDS) {
      break
    }

    repairRounds += 1
    logger.warn('Generated app production build failed, requesting LLM repair', {
      round: repairRounds,
      maxRounds: MAX_BUILD_REPAIR_ROUNDS,
      method: finalResult.method,
    })

    currentSpec = await repairAppSpecWithLlm(currentSpec, finalResult.output, userInput, {
      originalPrismaSchema: options.originalPrismaSchema,
    })

    const nextCacheDir = join(/* turbopackIgnore: true */ outputDir, '.next')
    if (existsSync(nextCacheDir)) {
      await rm(nextCacheDir, { recursive: true, force: true })
    }
  }

  return {
    spec: currentSpec,
    buildValidated: false,
    buildOutput,
    repairRounds,
  }
}

const DB_PUSH_UNEXECUTABLE_PATTERN =
  /cannot be executed|without a default value|--force-reset|not possible to execute|data loss|dataloss|drop the column/i
const MAX_DB_SCHEMA_REPAIR_ROUNDS = 2

interface DatabaseSyncWithRepairResult {
  spec: LlmAppSpec
  applied: boolean
  /** Set when the live database rejects the schema even after repairs — deploy must be blocked. */
  blockingError?: string
}

/**
 * Applies the Prisma schema to the live Neon database before git push. When db push
 * reports an unexecutable change (e.g. a new required column without @default on a
 * table with rows), requests LLM schema repair and retries — this is the only check
 * that can catch drift between the committed schema and the live database.
 */
async function syncDatabaseWithSchemaRepair(params: {
  outputDir: string
  spec: LlmAppSpec
  userInput: string
  repoName: string
  databaseUrl?: string
  neonProjectId?: string
  neonApiKey?: string
  originalPrismaSchema?: string
}): Promise<DatabaseSyncWithRepairResult> {
  let spec = params.spec

  for (let attempt = 0; attempt <= MAX_DB_SCHEMA_REPAIR_ROUNDS; attempt++) {
    const result = await prepareGeneratedAppForDatabaseDeploy({
      outputDir: params.outputDir,
      files: spec.files,
      summaryOptions: {
        appName: spec.appName,
        description: spec.description,
        features: spec.features,
        repoName: params.repoName,
        requiresDatabase: DEVELOPMENT_REQUIRES_DATABASE,
        latestUserRequest: params.userInput,
        neonProjectId: params.neonProjectId,
      },
      databaseUrl: params.databaseUrl,
      neonProjectId: params.neonProjectId,
      neonApiKey: params.neonApiKey,
      originalPrismaSchema: params.originalPrismaSchema,
    })

    if (!result.error) {
      return { spec, applied: result.applied }
    }

    const output = [result.output, result.error].filter(Boolean).join('\n')
    if (!DB_PUSH_UNEXECUTABLE_PATTERN.test(output)) {
      logger.warn(
        'Database schema sync failed (non-schema error) — continuing, Vercel build will retry db push',
        {
          repoName: params.repoName,
          error: result.error,
        }
      )
      return { spec, applied: false }
    }

    if (attempt >= MAX_DB_SCHEMA_REPAIR_ROUNDS) {
      return {
        spec,
        applied: false,
        blockingError: `prisma db push cannot apply the schema to the live database (deploy blocked to avoid a guaranteed Vercel invalid_db_setup failure):\n${truncateBuildLog(output)}`,
      }
    }

    logger.warn('Live database rejected schema change, requesting LLM schema repair', {
      repoName: params.repoName,
      attempt: attempt + 1,
      maxAttempts: MAX_DB_SCHEMA_REPAIR_ROUNDS,
    })

    spec = await repairAppSpecWithLlm(
      spec,
      [
        'prisma db push against the LIVE database failed — the tables have existing rows and the schema change cannot be executed:',
        truncateBuildLog(output),
        '',
        'Fix prisma/schema.prisma so prisma db push succeeds WITHOUT --force-reset and WITHOUT dropping data:',
        '- RESTORE every dropped column named in the error (e.g. updatedAt DateTime @updatedAt) — do not leave them removed',
        '- Every new required column named in the error MUST get @default(...) — DateTime columns: @default(now()) (keep @updatedAt if present); String/Int/Boolean/enum: a sensible domain default — or become optional with ?',
        '- Do NOT remove or rename existing models or columns, and do NOT change existing column types',
        '- Keep lib/actions.ts and lib/types.ts aligned with the corrected schema',
      ].join('\n'),
      params.userInput,
      { originalPrismaSchema: params.originalPrismaSchema }
    )
    await writeAppFiles(params.outputDir, spec.files)
  }

  return { spec, applied: false }
}

/**
 * Generates a production-ready Next.js app from user input and writes it under generated-apps/.
 */
export async function generateNextjsApp(
  input: GenerateNextjsAppInput
): Promise<GenerateNextjsAppResult> {
  const userInput = input.userInput?.trim()
  if (!userInput) {
    return { success: false, error: 'userInput is required' }
  }

  return runWithLlmUsageTracking(async () => {
    const result = await runWithArenaMode(input.arenaMode === true, () =>
      generateNextjsAppInner(input, userInput)
    )
    const llmUsage = getTrackedLlmUsage()
    return llmUsage ? { ...result, llmUsage } : result
  })
}

async function generateNextjsAppInner(
  input: GenerateNextjsAppInput,
  userInput: string
): Promise<GenerateNextjsAppResult> {
  try {
    const generationStartedAt = Date.now()
    let spec = await generateAppSpecWithLlm(userInput, input.repoName?.trim(), input.referenceImage)
    logger.info('LLM app generation finished', {
      durationMs: Date.now() - generationStartedAt,
      fileCount: spec.files.length,
      requiresDatabase: DEVELOPMENT_REQUIRES_DATABASE,
      hasReferenceImage: Boolean(input.referenceImage),
    })

    const repoName = slugifyRepoName(input.repoName?.trim() || spec.repoName)
    const outputDir = getGeneratedAppDir(repoName)
    const monorepoRoot = findMonorepoRoot()

    await mkdir(outputDir, { recursive: true })
    const fileCount = await writeAppFiles(outputDir, spec.files)

    if (fileCount === 0) {
      return { success: false, error: 'No valid files were written to the output directory' }
    }

    let buildValidated: boolean | undefined
    let buildOutput: string | undefined
    const outputPath = relative(monorepoRoot, outputDir)

    const deployEnvEarly = resolveDevelopmentDeployEnv()
    const githubRepoPrep = startGitHubRepositoryPrepIfConfigured({
      repoName,
      description: spec.description,
      githubToken: deployEnvEarly.githubToken,
      vercelToken: deployEnvEarly.vercelToken,
      githubOwner: deployEnvEarly.githubOwner,
      privateRepo: input.privateRepo === true,
    })

    const buildRepair = await validateAndRepairUntilBuildPasses(outputDir, spec, userInput)
    spec = buildRepair.spec
    spec.requiresDatabase = DEVELOPMENT_REQUIRES_DATABASE
    buildValidated = buildRepair.buildValidated
    buildOutput = buildRepair.buildOutput

    if (!buildValidated) {
      const errorSummary = formatBuildErrorsSummary(buildOutput ?? '')

      return {
        success: false,
        error: `App validation failed after ${buildRepair.repairRounds} repair round(s):\n${errorSummary || truncateBuildLog(buildOutput ?? '')}`,
        appName: spec.appName,
        repoName,
        description: spec.description,
        features: spec.features,
        outputPath,
        absoluteOutputPath: outputDir,
        fileCount,
        buildValidated: false,
        buildOutput,
      }
    }

    let gitPushed = false
    let githubHtmlUrl: string | undefined
    let githubCloneUrl: string | undefined
    let githubOwner: string | undefined
    let githubRepoName: string | undefined
    let gitPushError: string | undefined

    const {
      githubToken,
      githubOwner: githubOwnerHint,
      vercelToken,
      vercelTeamId,
      neonIntegrationConfigurationId,
      neonApiKey,
      neonOrgId,
    } = resolveDevelopmentDeployEnv()

    let vercelDeployed = false
    let vercelUrl: string | undefined
    let vercelDeploymentUrl: string | undefined
    let vercelProjectId: string | undefined
    let vercelDeploymentId: string | undefined
    let vercelInspectorUrl: string | undefined
    let vercelDeployError: string | undefined
    let databaseProvisioned: boolean | undefined
    let neonProjectId: string | undefined
    let databaseProvisionError: string | undefined
    let preparedVercelProjectName: string | undefined

    if (!githubToken) {
      gitPushError = 'DEVELOPMENT_GITHUB_TOKEN is not set in the environment.'
    } else if (!vercelToken) {
      vercelDeployError = 'DEVELOPMENT_VERCEL_TOKEN is not set in the environment.'
    } else {
      logger.info('Using GitHub repository prepared during validation', { repoName })
      const repoResult = githubRepoPrep
        ? await githubRepoPrep
        : await ensureGitHubRepository({
            repoName,
            description: spec.description,
            githubToken,
            githubOwner: githubOwnerHint,
            privateRepo: input.privateRepo === true,
          })

      if (!repoResult.success || !repoResult.owner || !repoResult.repoName) {
        gitPushError = repoResult.error ?? 'Failed to create or resolve GitHub repository'
        vercelDeployError = gitPushError
      } else {
        githubOwner = repoResult.owner
        githubRepoName = repoResult.repoName
        githubHtmlUrl = repoResult.htmlUrl
        githubCloneUrl = repoResult.cloneUrl

        logger.info('Preparing Vercel project and Neon before git push', { repoName })
        const prepareResult = await prepareVercelProjectForDeploy({
          vercelToken,
          projectName: repoName,
          githubOwner,
          githubRepoName,
          vercelTeamId,
          requiresDatabase: DEVELOPMENT_REQUIRES_DATABASE,
          neonIntegrationConfigurationId,
          neonApiKey,
          neonOrgId,
        })

        vercelProjectId = prepareResult.vercelProjectId
        preparedVercelProjectName = prepareResult.vercelProjectName
        databaseProvisioned = prepareResult.databaseProvisioned
        neonProjectId = prepareResult.neonProjectId
        databaseProvisionError = prepareResult.databaseProvisionError

        if (!prepareResult.success || !vercelProjectId || !preparedVercelProjectName) {
          vercelDeployError = prepareResult.error ?? 'Failed to prepare Vercel project'
        } else {
          const dbSyncResult = await syncDatabaseWithSchemaRepair({
            outputDir,
            spec,
            userInput,
            repoName,
            databaseUrl: prepareResult.databaseUrl,
            neonProjectId: prepareResult.neonProjectId,
            neonApiKey,
          })
          spec = dbSyncResult.spec

          if (dbSyncResult.blockingError) {
            vercelDeployError = dbSyncResult.blockingError
            databaseProvisionError = dbSyncResult.blockingError
          } else {
            logger.info('Pushing generated app to GitHub', { repoName })
            const pushResult = await pushGeneratedAppToGitHub({
              outputDir,
              repoName,
              description: spec.description,
              githubToken,
              githubOwner,
              privateRepo: input.privateRepo === true,
            })
            gitPushed = pushResult.success
            githubHtmlUrl = pushResult.htmlUrl ?? githubHtmlUrl
            githubCloneUrl = pushResult.cloneUrl ?? githubCloneUrl
            githubOwner = pushResult.owner ?? githubOwner
            githubRepoName = pushResult.repoName ?? githubRepoName
            gitPushError = pushResult.error

            if (!gitPushed || !githubOwner || !githubRepoName) {
              vercelDeployError =
                gitPushError ??
                'Vercel deploy requires a successful GitHub push. Check DEVELOPMENT_GITHUB_TOKEN in .env and git push errors.'
            } else {
              logger.info('Deploying to Vercel (can take several minutes)', { repoName })
              const deployResult = await deployPreparedVercelProject({
                vercelToken,
                vercelProjectId,
                vercelProjectName: preparedVercelProjectName,
                githubOwner,
                githubRepoName,
                githubToken,
                outputDir,
                vercelTeamId,
                gitRef: pushResult.defaultBranch ?? 'main',
                gitCommitSha: pushResult.commitSha,
                gitHubRepoId: pushResult.repoId,
                databaseProvisioned,
                neonProjectId,
              })

              vercelDeployed = deployResult.success
              vercelUrl = deployResult.vercelUrl
              vercelDeploymentUrl = deployResult.vercelDeploymentUrl
              vercelProjectId = deployResult.vercelProjectId ?? vercelProjectId
              vercelDeploymentId = deployResult.vercelDeploymentId
              vercelInspectorUrl = deployResult.vercelInspectorUrl
              vercelDeployError = deployResult.error
            }
          }
        }
      }
    }

    if (!vercelDeployed) {
      return {
        success: false,
        error: vercelDeployError ?? 'Vercel deployment failed',
        appName: spec.appName,
        repoName,
        description: spec.description,
        features: spec.features,
        outputPath,
        absoluteOutputPath: outputDir,
        fileCount,
        buildValidated,
        buildOutput,
        gitPushed,
        githubHtmlUrl,
        githubCloneUrl,
        githubOwner,
        githubRepoName,
        gitPushError,
        vercelDeployed: false,
        vercelDeployError,
        requiresDatabase: DEVELOPMENT_REQUIRES_DATABASE,
        databaseProvisioned,
        neonProjectId,
        databaseProvisionError,
      }
    }

    let resolvedAbsoluteOutputPath: string | undefined = outputDir

    const shouldRemoveLocal = gitPushed && vercelDeployed

    if (shouldRemoveLocal) {
      try {
        await rm(outputDir, { recursive: true, force: true })
        resolvedAbsoluteOutputPath = undefined
        logger.info('Removed local generated app folder after publish', { outputDir, repoName })
      } catch (cleanupError) {
        logger.warn('Failed to remove local generated app folder', {
          outputDir,
          error: toError(cleanupError).message,
        })
      }
    }

    logger.info('Next.js app generated', {
      appName: spec.appName,
      repoName,
      outputDir,
      fileCount,
      buildValidated,
      gitPushed,
      githubHtmlUrl,
      vercelDeployed,
      vercelUrl,
      localRemoved: shouldRemoveLocal && !resolvedAbsoluteOutputPath,
    })

    return {
      success: true,
      appName: spec.appName,
      repoName,
      description: spec.description,
      features: spec.features,
      outputPath,
      absoluteOutputPath: resolvedAbsoluteOutputPath,
      fileCount,
      buildValidated,
      buildOutput,
      gitPushed,
      githubHtmlUrl,
      githubCloneUrl,
      githubOwner,
      githubRepoName,
      gitPushError,
      vercelDeployed,
      vercelUrl,
      vercelDeploymentUrl,
      vercelProjectId,
      vercelDeploymentId,
      vercelInspectorUrl,
      vercelDeployError,
      requiresDatabase: DEVELOPMENT_REQUIRES_DATABASE,
      databaseProvisioned,
      neonProjectId,
      databaseProvisionError,
    }
  } catch (error) {
    const message = toError(error).message
    logger.error('Next.js app generation failed', { error: message })
    return { success: false, error: message }
  }
}

export interface EditNextjsAppInput {
  userInput: string
  repoName: string
  referenceImage?: DevelopmentReferenceMedia
  /** When true, inject Arena iframe emailId scaffold and Arena system-prompt mandates. */
  arenaMode?: boolean
}

const EDIT_APP_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    appName: { type: 'string' },
    description: { type: 'string' },
    features: { type: 'array', items: { type: 'string' } },
    requiresDatabase: { type: 'boolean' },
    files: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string' },
        },
        required: ['path', 'content'],
        additionalProperties: false,
      },
    },
  },
  required: ['appName', 'description', 'features', 'requiresDatabase', 'files'],
  additionalProperties: false,
}

/** Edit-mode only — never included in generate or repair prompts. */
const EDIT_APP_PRISMA_SCHEMA_PRESERVATION = `═══ EDIT MODE: prisma/schema.prisma — ALWAYS RETURN; ADD ONLY; NEVER EDIT EXISTING COLUMNS ═══
This repository is ALREADY deployed. Neon Postgres has REAL ROWS. Vercel build runs:
  prisma generate && prisma db push && next build
There is NO --accept-data-loss. Dropping or altering a column FAILS the deploy (potential_dataloss / unexecutable).

ABSOLUTE RULES:
1. ALWAYS include prisma/schema.prisma in EVERY edit response when the app has a database — even if you did not change the schema (echo the baseline file verbatim).
2. NEVER edit an existing column. Do not change its name, data type, nullability, @default, @unique, @id, @updatedAt, @map, or @relation attributes. Leave existing field lines byte-for-byte identical.
3. NEVER change data types of existing columns (String/Int/Boolean/DateTime/Json/enum/etc.). If you need a different type, ADD a NEW column instead.
4. NEVER drop ANY database column. Not for cleanup. Not for refactor. Not to "match the UI". Not because a field looks unused. Leave unused columns in the schema.

FORBIDDEN on edit (will break production):
- Dropping, omitting, renaming, retyping, or modifying ANY existing column (id, createdAt, updatedAt, email, title, name, status, FKs — every scalar on every model)
- Changing an existing field's type or attributes in any way — ADD a new column instead
- Regenerating prisma/schema.prisma from scratch, from REPO_SUMMARY, or from memory
- Returning a "simplified", "cleaned up", or "normalized" schema with fewer or altered fields than the input file
- Removing \`updatedAt DateTime @updatedAt\` or \`createdAt DateTime @default(now())\` from any model that already has them

REQUIRED workflow for prisma/schema.prisma on every edit:
1. Locate prisma/schema.prisma in the user message — that exact file is your baseline.
2. Copy it in full into your response files array (mandatory every edit).
3. Change NOTHING on existing lines. ADD ONLY: new models, new scalar fields, new relations, new enums.
4. New fields on existing models: use ? or @default(...). DateTime @updatedAt on existing models also needs @default(now()).
5. Before returning: verify EVERY scalar field from the baseline / LIVE DATABASE BASELINE still appears unchanged in your output. If Project had "updatedAt DateTime @updatedAt", it MUST still be there with the same type and attributes.
6. If UI no longer uses a column, stop selecting it in lib/actions.ts — do NOT remove or alter it in the schema.
7. When you ADD models/fields/relations, also return lib/actions.ts and lib/types.ts in the same response.

LIVE-DATABASE DRIFT RECOVERY (the LIVE database outranks the baseline file):
- The baseline schema file can be MISSING columns that still exist in the live database (a previous bad edit removed them from the file). Echoing such a baseline verbatim re-triggers the drop and fails every deploy with potential_dataloss.
- If the edit request, a build log, or a deploy error contains "potential_dataloss", "--accept-data-loss", or "You are about to drop the column \`X\` on the \`Y\` table": the live table HAS column X — you MUST ADD column X back to model Y in prisma/schema.prisma with its original name and type. Re-adding a live column is additive and always allowed.
- When re-adding a dropped column, make it executable against existing rows: \`updatedAt DateTime @updatedAt @default(now())\`, \`createdAt DateTime @default(now())\`, other required scalars get @default(...) or become optional with ?.
- NEVER "resolve" a potential_dataloss error by keeping the column removed, adding --accept-data-loss, adding --force-reset, or changing the build script — the ONLY fix is restoring the column in the schema.

FINAL SELF-CHECK before returning (mandatory): for EVERY model, compare your output field list against the "Immutable scalar columns" list in the LIVE DATABASE BASELINE. Every listed column MUST appear in your output with identical name, type, and attributes, PLUS any column a deploy error said would be dropped. If even one is missing, your response is wrong — fix it before returning.

The user's edit request is about NEW functionality — it is NOT permission to edit, retype, rename, or remove existing database columns. Always add new columns for new data.`

const EDIT_APP_SYSTEM_PROMPT = `You are a senior full-stack engineer editing an existing Next.js ${PINNED_NEXT_VERSION} App Router project (React ${PINNED_REACT_VERSION}).

Respond ONLY with JSON matching the provided schema.

${EDIT_APP_PRISMA_SCHEMA_PRESERVATION}

The user message contains the CURRENT contents of SELECTED repository files (not necessarily the full tree). Treat them as the source of truth: when you modify a file, start from its existing content and apply the requested change — never regenerate a file from scratch based on its name or the summary. Keep every cross-file contract (types, exports, prop names, Prisma fields, function signatures) consistent with files you are NOT changing.

${GENERATED_APP_GENERATION_MANDATES}

Constraints:
- Apply the user's requested changes while preserving working architecture and unrelated code
- Return ONLY files you create or modify — EXCEPTION: when the app uses a database, ALWAYS return the full prisma/schema.prisma (unchanged echo or additive update)
- Every returned file must contain complete, real, working code — no stubs or placeholders
- ${GENERATED_APP_ZERO_ERRORS_GUIDANCE}
- ${GENERATED_APP_COMMON_FAILURES_GUIDANCE}
- ${GENERATED_APP_DEPENDENCY_GUIDANCE}
- ${GENERATED_APP_TYPESCRIPT_GUIDANCE}
- ${GENERATED_APP_NULL_SAFETY_GUIDANCE}
- ${GENERATED_APP_STYLING_GUIDANCE}
- ${GENERATED_APP_IMPORT_GUIDANCE}
- ${GENERATED_APP_COMPONENT_FILES_GUIDANCE}
- ${GENERATED_APP_PAGE_CLIENT_CONTRACT_GUIDANCE}
- ${GENERATED_APP_JSX_GUIDANCE}
- ${GENERATED_APP_APP_ROUTER_DOCUMENT_GUIDANCE}
- ${GENERATED_APP_PRISMA_ALIGNMENT_GUIDANCE}
- ${GENERATED_APP_AUTH_GUIDANCE}
- ${GENERATED_APP_DATABASE_EDIT_GUIDANCE}
- ALWAYS return prisma/schema.prisma on every database-backed edit; when you ADD schema fields also return lib/actions.ts and lib/types.ts — aligned includes, t.field access, and DTO field names
- When editing prisma/schema.prisma or lib/types.ts, keep exports in sync — export every type from lib/types.ts and import it with \`import type\` in components; import server actions (not types) from lib/actions.ts
- ${GENERATED_APP_README_GUIDANCE}
- ${GENERATED_APP_REPO_SUMMARY_GUIDANCE}
- Read REPO_SUMMARY.md in the user message before editing — it is the primary architecture reference
- Do not return REPO_SUMMARY.md unless you must fix it manually; Sim regenerates it after your edits
- ${GENERATED_APP_NO_TESTS_GUIDANCE}
- ${GENERATED_APP_VALIDATION_GUIDANCE}
- NEVER use localStorage.setItem or sessionStorage.setItem to persist app data
- Valid TypeScript, zero syntax/semantic/build errors, no secrets`

function mergeEditedFiles(
  existingFiles: GeneratedAppFile[],
  editedFiles: GeneratedAppFile[]
): GeneratedAppFile[] {
  const byPath = new Map<string, GeneratedAppFile>()
  for (const file of existingFiles) {
    byPath.set(file.path.replace(/\\/g, '/'), file)
  }
  for (const file of editedFiles) {
    byPath.set(file.path.replace(/\\/g, '/'), file)
  }
  return [...byPath.values()]
}

function inferAppMetadataFromFiles(
  repoName: string,
  existingFiles: GeneratedAppFile[]
): Pick<LlmAppSpec, 'appName' | 'description' | 'features' | 'requiresDatabase'> {
  const readme = existingFiles.find((file) => file.path === 'README.md')?.content ?? ''
  const packageJsonFile = existingFiles.find((file) => file.path === 'package.json')
  let appName = repoName
  if (packageJsonFile) {
    try {
      const parsed = JSON.parse(packageJsonFile.content) as { name?: string }
      if (parsed.name) {
        appName = parsed.name
      }
    } catch {
      // ignore invalid package.json
    }
  }

  const description =
    readme
      .split('\n')
      .map((line) => line.trim())
      .find((line) => line.length > 0)
      ?.replace(/^#\s*/, '') ?? `Edited ${repoName}`

  return {
    appName,
    description,
    features: [],
    requiresDatabase: resolveRequiresDatabase({
      requiresDatabase: undefined,
      files: existingFiles,
    }),
  }
}

function normalizeGeneratedAppPath(path: string): string {
  return path.replace(/\\/g, '/')
}

function indexGeneratedAppFiles(files: GeneratedAppFile[]): Map<string, GeneratedAppFile> {
  const byPath = new Map<string, GeneratedAppFile>()
  for (const file of files) {
    byPath.set(normalizeGeneratedAppPath(file.path), file)
  }
  return byPath
}

function collectPinnedEditPaths(
  byPath: Map<string, GeneratedAppFile>,
  requiresDatabase: boolean
): string[] {
  const pins: string[] = []
  for (const path of EDIT_ALWAYS_PIN_PATHS) {
    if (byPath.has(path)) {
      pins.push(path)
    }
  }
  if (requiresDatabase) {
    for (const path of EDIT_DATABASE_CONTEXT_PATHS) {
      if (byPath.has(path) && !pins.includes(path)) {
        pins.push(path)
      }
    }
  }
  return pins
}

/**
 * Scores repo paths against tokens from the user edit request for empty-selection fallback.
 */
function selectHeuristicEditPaths(
  userInput: string,
  existingPaths: string[],
  maxPaths: number
): string[] {
  const tokens = userInput
    .toLowerCase()
    .split(/[^a-z0-9_./-]+/)
    .filter((token) => token.length > 2)
  if (tokens.length === 0) {
    return []
  }

  const scored: Array<{ path: string; score: number }> = []
  for (const path of existingPaths) {
    const lower = path.toLowerCase()
    let score = 0
    for (const token of tokens) {
      if (lower.includes(token)) {
        score += 1
      }
    }
    if (score > 0) {
      scored.push({ path, score })
    }
  }

  scored.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path))
  return scored.slice(0, maxPaths).map((entry) => entry.path)
}

/**
 * Merges LLM-selected paths with pinned anchors; falls back to keyword matches when empty.
 */
function resolveEditContextPaths(
  requestedPaths: string[],
  existingFiles: GeneratedAppFile[],
  requiresDatabase: boolean,
  userInput: string
): string[] {
  const byPath = indexGeneratedAppFiles(existingFiles)
  const pins = collectPinnedEditPaths(byPath, requiresDatabase)
  const pinSet = new Set(pins)
  const seen = new Set<string>()
  const others: string[] = []

  const tryAddOther = (path: string) => {
    const normalized = normalizeGeneratedAppPath(path)
    if (!byPath.has(normalized) || pinSet.has(normalized) || seen.has(normalized)) {
      return
    }
    if (others.length >= MAX_EDIT_SELECTED_PATHS) {
      return
    }
    seen.add(normalized)
    others.push(normalized)
  }

  for (const path of requestedPaths) {
    tryAddOther(path)
  }

  if (others.length === 0) {
    for (const path of selectHeuristicEditPaths(
      userInput,
      [...byPath.keys()],
      MAX_EDIT_SELECTED_PATHS
    )) {
      tryAddOther(path)
    }
  }

  return [...pins, ...others]
}

function buildRepoSummaryForEdit(
  repoName: string,
  metadata: Pick<LlmAppSpec, 'appName' | 'description' | 'features' | 'requiresDatabase'>,
  existingFiles: GeneratedAppFile[]
): string {
  const summaryOptions = {
    appName: metadata.appName,
    description: metadata.description,
    features: metadata.features,
    repoName,
    requiresDatabase: metadata.requiresDatabase,
  }
  const filesWithSummary = ensureRepoSummaryFile(existingFiles, summaryOptions)
  return (
    filesWithSummary.find((file) => file.path === GENERATED_APP_REPO_SUMMARY_PATH)?.content ??
    buildRepoSummaryContent(filesWithSummary, summaryOptions)
  )
}

/**
 * Structure-only context for the edit select pass — no file bodies.
 */
function buildEditStructureContext(
  repoName: string,
  metadata: Pick<LlmAppSpec, 'appName' | 'description' | 'features' | 'requiresDatabase'>,
  existingFiles: GeneratedAppFile[]
): string {
  const repoSummary = buildRepoSummaryForEdit(repoName, metadata, existingFiles)
  const fileIndex = existingFiles
    .map((file) => normalizeGeneratedAppPath(file.path))
    .sort()
    .join('\n')

  const databaseHint =
    metadata.requiresDatabase === true
      ? `
This app uses Neon Postgres + Prisma. Prefer including prisma/schema.prisma, lib/actions.ts, lib/types.ts, and lib/prisma.ts when the edit touches data, forms, or server actions.
`
      : ''

  return `Repository summary (architecture, routes, and scope):

${repoSummary}
${databaseHint}
Complete file index (${existingFiles.length} paths):
${fileIndex}`
}

/**
 * Selected-file edit context — only pinned + chosen paths (plus DB baseline when needed).
 */
function buildEditSelectedFilesContext(
  repoName: string,
  metadata: Pick<LlmAppSpec, 'appName' | 'description' | 'features' | 'requiresDatabase'>,
  existingFiles: GeneratedAppFile[],
  selectedPaths: string[]
): string {
  const byPath = indexGeneratedAppFiles(existingFiles)
  const selectedFiles = selectedPaths
    .map((path) => byPath.get(normalizeGeneratedAppPath(path)))
    .filter((file): file is GeneratedAppFile => Boolean(file))

  const repoSummary = buildRepoSummaryForEdit(repoName, metadata, existingFiles)
  const databaseContext =
    metadata.requiresDatabase === true ? buildEditDatabaseContext(existingFiles) : ''
  const databaseSection = databaseContext
    ? `${databaseContext}

`
    : ''

  return `Repository summary (read this first — primary reference for architecture, routes, and scope):

${repoSummary}

${databaseSection}Selected file index (${selectedFiles.length} of ${existingFiles.length} paths):
${selectedPaths.join('\n')}

Selected repository files (source of truth — base every edit on this exact code; keep cross-file contracts consistent with files you do not change):

${buildRepairFileContext(selectedFiles, {
  extraSkipPaths: databaseContext ? EDIT_DATABASE_CONTEXT_PATHS : undefined,
})}`
}

async function requestAppEditsFromLlm(
  userInput: string,
  repoName: string,
  existingFiles: GeneratedAppFile[],
  referenceImage?: DevelopmentReferenceMedia
): Promise<LlmAppSpec> {
  const anthropic = createDevelopmentAnthropicClient(getAnthropicApiKey())
  const metadata = inferAppMetadataFromFiles(repoName, existingFiles)
  const requiresDatabase = metadata.requiresDatabase === true

  const structureContext = buildEditStructureContext(repoName, metadata, existingFiles)
  const selectionPrompt = `Repository: ${repoName}
App name: ${metadata.appName}
Description: ${metadata.description}

${structureContext}

User edit request:
${userInput}

Return JSON with the repo-relative paths whose contents are required to implement this edit.`

  let requestedPaths: string[] = []
  try {
    const selection = await requestStructuredJsonWithContinuations(
      anthropic,
      EDIT_FILE_SELECTION_SYSTEM_PROMPT,
      selectionPrompt,
      EDIT_FILE_SELECTION_JSON_SCHEMA,
      (text) => JSON.parse(extractJsonFromLlmText(text)) as { paths?: unknown },
      undefined,
      'edit'
    )
    requestedPaths = Array.isArray(selection.paths)
      ? selection.paths.filter((path): path is string => typeof path === 'string')
      : []
  } catch (error) {
    logger.warn('Edit file selection failed; falling back to heuristic paths', {
      error: toError(error).message,
    })
  }

  const contextPaths = resolveEditContextPaths(
    requestedPaths,
    existingFiles,
    requiresDatabase,
    userInput
  )

  logger.info('Edit context files selected', {
    requestedCount: requestedPaths.length,
    contextCount: contextPaths.length,
    paths: contextPaths,
  })

  const editReference = buildEditSelectedFilesContext(
    repoName,
    metadata,
    existingFiles,
    contextPaths
  )

  const userPrompt = `Repository: ${repoName}
App name: ${metadata.appName}
Description: ${metadata.description}

${editReference}

User edit request:
${userInput}

DATABASE RULE (non-negotiable): ALWAYS return prisma/schema.prisma in this edit response when the app uses a database. Never drop, rename, retype, or edit any existing column — existing field lines must stay identical. Add new columns only. If UI no longer needs a field, stop using it in code — leave it in the schema unchanged.

Return JSON with app metadata and the files you changed or added (plus prisma/schema.prisma whenever the app uses a database).`

  const parsed = await requestStructuredJsonWithContinuations(
    anthropic,
    EDIT_APP_SYSTEM_PROMPT,
    userPrompt,
    EDIT_APP_JSON_SCHEMA,
    (text) => JSON.parse(extractJsonFromLlmText(text)) as LlmAppSpec,
    referenceImage,
    'edit'
  )

  if (!parsed.files?.length) {
    throw new Error('LLM did not return any file changes for the edit request')
  }

  const mergedFiles = mergeEditedFiles(existingFiles, parsed.files)

  return normalizeAppSpec(
    {
      appName: parsed.appName || metadata.appName,
      repoName,
      description: parsed.description || metadata.description,
      features: parsed.features?.length ? parsed.features : metadata.features,
      requiresDatabase: parsed.requiresDatabase ?? metadata.requiresDatabase,
      files: mergedFiles,
    },
    repoName,
    { preserveAllFiles: true, latestUserRequest: userInput }
  )
}

/**
 * Edits an existing generated Next.js app from user instructions, then validates, pushes, and deploys.
 */
export async function editNextjsApp(input: EditNextjsAppInput): Promise<GenerateNextjsAppResult> {
  const userInput = input.userInput?.trim()
  const repoName = slugifyRepoName(input.repoName?.trim() ?? '')

  if (!userInput) {
    return { success: false, error: 'userInput is required' }
  }
  if (!repoName) {
    return { success: false, error: 'repoName is required' }
  }

  return runWithLlmUsageTracking(async () => {
    const result = await runWithArenaMode(input.arenaMode === true, () =>
      editNextjsAppInner(input, userInput, repoName)
    )
    const llmUsage = getTrackedLlmUsage()
    return llmUsage ? { ...result, llmUsage } : result
  })
}

async function editNextjsAppInner(
  input: EditNextjsAppInput,
  userInput: string,
  repoName: string
): Promise<GenerateNextjsAppResult> {
  try {
    const { ensureLocalGeneratedApp } = await import('@/lib/development/ensure-local-generated-app')
    const { readGeneratedAppFiles } = await import('@/lib/development/read-generated-app-files')
    const { ensureGitHubRepository, pushRepoChangesToGitHub } = await import(
      '@/lib/development/push-generated-app-to-github'
    )

    const localResult = await ensureLocalGeneratedApp(repoName)
    if (!localResult.success || !localResult.outputDir) {
      return {
        success: false,
        error: localResult.error ?? 'Failed to prepare local repository copy',
      }
    }

    const outputDir = localResult.outputDir
    const monorepoRoot = findMonorepoRoot()
    const outputPath = relative(monorepoRoot, outputDir)

    const existingFiles = await readGeneratedAppFiles(outputDir)
    const originalPrismaSchema = existingFiles.find(
      (file) => file.path.replace(/\\/g, '/') === 'prisma/schema.prisma'
    )?.content
    const generationStartedAt = Date.now()
    let spec = await requestAppEditsFromLlm(
      userInput,
      repoName,
      existingFiles,
      input.referenceImage
    )
    logger.info('LLM app edit finished', {
      durationMs: Date.now() - generationStartedAt,
      changedFiles: spec.files.length,
      requiresDatabase: DEVELOPMENT_REQUIRES_DATABASE,
      hasReferencePdf: Boolean(input.referenceImage),
    })

    const fileCount = await writeAppFiles(outputDir, spec.files)
    if (fileCount === 0) {
      return { success: false, error: 'No valid files were written to the output directory' }
    }

    let buildValidated: boolean | undefined
    let buildOutput: string | undefined

    const deployEnvEarly = resolveDevelopmentDeployEnv()
    const githubRepoPrep = startGitHubRepositoryPrepIfConfigured({
      repoName,
      description: spec.description,
      githubToken: deployEnvEarly.githubToken,
      vercelToken: deployEnvEarly.vercelToken,
      githubOwner: deployEnvEarly.githubOwner ?? localResult.githubOwner,
    })

    const buildRepair = await validateAndRepairUntilBuildPasses(outputDir, spec, userInput, {
      originalPrismaSchema,
    })
    spec = buildRepair.spec
    spec.requiresDatabase = DEVELOPMENT_REQUIRES_DATABASE
    buildValidated = buildRepair.buildValidated
    buildOutput = buildRepair.buildOutput

    if (!buildValidated) {
      const errorSummary = formatBuildErrorsSummary(buildOutput ?? '')
      return {
        success: false,
        error: `App validation failed after edit (${buildRepair.repairRounds} repair round(s)):\n${errorSummary || truncateBuildLog(buildOutput ?? '')}`,
        appName: spec.appName,
        repoName,
        description: spec.description,
        features: spec.features,
        outputPath,
        absoluteOutputPath: outputDir,
        fileCount,
        buildValidated: false,
        buildOutput,
      }
    }

    let gitPushed = false
    let githubHtmlUrl = localResult.githubHtmlUrl
    let githubCloneUrl = localResult.githubCloneUrl
    let githubOwner = localResult.githubOwner
    let githubRepoName = localResult.githubRepoName ?? repoName
    let gitPushError: string | undefined

    const {
      githubToken,
      githubOwner: githubOwnerHint,
      vercelToken,
      vercelTeamId,
      neonIntegrationConfigurationId,
      neonApiKey,
      neonOrgId,
    } = resolveDevelopmentDeployEnv()

    let vercelDeployed = false
    let vercelUrl: string | undefined
    let vercelDeploymentUrl: string | undefined
    let vercelProjectId: string | undefined
    let vercelDeploymentId: string | undefined
    let vercelInspectorUrl: string | undefined
    let vercelDeployError: string | undefined
    let databaseProvisioned: boolean | undefined
    let neonProjectId: string | undefined
    let databaseProvisionError: string | undefined

    if (!githubToken) {
      gitPushError = 'DEVELOPMENT_GITHUB_TOKEN is not set in the environment.'
    } else if (!vercelToken) {
      vercelDeployError = 'DEVELOPMENT_VERCEL_TOKEN is not set in the environment.'
    } else {
      logger.info('Using GitHub repository prepared during edit validation', { repoName })
      const repoResult = githubRepoPrep
        ? await githubRepoPrep
        : await ensureGitHubRepository({
            repoName,
            description: spec.description,
            githubToken,
            githubOwner: githubOwnerHint ?? githubOwner,
          })

      if (!repoResult.success || !repoResult.owner || !repoResult.repoName) {
        gitPushError = repoResult.error ?? 'Failed to resolve GitHub repository for edit'
        vercelDeployError = gitPushError
      } else {
        githubOwner = repoResult.owner
        githubRepoName = repoResult.repoName
        githubHtmlUrl = repoResult.htmlUrl ?? githubHtmlUrl
        githubCloneUrl = repoResult.cloneUrl ?? githubCloneUrl

        logger.info('Preparing Vercel project before edit push', { repoName })
        const prepareResult = await prepareVercelProjectForDeploy({
          vercelToken,
          projectName: repoName,
          githubOwner,
          githubRepoName,
          vercelTeamId,
          requiresDatabase: DEVELOPMENT_REQUIRES_DATABASE,
          neonIntegrationConfigurationId,
          neonApiKey,
          neonOrgId,
        })

        vercelProjectId = prepareResult.vercelProjectId
        databaseProvisioned = prepareResult.databaseProvisioned
        neonProjectId = prepareResult.neonProjectId
        databaseProvisionError = prepareResult.databaseProvisionError

        if (!prepareResult.success || !vercelProjectId || !prepareResult.vercelProjectName) {
          vercelDeployError = prepareResult.error ?? 'Failed to prepare Vercel project'
        } else {
          const dbSyncResult = await syncDatabaseWithSchemaRepair({
            outputDir,
            spec,
            userInput,
            repoName,
            databaseUrl: prepareResult.databaseUrl,
            neonProjectId: prepareResult.neonProjectId,
            neonApiKey,
            originalPrismaSchema,
          })
          spec = dbSyncResult.spec

          if (dbSyncResult.blockingError) {
            vercelDeployError = dbSyncResult.blockingError
            databaseProvisionError = dbSyncResult.blockingError
          } else {
            logger.info('Pushing edited app to GitHub', { repoName })
            const pushResult = await pushRepoChangesToGitHub({
              outputDir,
              repoName,
              githubToken,
              githubOwner,
              commitMessage: `${userInput.slice(0, 72)}`,
            })

            gitPushed = pushResult.success && pushResult.pushed === true
            githubHtmlUrl = pushResult.htmlUrl ?? githubHtmlUrl
            githubCloneUrl = pushResult.cloneUrl ?? githubCloneUrl
            githubOwner = pushResult.owner ?? githubOwner
            githubRepoName = pushResult.repoName ?? githubRepoName
            gitPushError = pushResult.error

            if (!gitPushed || !githubOwner || !githubRepoName || !pushResult.commitSha) {
              vercelDeployError =
                gitPushError ??
                'Vercel deploy requires a successful GitHub push with a new commit. Check DEVELOPMENT_GITHUB_TOKEN in .env and git push errors.'
            } else {
              logger.info('Deploying edited app to Vercel', {
                repoName,
                commitSha: pushResult.commitSha,
                repoId: pushResult.repoId,
              })
              const deployResult = await deployPreparedVercelProject({
                vercelToken,
                vercelProjectId,
                vercelProjectName: prepareResult.vercelProjectName,
                githubOwner,
                githubRepoName,
                githubToken,
                outputDir,
                vercelTeamId,
                gitRef: pushResult.defaultBranch ?? 'main',
                gitCommitSha: pushResult.commitSha,
                gitHubRepoId: pushResult.repoId,
                databaseProvisioned,
                neonProjectId,
              })

              vercelDeployed = deployResult.success
              vercelUrl = deployResult.vercelUrl
              vercelDeploymentUrl = deployResult.vercelDeploymentUrl
              vercelProjectId = deployResult.vercelProjectId ?? vercelProjectId
              vercelDeploymentId = deployResult.vercelDeploymentId
              vercelInspectorUrl = deployResult.vercelInspectorUrl
              vercelDeployError = deployResult.error
            }
          }
        }
      }
    }

    if (!vercelDeployed) {
      return {
        success: false,
        error: vercelDeployError ?? 'Vercel deployment failed after edit',
        appName: spec.appName,
        repoName,
        description: spec.description,
        features: spec.features,
        outputPath,
        absoluteOutputPath: outputDir,
        fileCount,
        buildValidated,
        buildOutput,
        gitPushed,
        githubHtmlUrl,
        githubCloneUrl,
        githubOwner,
        githubRepoName,
        gitPushError,
        vercelDeployed: false,
        vercelDeployError,
        requiresDatabase: DEVELOPMENT_REQUIRES_DATABASE,
        databaseProvisioned,
        neonProjectId,
        databaseProvisionError,
      }
    }

    let resolvedAbsoluteOutputPath: string | undefined = outputDir
    const shouldRemoveLocal = gitPushed && vercelDeployed

    if (shouldRemoveLocal) {
      try {
        await rm(outputDir, { recursive: true, force: true })
        resolvedAbsoluteOutputPath = undefined
        logger.info('Removed local generated app folder after edit publish', {
          outputDir,
          repoName,
        })
      } catch (cleanupError) {
        logger.warn('Failed to remove local generated app folder after edit', {
          outputDir,
          error: toError(cleanupError).message,
        })
      }
    }

    return {
      success: true,
      appName: spec.appName,
      repoName,
      description: spec.description,
      features: spec.features,
      outputPath,
      absoluteOutputPath: resolvedAbsoluteOutputPath,
      fileCount,
      buildValidated,
      buildOutput,
      gitPushed,
      githubHtmlUrl,
      githubCloneUrl,
      githubOwner,
      githubRepoName,
      gitPushError,
      vercelDeployed,
      vercelUrl,
      vercelDeploymentUrl,
      vercelProjectId,
      vercelDeploymentId,
      vercelInspectorUrl,
      vercelDeployError,
      requiresDatabase: DEVELOPMENT_REQUIRES_DATABASE,
      databaseProvisioned,
      neonProjectId,
      databaseProvisionError,
      mode: 'edit',
    }
  } catch (error) {
    const message = toError(error).message
    logger.error('Next.js app edit failed', { error: message, repoName })
    return { success: false, error: message }
  }
}
