import { createLogger } from '@sim/logger'
import OpenAI from 'openai'
import type { StreamingExecution } from '@/executor/types'
import { getProviderDefaultModel, getProviderModels } from '@/providers/models'
import type {
  ProviderConfig,
  ProviderRequest,
  ProviderResponse,
  TimeSegment,
} from '@/providers/types'
import {
  isFunctionToolCall,
  prepareToolExecution,
  prepareToolsWithUsageControl,
  trackForcedToolUsage,
} from '@/providers/utils'
import { executeTool } from '@/tools'

const logger = createLogger('SambaNovaProvider')

/**
 * Helper to convert OpenAI stream to ReadableStream and collect usage
 */
function createReadableStreamFromOpenAIStream(
  openaiStream: any,
  onComplete?: (content: string, usage?: any) => void
): ReadableStream {
  let fullContent = ''
  let usageData: any = null

  return new ReadableStream({
    async start(controller) {
      try {
        for await (const chunk of openaiStream) {
          if (chunk.usage) usageData = chunk.usage

          // Add error handling for empty or undefined choices array in streaming
          if (!chunk.choices || chunk.choices.length === 0) {
            logger.warn('SambaNova streaming chunk has empty choices array:', chunk)
            continue
          }

          const content = chunk.choices[0]?.delta?.content || ''
          if (content) {
            fullContent += content
            controller.enqueue(new TextEncoder().encode(content))
          }
        }

        if (onComplete) onComplete(fullContent, usageData)
        controller.close()
      } catch (error) {
        controller.error(error)
      }
    },
  })
}

/**
 * SambaNova provider configuration
 */
