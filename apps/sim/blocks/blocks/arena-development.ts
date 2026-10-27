import { DevelopmentIcon } from '@/components/icons'
import type { BlockConfig } from '@/blocks/types'
import { IntegrationType } from '@/blocks/types'
import { normalizeFileInput } from '@/blocks/utils'

let _inflightRepoFetch: Promise<Array<{ label: string; id: string }>> | null = null

async function fetchArenaDevelopmentRepos(): Promise<Array<{ label: string; id: string }>> {
  if (_inflightRepoFetch) {
    return _inflightRepoFetch
  }

  _inflightRepoFetch =
    // boundary-raw-fetch: internal JSON GET for Arena Development block repo dropdown hydration
    fetch('/api/tools/development/repos', { credentials: 'same-origin' })
      .then((response) => response.json())
      .then((data) => {
        _inflightRepoFetch = null
        if (!data?.success || !Array.isArray(data.repos)) {
          return []
        }

        return data.repos.map((repo: { id: string; name: string; source?: string }) => ({
          id: repo.id,
          label: repo.name,
        }))
      })
      .catch(() => {
        _inflightRepoFetch = null
        return []
      })

  return _inflightRepoFetch
}

export const ArenaDevelopmentBlock: BlockConfig = {
  type: 'arena_development',
  name: 'Arena Development',
  description:
    'Generate or edit an iframe-ready Next.js app with emailId access gate from the parent URL',
  longDescription:
    'Same full-stack automation as Development (Next.js App Router, Neon + Prisma, GitHub, Vercel), plus Arena mode: generated apps read emailId from the iframe query string, deny access when missing, expose emailId via cookie + React Context for every page/SSR, allow frame-ancestors *, and follow Arena branch guidelines in the system prompt.',
  bestPractices: `
  - Use Generate mode for new Arena apps. Describe the app name, main features, pages, UI style, authentication needs, and API routes in User Input.
  - Embed the deployed app as <iframe src="https://your-app/?emailId=user@example.com" />. Missing emailId shows "do not have access".
  - Use getArenaEmailId() / requireArenaEmailId() in Server Components and useArenaEmailId() in client components for user-scoped data.
  - Optional: upload a Reference Design PDF in Generate or Edit mode.
  - Use Edit mode to update an existing generated app. Pick a repository from the list, then describe the changes.
  - Set Repository Name (generate mode) to control the folder name under generated-apps/ (kebab-case).
  - Generated apps are always pushed to GitHub and deployed to Vercel (requires DEVELOPMENT_GITHUB_TOKEN and DEVELOPMENT_VERCEL_TOKEN in .env).
  - Neon Postgres is always provisioned per app on Generate when configured.
  - **NOTE: dont remove updatedAt in any tables ** — never drop or omit updatedAt on Prisma models during generate or edit.
  `,
  docsLink: 'https://docs.sim.ai/blocks/development',
  category: 'blocks',
  integrationType: IntegrationType.DevOps,
  bgColor: '#0F172A',
  icon: DevelopmentIcon,
  subBlocks: [
    {
      id: 'operation',
      title: 'Mode',
      type: 'dropdown',
      options: [
        { label: 'Generate New App', id: 'generate' },
        { label: 'Edit Existing App', id: 'edit' },
      ],
      value: () => 'generate',
    },
    {
      id: 'userInput',
      title: 'User Input',
      type: 'long-input',
      placeholder:
        'Describe your app idea: name, features, pages, UI style, auth, APIs, env vars...',
      required: true,
      wandConfig: {
        enabled: true,
        prompt: `You are an expert product engineer. Expand the user's app idea into a clear, actionable specification for generating a Next.js application embedded in an Arena iframe.

Include:
- App name and purpose
- Main features and user flows
- Pages and routes needed
- Key components
- Data/state requirements (scoped by emailId from the iframe URL when relevant)
- UI style and design direction
- Authentication needs (if any) — note emailId is already provided by the iframe parent
- API routes and environment variables (if any)

Return ONLY the specification text. No markdown wrappers.`,
        placeholder: 'Describe the Arena app you want to build...',
      },
    },
    {
      id: 'existingRepo',
      title: 'Repository',
      type: 'dropdown',
      required: { field: 'operation', value: 'edit' },
      condition: { field: 'operation', value: 'edit' },
      description: 'Select an existing generated app repository to edit.',
      options: [],
      fetchOptions: async () => fetchArenaDevelopmentRepos(),
      fetchOptionById: async (_blockId: string, optionId: string) => {
        const repos = await fetchArenaDevelopmentRepos()
        const match = repos.find((repo) => repo.id === optionId)
        return match ?? { id: optionId, label: optionId }
      },
    },
    {
      id: 'referenceImage',
      title: 'Reference Design PDF',
      type: 'file-upload',
      canonicalParamId: 'referenceImage',
      placeholder: 'Upload a mockup, wireframe, or design spec (PDF only)',
      mode: 'basic',
      multiple: false,
      required: false,
      acceptedTypes: '.pdf',
      description:
        'Optional design PDF — layout, theme, typography, and copy will match the PDF (Generate or Edit).',
    },
    {
      id: 'repoName',
      title: 'Repository Name',
      type: 'short-input',
      placeholder: 'my-app (optional, kebab-case folder name)',
      description: 'Folder name under generated-apps/. Defaults from the app name if empty.',
      condition: { field: 'operation', value: 'generate' },
    },
    {
      id: 'privateRepo',
      title: 'Private Repository',
      type: 'switch',
      description: 'Create the GitHub repository as private',
      condition: { field: 'operation', value: 'generate' },
    },
  ],
  tools: {
    access: ['arena_development_generate_app', 'arena_development_edit_app'],
    config: {
      tool: (params) =>
        params.operation === 'edit'
          ? 'arena_development_edit_app'
          : 'arena_development_generate_app',
      params: (params) =>
        params.operation === 'edit'
          ? {
              userInput: params.userInput,
              repoName: params.existingRepo,
              referenceImage: normalizeFileInput(params.referenceImage, { single: true }),
            }
          : {
              userInput: params.userInput,
              repoName: params.repoName,
              privateRepo: params.privateRepo === true,
              referenceImage: normalizeFileInput(params.referenceImage, { single: true }),
            },
    },
  },
  inputs: {
    operation: {
      type: 'string',
      description: 'Whether to generate a new app or edit an existing repository',
    },
    userInput: {
      type: 'string',
      description: 'App idea, requirements, or edit instructions',
    },
    existingRepo: {
      type: 'string',
      description: 'Repository name of an existing generated app (edit mode)',
    },
    repoName: {
      type: 'string',
      description: 'Repository folder name for a new app (kebab-case, generate mode)',
    },
    referenceImage: {
      type: 'json',
      description: 'Optional reference design PDF for layout and theming (Generate or Edit mode)',
    },
    privateRepo: { type: 'boolean', description: 'Whether the GitHub repository is private' },
  },
  outputs: {
    content: { type: 'string', description: 'Summary of the generation or edit result' },
    appName: { type: 'string', description: 'Human-readable application name' },
    repoName: { type: 'string', description: 'Repository folder name that was created or edited' },
    description: { type: 'string', description: 'Short description of the generated app' },
    features: {
      type: 'json',
      description: 'List of main features (strings) included in the generated app',
    },
    outputPath: {
      type: 'string',
      description: 'Relative path to the generated app (generated-apps/<repo>)',
    },
    absoluteOutputPath: {
      type: 'string',
      description: 'Absolute path on disk where the app folder was written',
    },
    fileCount: { type: 'number', description: 'Number of files written' },
    buildValidated: {
      type: 'boolean',
      description:
        'Whether pre-deploy validation passed (full npm run build in E2B when E2B_API_KEY is set, otherwise local tsc --noEmit)',
    },
    buildOutput: {
      type: 'string',
      description: 'Build validation log output',
    },
    gitPushed: {
      type: 'boolean',
      description: 'Whether the generated app was pushed to GitHub',
    },
    githubHtmlUrl: {
      type: 'string',
      description: 'URL of the GitHub repository in the browser',
    },
    githubCloneUrl: {
      type: 'string',
      description: 'HTTPS clone URL of the GitHub repository',
    },
    githubOwner: {
      type: 'string',
      description: 'GitHub owner (user or org) of the remote repository',
    },
    githubRepoName: {
      type: 'string',
      description: 'GitHub repository name on the remote',
    },
    gitPushError: {
      type: 'string',
      description: 'Error message if push to GitHub was attempted but failed',
    },
    vercelDeployed: {
      type: 'boolean',
      description: 'Whether the app was deployed to Vercel successfully',
    },
    vercelUrl: {
      type: 'string',
      description: 'Live production URL of the deployed app (shown in workflow output)',
    },
    vercelDeploymentUrl: {
      type: 'string',
      description: 'Vercel deployment URL for this build',
    },
    vercelProjectId: {
      type: 'string',
      description: 'Vercel project ID',
    },
    vercelDeploymentId: {
      type: 'string',
      description: 'Vercel deployment ID',
    },
    vercelInspectorUrl: {
      type: 'string',
      description: 'Vercel deployment inspector URL in the dashboard',
    },
    vercelDeployError: {
      type: 'string',
      description: 'Error message if Vercel deployment was attempted but failed',
    },
    requiresDatabase: {
      type: 'boolean',
      description: 'Whether the generated app needs Neon Postgres persistence',
    },
    databaseProvisioned: {
      type: 'boolean',
      description: 'Whether Neon Postgres was provisioned and DATABASE_URL was set on Vercel',
    },
    neonProjectId: {
      type: 'string',
      description: 'Neon project ID when a database was provisioned',
    },
    databaseProvisionError: {
      type: 'string',
      description: 'Error message if database provisioning was required but failed',
    },
  },
}
