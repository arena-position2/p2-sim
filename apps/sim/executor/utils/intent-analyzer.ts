import { db } from '@sim/db'
import { createLogger } from '@sim/logger'
import { and, desc, eq, isNotNull } from 'drizzle-orm'
import { generateRequestId } from '@/lib/core/utils/request'
import type { AgentInputs, Message } from '@/executor/handlers/agent/types'
import type { ExecutionContext } from '@/executor/types'
import { extractTextContent } from '@/providers/google/utils'

const logger = createLogger('IntentAnalyzer')

/**
 * Result returned by the intent analyzer.
 */
export interface IntentAnalyzerResult {
  /** Whether the workflow should RUN or be SKIPped */
  decision: 'RUN' | 'SKIP'
  /** Mem0 conversation search results (reusable for RUN path) */
  searchResults: Message[]
  /** Token-limited memory context string built from search results */
  memoryContext: string
  /** Generated LLM response when decision is SKIP */
  skipResponse?: string
  /** Formatted user message sent to LLM when decision is SKIP */
  skipUserMessage?: string
  /** System prompt used when decision is SKIP */
  skipSystemPrompt?: string
  /** Latest conversation from workflow_execution_logs (most recent in current thread) */
  lastConversation?: LatestConversation | null
}

/**
 * Result from fetching the latest conversation log entry.
 */
export interface LatestConversation {
  initialInput: string | null
  finalChatOutput: string | null
}

/**
 * Parameters for the intent analyzer.
 */
export interface IntentAnalyzerParams {
  ctx: ExecutionContext
  inputs: AgentInputs
  blockId: string
  userPrompt: string
  /** Model identifier used for token limit calculation */
  model?: string
  /** Whether to use Gemini 2.5 Pro instead of OpenAI GPT-4o for intent decision */
  useGemini?: boolean
  /** Fact memories from Mem0 search (optional, will be fetched if not provided) */
  factMemories?: Message[]
}

/**
 * Fetches the intent analyzer system prompt from the master_config table.
 * Returns null if unavailable (caller should use a fallback).
 */
async function fetchIntentAnalyzerPrompt(): Promise<string | null> {
  try {
    const { masterConfig } = await import('@sim/db/schema')
    const { PROMPT_CONFIG_KEYS } = await import('@sim/db/constants')

    const rows = await db
      .select({ value: masterConfig.value })
      .from(masterConfig)
      .where(eq(masterConfig.key, PROMPT_CONFIG_KEYS.INTENT_ANALYZER_SYSTEM_PROMPT))
      .limit(1)

    if (rows.length > 0 && rows[0].value) {
      return rows[0].value
    }
  } catch (error) {
    logger.warn('Failed to fetch intent analyzer prompt from master_config table', { error })
  }

  return null
}

/**
 * Fetches the skip response generation system prompt from the master_config table.
 * Returns null if unavailable (caller should use a fallback).
 */
async function fetchSkipResponseSystemPrompt(): Promise<string | null> {
  try {
    const { masterConfig } = await import('@sim/db/schema')
    const { PROMPT_CONFIG_KEYS } = await import('@sim/db/constants')

    const rows = await db
      .select({ value: masterConfig.value })
      .from(masterConfig)
      .where(eq(masterConfig.key, PROMPT_CONFIG_KEYS.GENERATE_SKIP_RESPONSE_SYSTEM_PROMPT))
      .limit(1)

    if (rows.length > 0 && rows[0].value) {
      return rows[0].value
    }
  } catch (error) {
    logger.warn('Failed to fetch skip response system prompt from master_config table', { error })
  }

  return null
}

/**
 * Searches Mem0 for conversation memories and builds a token-limited context string.
 * Combines results from searches with and without conversationId filter, sorts by score (ascending),
 * and builds memory context from the sorted combined results.
 */
