import { createHash } from 'node:crypto'
import { createLogger } from '@sim/logger'
import { toError } from '@sim/utils/errors'
import { sleep } from '@sim/utils/helpers'
import { readGeneratedAppFiles } from '@/lib/development/read-generated-app-files'

const logger = createLogger('DeployVercelFromFiles')

const VERCEL_API = 'https://api.vercel.com'
const DEPLOY_POLL_INTERVAL_MS = 5_000
const DEPLOY_TIMEOUT_MS = 600_000
const MAX_INLINE_FILE_BYTES = 4 * 1024 * 1024

interface VercelDeployment {
  id: string
  url?: string
  readyState?: string
  alias?: string[]
  inspectorUrl?: string
  errorMessage?: string
  errorCode?: string
}

interface VercelDeploymentEvent {
  text?: string
  payload?: { text?: string; message?: string }
}

export interface DeployVercelFromFilesInput {
  vercelToken: string
  vercelProjectId: string
  vercelProjectName: string
  outputDir: string
  vercelTeamId?: string
  gitMetadata?: {
    remoteUrl?: string
    commitMessage?: string
    commitSha?: string
    commitRef?: string
  }
}

export interface DeployVercelFromFilesResult {
  success: boolean
  vercelUrl?: string
  vercelDeploymentUrl?: string
  vercelProjectId?: string
  vercelDeploymentId?: string
  vercelInspectorUrl?: string
  error?: string
}

function sha1Hex(content: Buffer): string {
  return createHash('sha1').update(content).digest('hex')
}

async function vercelRequest<T>(
  token: string,
  path: string,
  init?: RequestInit,
  teamId?: string
): Promise<{ data: T; status: number }> {
  let url = `${VERCEL_API}${path}`
  if (teamId?.trim() && !path.includes('teamId=')) {
    url += `${path.includes('?') ? '&' : '?'}teamId=${encodeURIComponent(teamId.trim())}`
  }

  const response = await fetch(url, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(init?.headers ?? {}),
    },
  })

  const text = await response.text()
  let data: T
  try {
    data = text ? (JSON.parse(text) as T) : ({} as T)
  } catch {
    throw new Error(`Vercel API returned invalid JSON (${response.status})`)
  }

  return { data, status: response.status }
}

function vercelErrorMessage(data: unknown, status: number): string {
  if (typeof data === 'object' && data && 'error' in data) {
    const err = (data as { error?: { message?: string } }).error
    if (err?.message) {
      return err.message
    }
  }
  return `Vercel API error (${status})`
}

async function uploadFileToVercel(
  token: string,
  content: Buffer,
  teamId?: string
): Promise<string> {
  const digest = sha1Hex(content)

  const { status } = await vercelRequest<unknown>(
    token,
    '/v2/files',
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'x-vercel-digest': digest,
        'Content-Length': String(content.length),
      },
      body: new Uint8Array(content),
    },
    teamId
  )

  if (status !== 200) {
    throw new Error(`Failed to upload file to Vercel (status ${status})`)
  }

  return digest
}

async function waitForDeploymentReady(
  token: string,
  deploymentId: string,
  teamId?: string
): Promise<VercelDeployment> {
  const deadline = Date.now() + DEPLOY_TIMEOUT_MS

  while (Date.now() < deadline) {
    const { data, status } = await vercelRequest<VercelDeployment>(
      token,
      `/v13/deployments/${encodeURIComponent(deploymentId)}`,
      { method: 'GET' },
      teamId
    )

    if (status !== 200) {
      throw new Error(vercelErrorMessage(data, status))
    }

    const state = data.readyState?.toUpperCase()
    if (state === 'READY') {
      return data
    }
    if (state === 'ERROR' || state === 'CANCELED') {
      const { data: events } = await vercelRequest<VercelDeploymentEvent[]>(
        token,
        `/v3/deployments/${encodeURIComponent(deploymentId)}/events?direction=backward&limit=40`,
        { method: 'GET' },
        teamId
      )
      const log = (Array.isArray(events) ? events : [])
        .map((event) => event.text ?? event.payload?.text ?? event.payload?.message)
        .filter(Boolean)
        .join('\n')
      throw new Error(
        [data.errorMessage, data.errorCode ? `code: ${data.errorCode}` : undefined, log]
          .filter(Boolean)
          .join('\n') || 'Vercel file deployment failed'
      )
    }

    await sleep(DEPLOY_POLL_INTERVAL_MS)
  }

  throw new Error('Vercel file deployment timed out')
}

