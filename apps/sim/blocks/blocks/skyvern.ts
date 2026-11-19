import { SkyvernIcon } from '@/components/icons'
import type { BlockConfig, BlockMeta } from '@/blocks/types'
import { AuthMode, IntegrationType } from '@/blocks/types'
import { parseSkyvernRunParameterRows } from '@/tools/skyvern/parameter-rows'

const SKYVERN_WORKFLOW_CACHE_TTL_MS = 60_000

const skyvernWorkflowCache = new Map<
  string,
  { data: Array<{ label: string; id: string }>; timestamp: number }
>()
const skyvernWorkflowInFlight = new Map<string, Promise<Array<{ label: string; id: string }>>>()

async function getSkyvernBlockValues(blockId: string): Promise<{
  apiKey?: string
  baseUrl?: string
} | null> {
  if (process.env.NEXT_PUBLIC_SKYVERN_CONFIGURED === 'true') {
    return {}
  }

  const { useSubBlockStore } = await import('@/stores/workflows/subblock/store')
  const { useWorkflowRegistry } = await import('@/stores/workflows/registry/store')

  const activeWorkflowId = useWorkflowRegistry.getState().activeWorkflowId
  if (!activeWorkflowId) return null

  const blockValues = useSubBlockStore.getState().workflowValues[activeWorkflowId]?.[blockId]
  if (!blockValues) return null

  return {
    apiKey: typeof blockValues.apiKey === 'string' ? blockValues.apiKey.trim() : undefined,
    baseUrl: typeof blockValues.baseUrl === 'string' ? blockValues.baseUrl.trim() : undefined,
  }
}

function getSkyvernWorkflowCacheKey(credentials: { apiKey?: string; baseUrl?: string }): string {
  const envConfigured = process.env.NEXT_PUBLIC_SKYVERN_CONFIGURED === 'true'
  if (envConfigured) return 'env'
  return `${credentials.baseUrl ?? ''}:${credentials.apiKey ?? ''}`
}

async function fetchSkyvernWorkflowOptionsFromApi(
  credentials: { apiKey?: string; baseUrl?: string },
  workflowId?: string
): Promise<Array<{ label: string; id: string }>> {
  const { requestJson } = await import('@/lib/api/client/request')
  const { skyvernWorkflowsContract } = await import('@/lib/api/contracts/tools/skyvern')

  const data = await requestJson(skyvernWorkflowsContract, {
    body: {
      apiKey: credentials.apiKey,
      baseUrl: credentials.baseUrl,
      workflowId,
    },
  })

  return (data.workflows ?? []).map((workflow) => ({
    id: workflow.id,
    label: workflow.name,
  }))
}

const fetchSkyvernWorkflowOptions = async (
  blockId: string
): Promise<Array<{ label: string; id: string }>> => {
  try {
    const credentials = (await getSkyvernBlockValues(blockId)) ?? {}
    const envConfigured = process.env.NEXT_PUBLIC_SKYVERN_CONFIGURED === 'true'

    if (!envConfigured && !credentials.apiKey) {
      return []
    }

    const cacheKey = getSkyvernWorkflowCacheKey(credentials)
    const cached = skyvernWorkflowCache.get(cacheKey)
    const now = Date.now()
    if (cached && now - cached.timestamp < SKYVERN_WORKFLOW_CACHE_TTL_MS) {
      return cached.data
    }

    const inFlight = skyvernWorkflowInFlight.get(cacheKey)
    if (inFlight) return inFlight

    const requestPromise = (async () => {
      try {
        const options = await fetchSkyvernWorkflowOptionsFromApi(credentials)
        skyvernWorkflowCache.set(cacheKey, { data: options, timestamp: Date.now() })
        return options
      } finally {
        skyvernWorkflowInFlight.delete(cacheKey)
      }
    })()

    skyvernWorkflowInFlight.set(cacheKey, requestPromise)
    return requestPromise
  } catch {
    return []
  }
}