async function searchAndBuildMemoryContext(
  params: IntentAnalyzerParams
): Promise<{ searchResults: Message[]; memoryContext: string }> {
  const { ctx, inputs, blockId, userPrompt, model } = params

  // Use the reusable function to get combined, deduplicated, and sorted results
  const searchResults = await combineAndSortSearchResults(ctx, inputs, blockId, userPrompt, model)

  logger.debug('Combined and sorted search results count:', searchResults.length)

  // Build token-limited memory context from sorted results
  const { getMemoryTokenLimit } = await import('@/executor/handlers/agent/memory-utils')
  const { getAccurateTokenCount } = await import('@/lib/tokenization/accurate')

  const tokenLimit = getMemoryTokenLimit(model)
  const baseTokens = getAccurateTokenCount(userPrompt ?? '', model)
  let currentTokenCount = baseTokens
  let memoryContext = '\n=== PREVIOUS CONVERSATION ===:\n'

  for (const memory of searchResults) {
    const memoryText = `${memory.role === 'user' ? 'User' : 'Assistant'}: ${memory.content}`
    const memoryTokens = getAccurateTokenCount(memoryText, model)

    if (currentTokenCount + memoryTokens <= tokenLimit) {
      memoryContext += memoryText
      currentTokenCount += memoryTokens
    } else {
      logger.debug('Stopped adding memories due to token limit', {
        blockId,
        tokenLimit,
        currentTokens: currentTokenCount,
        memoryTokens,
      })
      break
    }
  }

  return { searchResults, memoryContext }
}

/**
 * Combines, deduplicates, and sorts raw search results by score (ascending).
 * Returns sorted Message[] array.
 */
export async function combineAndSortSearchResults(
  ctx: ExecutionContext,
  inputs: AgentInputs,
  blockId: string,
  userPrompt: string | undefined,
  _model?: string
): Promise<Message[]> {
  // Get raw search results (before conversion to Messages) to access score field
  const rawResultsWithoutConversationId = await getRawSearchResults(
    ctx,
    inputs,
    blockId,
    userPrompt,
    true,
    false
  )

  const rawResultsWithConversationId = await getRawSearchResults(
    ctx,
    inputs,
    blockId,
    userPrompt,
    true,
    true
  )

  // Combine both result sets
  const allRawResults = [
    ...(rawResultsWithoutConversationId || []),
    ...(rawResultsWithConversationId || []),
  ]

  if (allRawResults.length === 0) {
    return []
  }

  // Remove duplicates by id (keep first occurrence)
  const uniqueResults = Array.from(new Map(allRawResults.map((item) => [item.id, item])).values())

  // Filter results by score threshold
  // 1. Ignore results where score = 0
  // 2. Ignore results where score > 0.50 (threshold)
  const SCORE_THRESHOLD = 0.5
  const filteredResults = uniqueResults.filter((result) => {
    const score = result.score ?? 1.0 // Default to 1.0 if score is missing
    return score !== 0 && score <= SCORE_THRESHOLD
  })

  // Sort by score in increasing order (lower score = higher relevance in semantic search)
  const sortedResults = filteredResults.sort((a, b) => {
    const scoreA = a.score ?? 1.0 // Default to 1.0 if score is missing
    const scoreB = b.score ?? 1.0
    return scoreA - scoreB
  })

  // Convert sorted raw results to Messages
  const searchResults: Message[] = []
  for (const result of sortedResults) {
    if (result.memory && typeof result.memory === 'string' && result.role) {
      searchResults.push({
        role: result.role as 'system' | 'user' | 'assistant',
        content: result.memory,
      })
    }
  }

  return searchResults
}

/**
 * Gets raw search results from Mem0 API (before conversion to Messages) to access score field.
 */