function resolveLiveUrl(deployment: VercelDeployment, projectName: string): string {
  const aliases = (deployment.alias ?? [])
    .map((entry) => entry.replace(/^https?:\/\//, '').trim())
    .filter(Boolean)

  const exact = aliases.find((alias) => alias === `${projectName}.vercel.app`)
  if (exact) {
    return exact.startsWith('http') ? exact : `https://${exact}`
  }

  const productionLike = aliases
    .filter((alias) => alias.endsWith('.vercel.app') && !alias.includes('-git-'))
    .sort((left, right) => left.length - right.length)
  if (productionLike[0]) {
    const alias = productionLike[0]
    return alias.startsWith('http') ? alias : `https://${alias}`
  }

  if (deployment.url) {
    return deployment.url.startsWith('http') ? deployment.url : `https://${deployment.url}`
  }

  return `https://${projectName}.vercel.app`
}

/**
 * Deploys a generated app to Vercel by uploading local files (no GitHub integration required).
 */
export async function deployVercelProjectFromFiles(
  input: DeployVercelFromFilesInput
): Promise<DeployVercelFromFilesResult> {
  const token = input.vercelToken?.trim()
  if (!token) {
    return { success: false, error: 'Vercel token is required' }
  }

  try {
    const sourceFiles = await readGeneratedAppFiles(input.outputDir)
    const deploymentFiles: Array<{ file: string; sha: string; size: number }> = []

    logger.info('Uploading generated app files to Vercel', {
      projectName: input.vercelProjectName,
      fileCount: sourceFiles.length,
    })

    for (const sourceFile of sourceFiles) {
      const content = Buffer.from(sourceFile.content, 'utf-8')
      if (content.length > MAX_INLINE_FILE_BYTES) {
        throw new Error(`File ${sourceFile.path} exceeds Vercel inline upload limit`)
      }
      const sha = await uploadFileToVercel(token, content, input.vercelTeamId)
      deploymentFiles.push({ file: sourceFile.path, sha, size: content.length })
    }

    const body = JSON.stringify({
      name: input.vercelProjectName,
      project: input.vercelProjectId,
      target: 'production',
      files: deploymentFiles,
      projectSettings: { framework: 'nextjs' },
      ...(input.gitMetadata
        ? {
            gitMetadata: {
              remoteUrl: input.gitMetadata.remoteUrl,
              commitMessage: input.gitMetadata.commitMessage,
              commitSha: input.gitMetadata.commitSha,
              commitRef: input.gitMetadata.commitRef,
            },
          }
        : {}),
    })

    const { data: created, status } = await vercelRequest<VercelDeployment>(
      token,
      '/v13/deployments',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
      },
      input.vercelTeamId
    )

    if (status !== 200 && status !== 201) {
      throw new Error(vercelErrorMessage(created, status))
    }

    const ready = await waitForDeploymentReady(token, created.id, input.vercelTeamId)
    const vercelUrl = resolveLiveUrl(ready, input.vercelProjectName)
    const vercelDeploymentUrl = ready.url
      ? ready.url.startsWith('http')
        ? ready.url
        : `https://${ready.url}`
      : vercelUrl

    logger.info('Vercel file deployment ready', {
      projectId: input.vercelProjectId,
      deploymentId: ready.id,
      vercelUrl,
    })

    return {
      success: true,
      vercelUrl,
      vercelDeploymentUrl,
      vercelProjectId: input.vercelProjectId,
      vercelDeploymentId: ready.id,
      vercelInspectorUrl: ready.inspectorUrl,
    }
  } catch (error) {
    const message = toError(error).message
    logger.error('Vercel file deployment failed', { error: message })
    return { success: false, error: message, vercelProjectId: input.vercelProjectId }
  }
}
