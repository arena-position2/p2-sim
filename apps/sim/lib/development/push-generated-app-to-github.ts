import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync } from 'fs'
import { join } from 'path'
import { createLogger } from '@sim/logger'
import { toError } from '@sim/utils/errors'

const logger = createLogger('PushGeneratedAppToGitHub')
const execFileAsync = promisify(execFile)

const GITHUB_API = 'https://api.github.com'
const GIT_COMMIT_EMAIL = 'sim-development@users.noreply.github.com'
const GIT_COMMIT_NAME = 'Sim Development'

export interface PushGeneratedAppToGitHubInput {
  outputDir: string
  repoName: string
  description?: string
  githubToken: string
  githubOwner?: string
  privateRepo?: boolean
}

export interface PushGeneratedAppToGitHubResult {
  success: boolean
  owner?: string
  repoName?: string
  htmlUrl?: string
  cloneUrl?: string
  defaultBranch?: string
  repoId?: number
  commitSha?: string
  pushed?: boolean
  error?: string
}

interface GitHubUserResponse {
  login: string
}

interface GitHubRepoResponse {
  id: number
  name: string
  html_url: string
  clone_url: string
  default_branch: string
  owner: { login: string }
}

async function runGit(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd,
    encoding: 'utf-8',
    maxBuffer: 10 * 1024 * 1024,
  })
  return stdout.trim()
}

async function githubFetch<T>(
  token: string,
  path: string,
  init?: RequestInit
): Promise<{ data: T; status: number }> {
  const response = await fetch(`${GITHUB_API}${path}`, {
    ...init,
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  })

  const text = await response.text()
  let data: T
  try {
    data = text ? (JSON.parse(text) as T) : ({} as T)
  } catch {
    throw new Error(`GitHub API returned invalid JSON (${response.status})`)
  }

  return { data, status: response.status }
}

async function resolveGitHubOwner(token: string, ownerHint?: string): Promise<string> {
  const trimmed = ownerHint?.trim()
  if (trimmed) {
    return trimmed
  }

  const { data, status } = await githubFetch<GitHubUserResponse>(token, '/user')
  if (status !== 200 || !data.login) {
    throw new Error('Failed to resolve GitHub owner from token')
  }
  return data.login
}

async function createGitHubRepository(
  token: string,
  owner: string,
  repoName: string,
  description: string | undefined,
  privateRepo: boolean,
  authenticatedLogin: string
): Promise<GitHubRepoResponse> {
  const body = JSON.stringify({
    name: repoName,
    description: description?.slice(0, 350) ?? '',
    private: privateRepo,
    auto_init: false,
  })

  const orgPath = owner !== authenticatedLogin ? `/orgs/${owner}/repos` : '/user/repos'
  const { data, status } = await githubFetch<GitHubRepoResponse & { message?: string }>(
    token,
    orgPath,
    { method: 'POST', body }
  )

  if (status === 201) {
    return data
  }

  if (status === 422) {
    const { data: existing, status: getStatus } = await githubFetch<GitHubRepoResponse>(
      token,
      `/repos/${owner}/${repoName}`
    )
    if (getStatus === 200) {
      logger.info('GitHub repository already exists, pushing to existing remote', {
        owner,
        repoName,
      })
      return existing
    }
  }

  const message =
    typeof data === 'object' && data && 'message' in data && typeof data.message === 'string'
      ? data.message
      : `GitHub API error (${status})`
  throw new Error(message)
}

async function ensureGitRemote(
  outputDir: string,
  remoteUrl: string,
  defaultBranch: string
): Promise<void> {
  const gitDir = join(outputDir, '.git')
  if (!existsSync(gitDir)) {
    await runGit(outputDir, ['init'])
    await runGit(outputDir, ['branch', '-M', defaultBranch])
  }

  try {
    await runGit(outputDir, ['remote', 'get-url', 'origin'])
    await runGit(outputDir, ['remote', 'set-url', 'origin', remoteUrl])
  } catch {
    try {
      await runGit(outputDir, ['remote', 'remove', 'origin'])
    } catch {
      // no existing origin
    }
    await runGit(outputDir, ['remote', 'add', 'origin', remoteUrl])
  }
}

async function getHeadCommitSha(outputDir: string): Promise<string> {
  return runGit(outputDir, ['rev-parse', 'HEAD'])
}