async function getRawSearchResults(
  ctx: ExecutionContext,
  inputs: AgentInputs,
  _blockId: string,
  userPrompt: string | undefined,
  isConversation: boolean,
  includeConversationId: boolean
): Promise<any[] | null> {
  // Only call Mem0 API for chat trigger type
  const triggerType = ctx.metadata?.triggerType
  if (triggerType !== 'chat') {
    return null
  }

  // Skip if userId is not available (required for search API)
  if (!ctx.userId) {
    return null
  }

  try {
    const query = userPrompt || ''

    // Build filters object
    const filters: Record<string, any> = {}

    if (includeConversationId && inputs.conversationId) {
      filters.conversation_id = inputs.conversationId
    }

    if (isConversation === true) {
      filters.memory_type = 'conversation'
    } else {
      filters.memory_type = 'fact'
    }

    const isDeployed = ctx.isDeployedContext ?? false
    const requestId = generateRequestId()

    // Dynamically import searchMemoryAPI to avoid circular dependencies
    const { searchMemoryAPI } = await import('@/app/api/chat/memory-api')

    // Call search API and get raw results
    const rawResults = await searchMemoryAPI(
      requestId,
      query,
      ctx.userId,
      Object.keys(filters).length > 0 ? filters : undefined,
      undefined, // runId
      undefined, // agentId
      isDeployed
    )

    if (!rawResults) {
      return null
    }

    // Extract results array from response
    let results: any[] = []
    if (Array.isArray(rawResults)) {
      results = rawResults
    } else if (rawResults.results && Array.isArray(rawResults.results)) {
      results = rawResults.results
    } else if (rawResults.memories && Array.isArray(rawResults.memories)) {
      results = rawResults.memories
    } else if (rawResults.data && Array.isArray(rawResults.data)) {
      results = rawResults.data
    }

    return results
  } catch (error) {
    logger.error('Failed to get raw search results:', error)
    return null
  }
}

/**
 * Calls GPT-4o or Gemini 2.5 Pro to decide whether the workflow should RUN or be SKIPped.
 */