export const sambanovaProvider: ProviderConfig = {
  id: 'sambanova',
  name: 'SambaNova',
  description: "SambaNova's AI models",
  version: '1.0.0',
  models: getProviderModels('sambanova'),
  defaultModel: getProviderDefaultModel('sambanova'),

  executeRequest: async (
    request: ProviderRequest
  ): Promise<ProviderResponse | ReadableStream | StreamingExecution> => {
    // SambaNova request preparation

    // SambaNova uses OpenAI-compatible API
    const sambanova = new OpenAI({
      apiKey: request.apiKey,
      baseURL: 'https://api.sambanova.ai/v1',
    })

    // Start with an empty array for all messages
    const allMessages = []

    // Add system prompt if present
    if (request.systemPrompt) {
      allMessages.push({
        role: 'system',
        content: request.systemPrompt,
      })
    }

    // Add context if present
    if (request.context) {
      allMessages.push({
        role: 'user',
        content: request.context,
      })
    }

    // Add remaining messages
    if (request.messages) {
      allMessages.push(...request.messages)
    }

    // Transform tools to OpenAI format if provided
    const tools = request.tools?.length
      ? request.tools.map((tool) => ({
          type: 'function',
          function: {
            name: tool.id,
            description: tool.description,
            parameters: tool.parameters,
          },
        }))
      : undefined

    // Resolve model ID to canonical SambaNova spelling (case-insensitive)
    const availableModels = getProviderModels('sambanova')
    const knownCanonical: string[] = [
      // Include commented/alias models for robust resolution
      'DeepSeek-R1-Distill-Llama-70B',
      'DeepSeek-R1-0528',
      'DeepSeek-V3-0324',
      'DeepSeek-V3.1',
      'DeepSeek-V3.2',
      'Meta-Llama-3.1-70B-Instruct',
      'Meta-Llama-3.1-8B-Instruct',
      'Meta-Llama-3.1-405B-Instruct',
      'Meta-Llama-3.3-70B-Instruct',
      'Llama-3.3-Swallow-70B-Instruct-v0.4',
      'Llama-4-Maverick-17B-128E-Instruct',
      'gpt-oss-120b',
      'E5-Mistral-7B-Instruct',
      'Qwen3-32B',
      // Whisper ASR
      'Whisper-Large-v3',
    ]

    function resolveModelId(requested?: string): string {
      const defModel = getProviderDefaultModel('sambanova')
      if (!requested) return defModel
      const req = requested.toString().trim()
      const lower = req.toLowerCase()
      // Prefer currently available models
      const matchAvailable = availableModels.find((m) => m.toLowerCase() === lower)
      if (matchAvailable) return matchAvailable
      // Then check known canonical aliases (including commented ones)
      const matchKnown = knownCanonical.find((m) => m.toLowerCase() === lower)
      if (matchKnown) return matchKnown
      // Special normalization for common inputs
      if (lower === 'deepseek-r1-distill-llama-70b') return 'DeepSeek-R1-Distill-Llama-70B'
      if (lower === 'deepseek-v3.1' || lower === 'deepseek-v3-1') return 'DeepSeek-V3.1'
      if (lower === 'deepseek-v3.2' || lower === 'deepseek-v3-2') return 'DeepSeek-V3.2'
      return req
    }

    const resolvedModel = resolveModelId(request.model)

    // Build the request payload
    const payload: any = {
      model: resolvedModel,
      messages: allMessages,
    }

    // Ensure we always have at least one user message
    if (!Array.isArray(payload.messages) || payload.messages.length === 0) {
      payload.messages = [
        {
          role: 'user',
          content: request.context || ' ',
        },
      ]
    }

    // Optional params
    if (request.temperature !== undefined) {
      payload.temperature = request.temperature
    }
    if (request.maxTokens !== undefined) {
      payload.max_tokens = Number(request.maxTokens)
    }

    // Structured output - SambaNova doesn't support strict mode
    // Note: SambaNova API returns error "response_format of type 'json_schema' does not currently support 'strict' value to be True"
    if (request.responseFormat) {
      payload.response_format = {
        type: 'json_schema',
        json_schema: {
          name: request.responseFormat.name || 'response_schema',
          schema: request.responseFormat.schema || request.responseFormat,
          // SambaNova doesn't support strict: true, so we omit it
        },
      }
    }

    // Handle tools and tool usage control similar to OpenAI
    let preparedTools: ReturnType<typeof prepareToolsWithUsageControl> | null = null
    if (tools?.length) {
      preparedTools = prepareToolsWithUsageControl(tools, request.tools, logger, 'sambanova')
      const { tools: filteredTools, toolChoice } = preparedTools
      if (filteredTools?.length && toolChoice) {
        payload.tools = filteredTools
        payload.tool_choice = toolChoice
      }
    }

    // Validate the request before sending
    if (!payload.messages || payload.messages.length === 0) {
      throw new Error('SambaNova request validation failed: No messages provided')
    }

    // Validate request messages
    const invalidMessages = payload.messages.filter(
      (msg: any) => !msg.content || msg.content.trim() === ''
    )
    if (invalidMessages.length > 0) {
      logger.warn('SambaNova request has messages with empty content')
    }

    // Timing
    const providerStartTime = Date.now()
    const providerStartTimeISO = new Date(providerStartTime).toISOString()

    try {
      // Try the main request first
      let currentResponse
      try {
        currentResponse = await sambanova.chat.completions.create(payload)
      } catch (apiError: any) {
        // If it's a 400 error, try with a simplified payload
        if (apiError.status === 400) {
          const simplifiedPayload = {
            model: payload.model,
            messages: payload.messages,
            temperature: payload.temperature,
            max_tokens: payload.max_tokens,
          }
          currentResponse = await sambanova.chat.completions.create(simplifiedPayload)
        } else if (
          apiError.message?.includes('response_format') ||
          apiError.message?.includes('strict')
        ) {
          // Retry without response_format due to SambaNova compatibility
          const { response_format, ...payloadWithoutFormat } = payload
          currentResponse = await sambanova.chat.completions.create(payloadWithoutFormat)
        } else {
          throw apiError
        }
      }

      // Streaming path when no tools
      if (request.stream && (!tools || tools.length === 0)) {
        const streamResponse = await sambanova.chat.completions.create({
          ...payload,
          stream: true,
          stream_options: { include_usage: true },
        })

        const tokenUsage = { prompt: 0, completion: 0, total: 0 }
        const streamingResult = {
          stream: createReadableStreamFromOpenAIStream(streamResponse, (content, usage) => {
            streamingResult.execution.output.content = content
            if (usage) {
              streamingResult.execution.output.tokens = {
                prompt: usage.prompt_tokens || tokenUsage.prompt,
                completion: usage.completion_tokens || tokenUsage.completion,
                total: usage.total_tokens || tokenUsage.total,
              }
            }
          }),
          execution: {
            success: true,
            output: {
              content: '',
              model: request.model,
              tokens: tokenUsage,
              providerTiming: {
                startTime: providerStartTimeISO,
                endTime: new Date().toISOString(),
                duration: Date.now() - providerStartTime,
                timeSegments: [
                  {
                    type: 'model',
                    name: 'Streaming response',
                    startTime: providerStartTime,
                    endTime: Date.now(),
                    duration: Date.now() - providerStartTime,
                  },
                ],
              },
            },
            logs: [],
            metadata: {
              startTime: providerStartTimeISO,
              endTime: new Date().toISOString(),
              duration: Date.now() - providerStartTime,
            },
          },
        } as StreamingExecution

        return streamingResult as StreamingExecution
      }

      // Non-streaming and/or tools path — iterative tool handling
      const initialCallTime = Date.now()
      const originalToolChoice = payload.tool_choice
      const forcedTools = preparedTools?.forcedTools || []
      let usedForcedTools: string[] = []

      const checkForForcedToolUsage = (
        response: any,
        toolChoice: string | { type: string; function?: { name: string }; name?: string; any?: any }
      ) => {
        if (typeof toolChoice === 'object' && response.choices[0]?.message?.tool_calls) {
          const toolCallsResponse = response.choices[0].message.tool_calls
          const result = trackForcedToolUsage(
            toolCallsResponse,
            toolChoice,
            logger,
            'sambanova',
            forcedTools,
            usedForcedTools
          )
          hasUsedForcedTool = result.hasUsedForcedTool
          usedForcedTools = result.usedForcedTools
        }
      }

      // Use the currentResponse from the try-catch block above
      const firstResponseTime = Date.now() - initialCallTime

      // Add error handling for empty or undefined choices array
      if (!currentResponse.choices || currentResponse.choices.length === 0) {
        // Check if it's an error response
        if ((currentResponse as any).error) {
          throw new Error(
            `SambaNova API error: ${(currentResponse as any).error.message || JSON.stringify((currentResponse as any).error)}`
          )
        }

        throw new Error('SambaNova API returned empty response - no choices available')
      }

      let content = currentResponse.choices[0]?.message?.content || ''
      const tokens = {
        prompt: currentResponse.usage?.prompt_tokens || 0,
        completion: currentResponse.usage?.completion_tokens || 0,
        total: currentResponse.usage?.total_tokens || 0,
      }
      const toolCalls: any[] = []
      const toolResults: any[] = []
      const currentMessages = [...allMessages]
      let iterationCount = 0
      const MAX_ITERATIONS = 10
      let modelTime = firstResponseTime
      let toolsTime = 0
      let hasUsedForcedTool = false
      const timeSegments: TimeSegment[] = [
        {
          type: 'model',
          name: 'Initial response',
          startTime: initialCallTime,
          endTime: initialCallTime + firstResponseTime,
          duration: firstResponseTime,
        },
      ]

      checkForForcedToolUsage(currentResponse, originalToolChoice)

      while (iterationCount < MAX_ITERATIONS) {
        // Add error handling for empty or undefined choices array in loop
        if (!currentResponse.choices || currentResponse.choices.length === 0) {
          logger.error('SambaNova API returned empty choices array in iteration')
          break
        }

        const toolCallsInResponse = currentResponse.choices[0]?.message?.tool_calls
        if (!toolCallsInResponse?.length) break

        const toolsStartTime = Date.now()
        for (const toolCall of toolCallsInResponse.filter(isFunctionToolCall)) {
          try {
            const toolName = toolCall.function.name
            const toolArgs = JSON.parse(toolCall.function.arguments)
            const tool = request.tools?.find((t) => t.id === toolName)
            if (!tool) continue

            const toolCallStartTime = Date.now()
            const { toolParams, executionParams } = prepareToolExecution(
              tool,
              toolArgs,
              request,
              toolCall.id
            )
            const result = await executeTool(toolName, executionParams)
            const toolCallEndTime = Date.now()
            const toolCallDuration = toolCallEndTime - toolCallStartTime

            timeSegments.push({
              type: 'tool',
              name: toolName,
              startTime: toolCallStartTime,
              endTime: toolCallEndTime,
              duration: toolCallDuration,
            })

            let resultContent: any
            if (result.success) {
              toolResults.push(result.output)
              resultContent = result.output
            } else {
              resultContent = {
                error: true,
                message: result.error || 'Tool execution failed',
                tool: toolName,
              }
            }

            toolCalls.push({
              name: toolName,
              arguments: toolParams,
              startTime: new Date(toolCallStartTime).toISOString(),
              endTime: new Date(toolCallEndTime).toISOString(),
              duration: toolCallDuration,
              result: resultContent,
              success: result.success,
            })

            currentMessages.push({
              role: 'assistant',
              content: null,
              tool_calls: [
                {
                  id: toolCall.id,
                  type: 'function',
                  function: { name: toolName, arguments: toolCall.function.arguments },
                },
              ],
            })
            currentMessages.push({
              role: 'tool',
              tool_call_id: toolCall.id,
              content: JSON.stringify(resultContent),
            })
          } catch (error) {
            logger.error('Error processing SambaNova tool call:', {
              error,
              toolName: toolCall.function.name,
            })
          }
        }
        const thisToolsTime = Date.now() - toolsStartTime
        toolsTime += thisToolsTime

        const nextPayload = { ...payload, messages: currentMessages }
        if (typeof originalToolChoice === 'object' && hasUsedForcedTool && forcedTools.length > 0) {
          const remainingTools = forcedTools.filter((tool) => !usedForcedTools.includes(tool))
          if (remainingTools.length > 0) {
            nextPayload.tool_choice = { type: 'function', function: { name: remainingTools[0] } }
            // Forcing next tool
          } else {
            nextPayload.tool_choice = 'auto'
            // All forced tools used, switching to auto
          }
        }

        const nextModelStartTime = Date.now()
        currentResponse = await sambanova.chat.completions.create(nextPayload)

        // Add error handling for empty or undefined choices array in next iteration
        if (!currentResponse.choices || currentResponse.choices.length === 0) {
          logger.error('SambaNova API returned empty choices array in next iteration')
          break
        }

        checkForForcedToolUsage(currentResponse, nextPayload.tool_choice)
        const nextModelEndTime = Date.now()
        const thisModelTime = nextModelEndTime - nextModelStartTime
        timeSegments.push({
          type: 'model',
          name: `Model response (iteration ${iterationCount + 1})`,
          startTime: nextModelStartTime,
          endTime: nextModelEndTime,
          duration: thisModelTime,
        })
        modelTime += thisModelTime
        if (currentResponse.choices[0]?.message?.content)
          content = currentResponse.choices[0].message.content
        if (currentResponse.usage) {
          tokens.prompt += currentResponse.usage.prompt_tokens || 0
          tokens.completion += currentResponse.usage.completion_tokens || 0
          tokens.total += currentResponse.usage.total_tokens || 0
        }
        iterationCount++
      }

      // Optional final streaming after tools (keep parity with OpenAI)
      if (request.stream && iterationCount > 0) {
        // Using streaming for final response after tool calls
        const streamingPayload = {
          ...payload,
          messages: currentMessages,
          tool_choice: 'auto',
          stream: true,
          stream_options: { include_usage: true },
        }
        const streamResponse = await sambanova.chat.completions.create(streamingPayload)

        const streamingResult = {
          stream: createReadableStreamFromOpenAIStream(streamResponse, (finalContent, usage) => {
            streamingResult.execution.output.content = finalContent
            if (usage) {
              streamingResult.execution.output.tokens = {
                prompt: usage.prompt_tokens || tokens.prompt,
                completion: usage.completion_tokens || tokens.completion,
                total: usage.total_tokens || tokens.total,
              }
            }
          }),
          execution: {
            success: true,
            output: {
              content: '',
              model: request.model,
              tokens: { ...tokens },
              toolCalls:
                toolCalls.length > 0 ? { list: toolCalls, count: toolCalls.length } : undefined,
              providerTiming: {
                startTime: providerStartTimeISO,
                endTime: new Date().toISOString(),
                duration: Date.now() - providerStartTime,
                modelTime,
                toolsTime,
                firstResponseTime,
                iterations: iterationCount + 1,
                timeSegments,
              },
            },
            logs: [],
            metadata: {
              startTime: providerStartTimeISO,
              endTime: new Date().toISOString(),
              duration: Date.now() - providerStartTime,
            },
          },
        } as StreamingExecution

        return streamingResult as StreamingExecution
      }

      const providerEndTime = Date.now()
      const providerEndTimeISO = new Date(providerEndTime).toISOString()

      return {
        content,
        model: request.model,
        tokens,
        toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
        toolResults: toolResults.length > 0 ? toolResults : undefined,
        timing: {
          startTime: providerStartTimeISO,
          endTime: providerEndTimeISO,
          duration: providerEndTime - providerStartTime,
          modelTime,
          toolsTime,
          firstResponseTime,
          iterations: iterationCount + 1,
          timeSegments,
        },
      }
    } catch (error: any) {
      const providerEndTime = Date.now()
      const providerEndTimeISO = new Date(providerEndTime).toISOString()
      const totalDuration = providerEndTime - providerStartTime
      const enhancedError = new Error(error instanceof Error ? error.message : String(error))
      // @ts-ignore
      enhancedError.timing = {
        startTime: providerStartTimeISO,
        endTime: providerEndTimeISO,
        duration: totalDuration,
      }
      throw enhancedError
    }
  },
}