function buildAuthenticatedRemoteUrl(token: string, owner: string, repoName: string): string {
  return `https://x-access-token:${encodeURIComponent(token)}@github.com/${owner}/${repoName}.git`
}

async function initCommitAndPush(
  outputDir: string,
  remoteUrl: string,
  defaultBranch: string
): Promise<void> {
  if (!existsSync(outputDir)) {
    throw new Error(`Output directory does not exist: ${outputDir}`)
  }

  const gitDir = join(outputDir, '.git')
  if (!existsSync(gitDir)) {
    await runGit(outputDir, ['init'])
  }

  await runGit(outputDir, ['config', 'user.email', GIT_COMMIT_EMAIL])
  await runGit(outputDir, ['config', 'user.name', GIT_COMMIT_NAME])
  await runGit(outputDir, ['add', '.'])

  try {
    await runGit(outputDir, ['diff', '--cached', '--quiet'])
    logger.info('No changes to commit for generated app', { outputDir })
  } catch {
    await runGit(outputDir, ['commit', '-m', 'Initial commit'])
  }

  await runGit(outputDir, ['branch', '-M', defaultBranch])

  try {
    await runGit(outputDir, ['remote', 'remove', 'origin'])
  } catch {
    // no existing origin
  }

  await runGit(outputDir, ['remote', 'add', 'origin', remoteUrl])

  try {
    await runGit(outputDir, ['fetch', 'origin', defaultBranch])
    try {
      await runGit(outputDir, [
        'pull',
        '--rebase',
        '--allow-unrelated-histories',
        'origin',
        defaultBranch,
      ])
    } catch (error) {
      logger.warn('Rebase before initial push failed; attempting direct push', {
        defaultBranch,
        error: toError(error).message,
      })
    }
  } catch {
    // Remote branch may not exist yet on a freshly created repository.
  }

  await runGit(outputDir, ['push', '-u', 'origin', defaultBranch])
}

/**
 * Creates a GitHub repository (or reuses an existing one) without pushing code.
 * Used to link Vercel before the first push so Neon env vars exist before auto-deploy.
 */
export async function ensureGitHubRepository(
  input: Omit<PushGeneratedAppToGitHubInput, 'outputDir'>
): Promise<PushGeneratedAppToGitHubResult> {
  const token = input.githubToken?.trim()
  if (!token) {
    return { success: false, error: 'GitHub token is required to create a remote repository' }
  }

  const repoName = input.repoName.trim()
  if (!repoName) {
    return { success: false, error: 'Repository name is required' }
  }

  try {
    const { data: user, status: userStatus } = await githubFetch<GitHubUserResponse>(token, '/user')
    if (userStatus !== 200) {
      return { success: false, error: 'Invalid GitHub token or insufficient API access' }
    }

    const owner = await resolveGitHubOwner(token, input.githubOwner)
    const repo = await createGitHubRepository(
      token,
      owner,
      repoName,
      input.description,
      input.privateRepo === true,
      user.login
    )

    return {
      success: true,
      owner,
      repoName: repo.name,
      htmlUrl: repo.html_url,
      cloneUrl: repo.clone_url,
      defaultBranch: repo.default_branch || 'main',
      repoId: repo.id,
    }
  } catch (error) {
    const message = toError(error).message
    logger.error('Failed to ensure GitHub repository exists', { error: message })
    return { success: false, error: message }
  }
}

/**
 * Commits and pushes local changes to an existing GitHub repository.
 */