async function callIntentDecision(
  systemPrompt: string,
  memoryContext: string,
  userPrompt: string,
  lastConversation: LatestConversation | null,
  useGemini = false
): Promise<'RUN' | 'SKIP'> {
  let lastConversationText = ''
  if (lastConversation) {
    const parts: string[] = []
    parts.push(`\LAST CONVERSATION:\n`)
    if (lastConversation.initialInput) {
      parts.push(`User: ${lastConversation.initialInput}`)
    }
    if (lastConversation.finalChatOutput) {
      parts.push(`Assistant: ${lastConversation.finalChatOutput}`)
    }
    if (parts.length > 0) {
      lastConversationText = parts.join('\n')
    }
  }

  // const controllerUserPrompt = `If the current request can be fulfilled using ONLY the information already present in the conversation history, treat it as SAME INTENT.\n${lastConversationText}\n\n. Previous conversation history related to the current user input:\n${memoryContext}\n\nCurrent User Input: ${userPrompt}`

  const controllerUserPrompt = `You are an intent analyzer.
Analyze the user's current request and decide whether to RUN the workflow or SKIP it.
Important:
- If the user question can be answered using the retrieved chat history below,
  return SKIP.
- If answering requires new workflow execution, return RUN.
--------------------------------------------
USER CURRENT MESSAGE
--------------------------------------------
${userPrompt}
--------------------------------------------
${lastConversationText}
--------------------------------------------
${memoryContext}
--------------------------------------------
OUTPUT REQUIREMENT
--------------------------------------------
Return ONLY ONE WORD:
RUN
or
SKIP
`

  try {
    if (useGemini) {
      const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY
      if (!apiKey) {
        logger.warn('GEMINI_API_KEY or GOOGLE_API_KEY not found, defaulting to RUN')
        return 'RUN'
      }

      const modelName = 'gemini-2.5-pro'
      const requestBody: any = {
        contents: [
          {
            parts: [
              {
                text: controllerUserPrompt,
              },
            ],
          },
        ],
        systemInstruction: {
          parts: [
            {
              text: systemPrompt,
            },
          ],
        },
        generationConfig: {
          temperature: 0,
          maxOutputTokens: 50000, // Increased to ensure Gemini can generate "RUN" or "SKIP" response
        },
      }

      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(requestBody),
        }
      )

      if (!response.ok) {
        const error = await response.json().catch(() => ({}))
        const errorMessage = error.error?.message || JSON.stringify(error)
        logger.warn(`Failed to call Gemini for intent decision: ${errorMessage}, defaulting to RUN`)
        return 'RUN'
      }

      const data = await response.json()

      const candidate = data.candidates?.[0]
      if (!candidate) {
        // No candidates in Gemini API response, defaulting to RUN
        return 'RUN'
      }

      if (candidate.finishReason === 'SAFETY') {
        logger.warn('Gemini content was blocked by safety filters, defaulting to RUN')
        return 'RUN'
      }

      // Use the existing utility function to extract text (handles thought parts filtering)
      const decisionText = extractTextContent(candidate)

      // If MAX_TOKENS but we got some text, try to use it
      if (!decisionText && candidate.finishReason === 'MAX_TOKENS') {
        logger.warn(
          'Gemini hit MAX_TOKENS limit, but no text extracted. This may indicate the limit is too low.',
          {
            hasContent: !!candidate.content,
            hasParts: !!candidate.content?.parts,
            partsLength: candidate.content?.parts?.length,
          }
        )
        return 'RUN'
      }

      if (!decisionText) {
        logger.warn('Invalid response structure from Gemini API, defaulting to RUN', {
          finishReason: candidate.finishReason,
          hasContent: !!candidate.content,
          hasParts: !!candidate.content?.parts,
          partsLength: candidate.content?.parts?.length,
          candidateStructure: JSON.stringify(candidate).substring(0, 500),
        })
        return 'RUN'
      }

      const decision = decisionText.trim().toUpperCase()

      if (decision === 'SKIP') {
        logger.debug('Intent analyzer decided SKIP (Gemini)')
        return 'SKIP'
      }

      logger.info('Intent analyzer decided RUN (Gemini)', { decision })
      return 'RUN'
    }

    // const { OpenAI } = await import('openai')
    // const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

    // const completion = await openai.chat.completions.create({
    //   model: 'gpt-4o',
    //   messages: [
    //     { role: 'system', content: systemPrompt },
    //     { role: 'user', content: controllerUserPrompt },
    //   ],
    //   temperature: 0,
    //   max_tokens: 10,
    // })

    // const decision = completion.choices[0]?.message?.content?.trim().toUpperCase()

    // if (decision === 'SKIP') {
    //   logger.debug('Intent analyzer decided SKIP')
    //   return 'SKIP'
    // }

    // logger.info('Intent analyzer decided RUN', { decision })
    return 'RUN'
  } catch (error) {
    const provider = useGemini ? 'Gemini' : 'OpenAI'
    logger.warn(`Failed to call ${provider} for intent decision, defaulting to RUN`, { error })
    return 'RUN'
  }
}

/**
 * Fetches the latest `initial_input` and `final_chat_output` from
 * `workflow_execution_logs` for a given conversationId. Returns null if none found.
 */
export async function fetchLatestConversation(
  conversationId: string
): Promise<LatestConversation | null> {
  try {
    const { workflowExecutionLogs } = await import('@sim/db/schema')

    const rows = await db
      .select({
        initialInput: workflowExecutionLogs.initialInput,
        finalChatOutput: workflowExecutionLogs.finalChatOutput,
      })
      .from(workflowExecutionLogs)
      .where(
        and(
          eq(workflowExecutionLogs.conversationId, conversationId),
          isNotNull(workflowExecutionLogs.finalChatOutput)
        )
      )
      .orderBy(desc(workflowExecutionLogs.startedAt))
      .limit(1)

    if (rows.length > 0 && rows[0].finalChatOutput) {
      return {
        initialInput: rows[0].initialInput,
        finalChatOutput: rows[0].finalChatOutput,
      }
    }
  } catch (error) {
    logger.warn('Failed to fetch latest conversation from workflow_execution_logs', { error })
  }

  return null
}