const fetchSkyvernWorkflowOptionById = async (
  blockId: string,
  optionId: string
): Promise<{ label: string; id: string } | null> => {
  try {
    const credentials = (await getSkyvernBlockValues(blockId)) ?? {}
    const cacheKey = getSkyvernWorkflowCacheKey(credentials)
    const cached = skyvernWorkflowCache.get(cacheKey)
    const cachedMatch = cached?.data.find((option) => option.id === optionId)
    if (cachedMatch) return cachedMatch

    const options = await fetchSkyvernWorkflowOptionsFromApi(credentials, optionId)
    return options.find((option) => option.id === optionId) ?? null
  } catch {
    return null
  }
}

export const SkyvernBlock: BlockConfig = {
  type: 'skyvern',
  name: 'Skyvern',
  description: 'Create and run Skyvern browser automation workflows',
  longDescription:
    'Integrate with Skyvern to create UI automation workflows, list existing workflows, trigger runs with parameters, and poll run status until completion.',
  docsLink: 'https://docs.sim.ai/integrations/skyvern',
  category: 'tools',
  integrationType: IntegrationType.AI,
  bgColor: '#7C3AED',
  iconColor: '#7C3AED',
  icon: SkyvernIcon,
  authMode: AuthMode.ApiKey,

  subBlocks: [
    {
      id: 'operation',
      title: 'Operation',
      type: 'dropdown',
      options: [
        { label: 'Create Workflow', id: 'skyvern_create_workflow' },
        { label: 'List Workflows', id: 'skyvern_list_workflows' },
        { label: 'Run Workflow', id: 'skyvern_run_workflow' },
        { label: 'Get Run Status', id: 'skyvern_get_run' },
      ],
      value: () => 'skyvern_create_workflow',
    },
    {
      id: 'baseUrl',
      title: 'Base URL',
      type: 'short-input',
      placeholder: 'https://api.skyvern.com',
      value: () => 'https://api.skyvern.com',
      required: true,
      hideWhenEnvSet: 'NEXT_PUBLIC_SKYVERN_CONFIGURED',
    },
    {
      id: 'apiKey',
      title: 'API Key',
      type: 'short-input',
      placeholder: 'Enter your Skyvern API key',
      password: true,
      required: true,
      hideWhenEnvSet: 'NEXT_PUBLIC_SKYVERN_CONFIGURED',
    },
    {
      id: 'title',
      title: 'Title',
      type: 'short-input',
      placeholder: 'UI Automation',
      condition: { field: 'operation', value: 'skyvern_create_workflow' },
      required: { field: 'operation', value: 'skyvern_create_workflow' },
    },
    {
      id: 'description',
      title: 'Description',
      type: 'long-input',
      placeholder: 'Describe what this workflow automates',
      condition: { field: 'operation', value: 'skyvern_create_workflow' },
    },
    {
      id: 'blockLabel',
      title: 'Block Label',
      type: 'short-input',
      placeholder: 'UI_Automation',
      condition: { field: 'operation', value: 'skyvern_create_workflow' },
      mode: 'advanced',
    },
    {
      id: 'workflowParameters',
      title: 'Workflow Parameters',
      type: 'input-format',
      inputFormatVariant: 'skyvern_workflow_parameters',
      inputFormatConfig: {
        title: 'Parameter',
        fieldNamePlaceholder: 'parameter_key',
        fieldValuePlaceholder: 'Default value (optional)',
      },
      condition: { field: 'operation', value: 'skyvern_create_workflow' },
      defaultValue: [
        {
          id: 'starting_url',
          name: 'starting_url',
          type: 'string',
          description: 'Starting URL',
          value: '',
          collapsed: false,
        },
        {
          id: 'appointment_type',
          name: 'appointment_type',
          type: 'string',
          description: 'Appointment type',
          value: '',
          collapsed: false,
        },
        {
          id: 'days_to_search',
          name: 'days_to_search',
          type: 'integer',
          description: 'Number of days to search',
          value: '',
          collapsed: false,
        },
      ],
    },
    {
      id: 'url',
      title: 'Starting URL',
      type: 'short-input',
      placeholder: '{{starting_url}}',
      condition: { field: 'operation', value: 'skyvern_create_workflow' },
      required: { field: 'operation', value: 'skyvern_create_workflow' },
      value: () => '{{starting_url}}',
    },
    {
      id: 'navigationGoal',
      title: 'Navigation Goal',
      type: 'long-input',
      placeholder: 'Primary goal for the navigation block (e.g. fill out the contact form)',
      condition: { field: 'operation', value: 'skyvern_create_workflow' },
    },
    {
      id: 'dataExtractionGoal',
      title: 'Data Extraction Goal',
      type: 'long-input',
      placeholder:
        'Creates a separate extraction block after navigation (e.g. extract company email)',
      condition: { field: 'operation', value: 'skyvern_create_workflow' },
    },
    {
      id: 'prompt',
      title: 'Prompt',
      type: 'long-input',
      placeholder:
        'Extra instructions merged with navigation goal, or used alone if navigation goal is empty',
      condition: { field: 'operation', value: 'skyvern_create_workflow' },
      mode: 'advanced',
    },
    {
      id: 'page',
      title: 'Page',
      type: 'short-input',
      placeholder: '1',
      condition: { field: 'operation', value: 'skyvern_list_workflows' },
      mode: 'advanced',
    },
    {
      id: 'pageSize',
      title: 'Page Size',
      type: 'short-input',
      placeholder: '10',
      condition: { field: 'operation', value: 'skyvern_list_workflows' },
      mode: 'advanced',
    },
    {
      id: 'workflowSelector',
      title: 'Workflow',
      type: 'dropdown',
      options: [],
      placeholder: 'Select a workflow...',
      searchable: true,
      mode: 'basic',
      canonicalParamId: 'workflowPermanentId',
      condition: { field: 'operation', value: 'skyvern_run_workflow' },
      required: { field: 'operation', value: 'skyvern_run_workflow' },
      fetchOptions: fetchSkyvernWorkflowOptions,
      fetchOptionById: fetchSkyvernWorkflowOptionById,
    },
    {
      id: 'workflowPermanentId',
      title: 'Workflow ID',
      type: 'short-input',
      placeholder: 'wpid_...',
      mode: 'advanced',
      canonicalParamId: 'workflowPermanentId',
      condition: { field: 'operation', value: 'skyvern_run_workflow' },
      required: { field: 'operation', value: 'skyvern_run_workflow' },
    },
    {
      id: 'runWorkflowParameters',
      title: 'Run Parameters',
      type: 'input-format',
      inputFormatVariant: 'skyvern_run_parameters',
      inputFormatConfig: {
        title: 'Parameter',
        fieldNamePlaceholder: 'parameter_key',
        fieldValuePlaceholder: 'Value for this run',
      },
      mode: 'basic',
      condition: { field: 'operation', value: 'skyvern_run_workflow' },
      defaultValue: [
        {
          id: 'starting_url',
          name: 'starting_url',
          type: 'string',
          value: '',
          collapsed: false,
        },
      ],
    },
    {
      id: 'runParameters',
      title: 'Run Parameters (JSON)',
      type: 'code',
      language: 'json',
      placeholder: '{"starting_url": "https://example.com"}',
      condition: { field: 'operation', value: 'skyvern_run_workflow' },
      mode: 'advanced',
      wandConfig: {
        enabled: true,
        prompt:
          'Generate JSON parameters for a Skyvern workflow run. Return ONLY valid JSON with keys the workflow expects (e.g. starting_url).',
        generationType: 'json-object',
      },
    },
    {
      id: 'runId',
      title: 'Run ID',
      type: 'short-input',
      placeholder: 'wr_...',
      condition: { field: 'operation', value: 'skyvern_get_run' },
      required: { field: 'operation', value: 'skyvern_get_run' },
    },
  ],

  tools: {
    access: [
      'skyvern_create_workflow',
      'skyvern_list_workflows',
      'skyvern_run_workflow',
      'skyvern_get_run',
    ],
    config: {
      tool: (params) => params.operation,
      params: (params) => {
        const result: Record<string, unknown> = {}

        if (process.env.NEXT_PUBLIC_SKYVERN_CONFIGURED !== 'true') {
          if (params.apiKey) result.apiKey = params.apiKey
          if (params.baseUrl) result.baseUrl = params.baseUrl
        }

        switch (params.operation) {
          case 'skyvern_create_workflow':
            result.title = params.title
            result.description = params.description
            result.blockLabel = params.blockLabel
            result.url = params.url
            result.navigationGoal = params.navigationGoal
            result.dataExtractionGoal = params.dataExtractionGoal
            result.prompt = params.prompt
            result.workflowParameters = params.workflowParameters
            break
          case 'skyvern_list_workflows': {
            const pageInput = typeof params.page === 'string' ? params.page.trim() : params.page
            const pageSizeInput =
              typeof params.pageSize === 'string' ? params.pageSize.trim() : params.pageSize
            const page = pageInput === '' ? Number.NaN : Number(pageInput)
            const pageSize = pageSizeInput === '' ? Number.NaN : Number(pageSizeInput)

            if (Number.isFinite(page)) result.page = page
            if (Number.isFinite(pageSize)) result.pageSize = pageSize
            break
          }
          case 'skyvern_run_workflow': {
            result.workflowPermanentId = params.workflowPermanentId

            const parametersFromRows = parseSkyvernRunParameterRows(params.runWorkflowParameters)
            let parametersFromJson: Record<string, unknown> = {}

            if (params.runParameters) {
              try {
                parametersFromJson =
                  typeof params.runParameters === 'string'
                    ? (JSON.parse(params.runParameters) as Record<string, unknown>)
                    : (params.runParameters as Record<string, unknown>)
              } catch {
                parametersFromJson = {}
              }
            }

            const mergedParameters = { ...parametersFromJson, ...parametersFromRows }
            if (Object.keys(mergedParameters).length > 0) {
              result.parameters = mergedParameters
            }
            break
          }
          case 'skyvern_get_run':
            result.runId = params.runId
            break
        }

        return result
      },
    },
  },

  inputs: {
    operation: { type: 'string', description: 'Skyvern operation to perform' },
    baseUrl: { type: 'string', description: 'Skyvern server base URL' },
    apiKey: { type: 'string', description: 'Skyvern API key' },
    title: { type: 'string', description: 'Workflow title (create workflow)' },
    description: { type: 'string', description: 'Workflow description (create workflow)' },
    blockLabel: { type: 'string', description: 'Task block label (create workflow)' },
    url: { type: 'string', description: 'Starting URL (create workflow)' },
    navigationGoal: { type: 'string', description: 'Navigation goal (create workflow)' },
    dataExtractionGoal: {
      type: 'string',
      description: 'Data extraction goal (create workflow)',
    },
    prompt: { type: 'string', description: 'Task prompt (create workflow)' },
    workflowParameters: {
      type: 'json',
      description: 'Workflow parameter definitions (create workflow)',
    },
    page: { type: 'number', description: 'Page number (list workflows)' },
    pageSize: { type: 'number', description: 'Page size (list workflows)' },
    workflowPermanentId: {
      type: 'string',
      description: 'Permanent workflow ID wpid_... (run workflow)',
    },
    runWorkflowParameters: {
      type: 'json',
      description: 'Workflow run parameter rows (run workflow)',
    },
    runParameters: { type: 'json', description: 'Workflow run parameters JSON (run workflow)' },
    runId: { type: 'string', description: 'Workflow run ID wr_... (get run status)' },
  },

  outputs: {
    workflowId: { type: 'string', description: 'Workflow version ID (w_...)' },
    workflowPermanentId: {
      type: 'string',
      description: 'Permanent workflow ID (wpid_...)',
    },
    title: { type: 'string', description: 'Workflow title' },
    description: { type: 'string', description: 'Workflow description' },
    status: { type: 'string', description: 'Workflow or run status' },
    version: { type: 'number', description: 'Workflow version number' },
    agentId: { type: 'string', description: 'Agent ID' },
    workflows: {
      type: 'json',
      description:
        'List of workflows (workflowId, workflowPermanentId, title, description, status, version, agentId, createdAt, modifiedAt)',
    },
    count: { type: 'number', description: 'Number of workflows returned' },
    workflowRunId: { type: 'string', description: 'Workflow run ID (wr_...)' },
    agentRunId: { type: 'string', description: 'Agent run ID' },
    runId: { type: 'string', description: 'Workflow run ID' },
    output: {
      type: 'json',
      description: 'Run output payload including block outputs and extracted information',
    },
    failureReason: { type: 'string', description: 'Failure reason when a run fails' },
    downloadedFiles: { type: 'json', description: 'Files downloaded during a run' },
    recordingUrl: { type: 'string', description: 'Recording URL for a run' },
    screenshotUrls: { type: 'json', description: 'Screenshot URLs captured during a run' },
    createdAt: { type: 'string', description: 'Creation timestamp' },
    startedAt: { type: 'string', description: 'Run start timestamp' },
    finishedAt: { type: 'string', description: 'Run finish timestamp' },
    appUrl: { type: 'string', description: 'URL to view the run in the Skyvern app' },
    stepCount: { type: 'number', description: 'Number of steps executed in a run' },
    runType: { type: 'string', description: 'Run type (e.g. workflow_run)' },
  },
}