export async function pushRepoChangesToGitHub(
  input: PushGeneratedAppToGitHubInput & { commitMessage?: string }
): Promise<PushGeneratedAppToGitHubResult> {
  const token = input.githubToken?.trim()
  if (!token) {
    return { success: false, error: 'GitHub token is required to push changes' }
  }

  const repoName = input.repoName.trim()
  if (!repoName) {
    return { success: false, error: 'Repository name is required' }
  }

  if (!existsSync(input.outputDir)) {
    return { success: false, error: `Output directory does not exist: ${input.outputDir}` }
  }

  try {
    const { status: userStatus } = await githubFetch<GitHubUserResponse>(token, '/user')
    if (userStatus !== 200) {
      return { success: false, error: 'Invalid GitHub token or insufficient API access' }
    }

    const owner = await resolveGitHubOwner(token, input.githubOwner)
    const { data: repo, status: repoStatus } = await githubFetch<GitHubRepoResponse>(
      token,
      `/repos/${owner}/${repoName}`
    )
    if (repoStatus !== 200) {
      return { success: false, error: `GitHub repository "${owner}/${repoName}" was not found` }
    }

    const defaultBranch = repo.default_branch || 'main'
    const remoteUrl = buildAuthenticatedRemoteUrl(token, owner, repo.name)

    await ensureGitRemote(input.outputDir, remoteUrl, defaultBranch)
    await runGit(input.outputDir, ['config', 'user.email', GIT_COMMIT_EMAIL])
    await runGit(input.outputDir, ['config', 'user.name', GIT_COMMIT_NAME])

    try {
      await runGit(input.outputDir, ['fetch', 'origin', defaultBranch])
    } catch (error) {
      logger.warn('Could not fetch remote branch before edit push', {
        repoName,
        defaultBranch,
        error: toError(error).message,
      })
    }

    await runGit(input.outputDir, ['add', '.'])

    let pushed = false
    try {
      await runGit(input.outputDir, ['diff', '--cached', '--quiet'])
      return {
        success: false,
        pushed: false,
        error: 'No file changes to push after edit. Update User Input and try again.',
        owner,
        repoName: repo.name,
        htmlUrl: repo.html_url,
        cloneUrl: repo.clone_url,
        defaultBranch,
        repoId: repo.id,
      }
    } catch {
      await runGit(input.outputDir, [
        'commit',
        '-m',
        input.commitMessage?.trim() || 'Update from Sim Development',
      ])

      try {
        await runGit(input.outputDir, ['pull', '--rebase', 'origin', defaultBranch])
      } catch (error) {
        logger.warn('Rebase before push failed; attempting direct push', {
          repoName,
          error: toError(error).message,
        })
      }

      await runGit(input.outputDir, ['push', 'origin', `HEAD:${defaultBranch}`])
      pushed = true
    }

    const commitSha = await getHeadCommitSha(input.outputDir)

    logger.info('Pushed edited app changes to GitHub', {
      owner,
      repoName: repo.name,
      htmlUrl: repo.html_url,
      commitSha,
      pushed,
    })

    return {
      success: true,
      pushed,
      owner,
      repoName: repo.name,
      htmlUrl: repo.html_url,
      cloneUrl: repo.clone_url,
      defaultBranch,
      repoId: repo.id,
      commitSha,
    }
  } catch (error) {
    const message = toError(error).message
    logger.error('Failed to push edited app changes to GitHub', { error: message })
    return { success: false, error: message }
  }
}

/**
 * Creates a new GitHub repository (or reuses an existing one) and pushes the generated app folder.
 */
export async function pushGeneratedAppToGitHub(
  input: PushGeneratedAppToGitHubInput
): Promise<PushGeneratedAppToGitHubResult> {
  const token = input.githubToken?.trim()
  if (!token) {
    return { success: false, error: 'GitHub token is required to push to a remote repository' }
  }

  const repoName = input.repoName.trim()
  if (!repoName) {
    return { success: false, error: 'Repository name is required' }
  }

  try {
    const { data: user, status: userStatus } = await githubFetch<GitHubUserResponse>(token, '/user')
    if (userStatus !== 200) {
      return { success: false, error: 'Invalid GitHub token or insufficient API access' }
    }

    const owner = await resolveGitHubOwner(token, input.githubOwner)
    const repo = await createGitHubRepository(
      token,
      owner,
      repoName,
      input.description,
      input.privateRepo === true,
      user.login
    )

    const defaultBranch = repo.default_branch || 'main'
    const remoteUrl = buildAuthenticatedRemoteUrl(token, owner, repo.name)

    await initCommitAndPush(input.outputDir, remoteUrl, defaultBranch)
    const commitSha = await getHeadCommitSha(input.outputDir)

    logger.info('Pushed generated app to GitHub', {
      owner,
      repoName: repo.name,
      htmlUrl: repo.html_url,
      commitSha,
    })

    return {
      success: true,
      pushed: true,
      owner,
      repoName: repo.name,
      htmlUrl: repo.html_url,
      cloneUrl: repo.clone_url,
      defaultBranch,
      repoId: repo.id,
      commitSha,
    }
  } catch (error) {
    const message = toError(error).message
    logger.error('Failed to push generated app to GitHub', { error: message })
    return { success: false, error: message }
  }
}