/**
 * Generates a response using GPT-4o when the workflow is SKIPped.
 * Combines: user prompt + last conversation + fact memories + Mem0 conversation context.
 */
async function generateSkipResponse(
  memoryContext: string,
  userPrompt: string,
  lastConversation: LatestConversation | null,
  factMemories: Message[] = []
): Promise<{ response: string; userMessage: string; systemPrompt: string }> {
  try {
    const { OpenAI } = await import('openai')
    const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY })

    // Fetch system prompt from master_config table, fallback to default if not found
    const dbSystemPrompt = await fetchSkipResponseSystemPrompt()
    const systemPrompt = dbSystemPrompt || ''

    const contextParts: string[] = []

    // Add last conversation (highest priority)
    if (lastConversation) {
      const lastConvParts: string[] = []
      lastConvParts.push('=== LAST CONVERSATION (MOST RELEVANT): ===')
      if (lastConversation.initialInput) {
        lastConvParts.push(`User: ${lastConversation.initialInput}`)
      }
      if (lastConversation.finalChatOutput) {
        lastConvParts.push(`Assistant: ${lastConversation.finalChatOutput}`)
      }
      if (lastConvParts.length > 1) {
        contextParts.push(lastConvParts.join('\n'))
      }
    }

    // Add fact memories
    if (factMemories && factMemories.length > 0) {
      const factParts: string[] = []
      factParts.push('=== FACT MEMORIES (RELEVANT FACTS): ===')
      for (const fact of factMemories) {
        factParts.push(`${fact.role === 'user' ? 'User' : 'Assistant'}: ${fact.content}`)
      }
      contextParts.push(factParts.join('\n'))
    }

    // Add semantically retrieved chat history (secondary reference)
    if (memoryContext) {
      contextParts.push(
        `=== SEMANTICALLY RETRIEVED CHAT HISTORY (from other chats): === (DO NOT ANSWER ANY QUESTIONS FROM HERE JUST USE AS CONTEXT)\n${memoryContext}`
      )
    }

    const contextText =
      contextParts.length > 0
        ? contextParts.join('\n\n')
        : 'No previous conversation history available.'

    const userMessage = `CURRENT USER QUESTION (ANSWER THIS ONLY):
${userPrompt}

────────────────────────────────────────
CONTEXT FOR REFERENCE 
────────────────────────────────────────
${contextText}

IMPORTANT: Answer ONLY the CURRENT USER QUESTION above. The context sections are provided for reference only. Do NOT repeat or rephrase responses from the context. If the current question asks about "the above points" or similar references, and those points are not clearly visible in the context, use your general knowledge or ask for clarification.`

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userMessage },
      ],
      temperature: 0.7,
    })

    const response = completion.choices[0]?.message?.content?.trim()

    if (response) {
      logger.debug('Generated SKIP response from conversation context', {
        hasLastConversation: !!lastConversation,
        factMemoriesCount: factMemories.length,
        hasMemoryContext: !!memoryContext,
      })
      return {
        response,
        userMessage,
        systemPrompt,
      }
    }

    return {
      response: 'I was unable to generate a response from the conversation history.',
      userMessage,
      systemPrompt,
    }
  } catch (error) {
    logger.warn('Failed to generate SKIP response', { error })
    return {
      response: 'I was unable to generate a response. Please try again.',
      userMessage: '',
      systemPrompt: '',
    }
  }
}

/**
 * Analyzes user intent against Mem0 conversation history to decide
 * whether to RUN the workflow or SKIP it (answering from memory).
 *
 * Flow:
 * 1. Search Mem0 for conversation memories based on user input
 * 2. Build token-limited memory context from search results
 * 3. Call LLM to decide RUN or SKIP
 * 4. If SKIP: generate a response from memory context
 * 5. Return decision, search results (reusable for RUN path), and optional skip response
 */