export const SkyvernBlockMeta = {
  tags: ['web-scraping', 'automation', 'agentic'],
  url: 'https://www.skyvern.com',
  templates: [
    {
      icon: SkyvernIcon,
      title: 'Skyvern appointment slot scraper',
      prompt:
        'Build a workflow that creates a Skyvern workflow to navigate a booking site, extracts available appointment slots for the next 14 days, runs the workflow with a starting URL parameter, polls run status until complete, and writes the extracted slots to a table.',
      modules: ['tables', 'agent', 'workflows'],
      category: 'operations',
      tags: ['automation', 'web-scraping'],
    },
    {
      icon: SkyvernIcon,
      title: 'Skyvern workflow catalog sync',
      prompt:
        'Create a scheduled workflow that lists all Skyvern workflows, compares titles and versions against a tracking table, and flags workflows that changed since the last sync.',
      modules: ['scheduled', 'tables', 'workflows'],
      category: 'engineering',
      tags: ['automation', 'monitoring'],
    },
    {
      icon: SkyvernIcon,
      title: 'Skyvern run failure alerter',
      prompt:
        'Build a workflow that runs a Skyvern workflow by permanent ID, polls the run status until it reaches a terminal state, and sends a Slack alert with the failure reason when the run fails.',
      modules: ['agent', 'workflows'],
      category: 'engineering',
      tags: ['automation', 'monitoring'],
      alsoIntegrations: ['slack'],
    },
  ],
  skills: [
    {
      name: 'create-ui-automation-workflow',
      description:
        'Create a Skyvern workflow with a browser task block for navigation and structured data extraction.',
      content:
        '# Create UI Automation Workflow\n\nDefine a reusable Skyvern workflow for browser automation.\n\n## Steps\n1. Use Create Workflow with a title, starting URL, navigation goal, and data extraction goal.\n2. Set the block label if downstream runs need a specific output parameter name.\n3. Save the returned workflowPermanentId (wpid_...) for later runs.\n\n## Output\nReturn the workflowPermanentId, title, and status so the workflow can be triggered in a follow-up step.',
    },
    {
      name: 'run-and-poll-workflow',
      description: 'Trigger a Skyvern workflow run and poll until it reaches a terminal status.',
      content:
        '# Run and Poll Workflow\n\nExecute a Skyvern workflow and wait for completion.\n\n## Steps\n1. Use Run Workflow with the permanent workflow ID (wpid_...) and any required parameters such as starting_url.\n2. Capture the workflowRunId (wr_...) from the response.\n3. Use Get Run Status in a loop until status is completed, failed, terminated, timed_out, or canceled.\n\n## Output\nReturn the final status, extracted output payload, and failureReason if the run did not succeed.',
    },
    {
      name: 'list-and-select-workflow',
      description: 'List Skyvern workflows and pick the right one to run by title or ID.',
      content:
        '# List and Select Workflow\n\nFind an existing Skyvern workflow before running it.\n\n## Steps\n1. Use List Workflows to fetch available workflows for the organization.\n2. Match the desired workflow by title or workflowPermanentId.\n3. Pass the selected workflowPermanentId to Run Workflow.\n\n## Output\nReturn the chosen workflowPermanentId, title, and version for the next step.',
    },
  ],
} as const satisfies BlockMeta