export async function analyzeIntent(params: IntentAnalyzerParams): Promise<IntentAnalyzerResult> {
  const { ctx, userPrompt } = params

  logger.info('Intent analyzer: starting', {
    workflowId: ctx.workflowId,
    conversationId: params.inputs.conversationId,
    userPromptPreview: userPrompt?.substring(0, 80),
  })

  // 1. Search Mem0 for conversation memories and build token-limited context
  logger.info('Intent analyzer: step 1 - searching Mem0 for conversation memories')
  const { searchResults, memoryContext } = await searchAndBuildMemoryContext(params)
  logger.info('Intent analyzer: step 1 done', {
    searchResultsCount: searchResults.length,
    memoryContextLength: memoryContext.length,
  })

  // 2. Fetch the intent analyzer system prompt from DB
  logger.info('Intent analyzer: step 2 - fetching system prompt from DB')
  const dbPrompt = await fetchIntentAnalyzerPrompt()
  logger.info('Intent analyzer: step 2 done', { hasDbPrompt: !!dbPrompt })

  if (!dbPrompt) {
    logger.warn('No intent analyzer prompt configured in master_config table, defaulting to RUN')
    // Fetch the latest conversation even if we're defaulting to RUN
    const conversationId = params.inputs.conversationId
    const lastConversation = conversationId ? await fetchLatestConversation(conversationId) : null
    return {
      decision: 'RUN',
      searchResults,
      memoryContext,
      lastConversation,
    }
  }

  // 3. Fetch the latest conversation from workflow_execution_logs
  logger.info('Intent analyzer: step 3 - fetching latest conversation from DB')
  const conversationId = params.inputs.conversationId
  const lastConversation = conversationId ? await fetchLatestConversation(conversationId) : null
  logger.info('Intent analyzer: step 3 done', { hasLastConversation: !!lastConversation })

  // 4. Get fact memories (if not provided)
  logger.info('Intent analyzer: step 4 - getting fact memories')
  const factMemories =
    params.factMemories !== undefined
      ? params.factMemories
      : params.inputs.memoryType
        ? await (async (): Promise<Message[]> => {
            const raw = await getRawSearchResults(
              ctx,
              params.inputs,
              params.blockId,
              userPrompt,
              false,
              false
            )
            if (!raw?.length) return []
            const messages: Message[] = []
            for (const result of raw) {
              if (result.memory && typeof result.memory === 'string' && result.role) {
                messages.push({
                  role: result.role as 'system' | 'user' | 'assistant',
                  content: result.memory,
                })
              }
            }
            return messages
          })()
        : []

  logger.info('Intent analyzer: step 4 done', { factMemoriesCount: factMemories.length })

  logger.debug('Intent analyzer context', {
    conversationId,
    hasLastConversation: !!lastConversation,
    factMemoriesCount: factMemories.length,
    conversationMemoriesCount: searchResults.length,
  })

  // 5. Call LLM to decide RUN or SKIP (includes last conversation context)
  logger.info('Intent analyzer: step 5 - calling LLM for RUN/SKIP decision')
  const decision = await callIntentDecision(
    dbPrompt,
    memoryContext,
    userPrompt,
    lastConversation,
    params.useGemini ?? false
  )

  logger.info('Intent analyzer: step 5 done', { decision })

  // 6. If SKIP, generate a response using the already-fetched conversation context
  if (decision === 'SKIP') {
    logger.info('Intent analyzer: step 6 - generating SKIP response')
    const skipResult = await generateSkipResponse(
      memoryContext,
      userPrompt,
      lastConversation,
      factMemories
    )
    logger.info('Intent analyzer: step 6 done - returning SKIP result')
    return {
      decision: 'SKIP',
      searchResults,
      memoryContext,
      skipResponse: skipResult.response,
      skipUserMessage: skipResult.userMessage,
      skipSystemPrompt: skipResult.systemPrompt,
      lastConversation,
    }
  }

  logger.info('Intent analyzer: completed with RUN decision')
  return {
    decision: 'RUN',
    searchResults,
    memoryContext,
    lastConversation,
  }
}
