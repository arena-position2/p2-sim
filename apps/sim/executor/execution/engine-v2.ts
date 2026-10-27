import { createLogger, type Logger } from '@sim/logger'
import { toError } from '@sim/utils/errors'
import { combineExecutionAbortSignals } from '@/lib/core/execution-limits'
import { subscribeToExecutionCancellation } from '@/lib/execution/cancellation'
import { BlockType, EDGE } from '@/executor/constants'
import type { DAG } from '@/executor/dag/builder'
import type { EdgeManager } from '@/executor/execution/edge-manager'
import { serializePauseSnapshot } from '@/executor/execution/snapshot-serializer'
import type { SerializableExecutionState } from '@/executor/execution/types'
import type { NodeExecutionOrchestrator } from '@/executor/orchestrators/node'
import type {
  ExecutionContext,
  ExecutionResult,
  NormalizedBlockOutput,
  PauseMetadata,
  PausePoint,
  ResumeStatus,
} from '@/executor/types'
import { attachExecutionResult, normalizeError } from '@/executor/utils/errors'
import { buildSentinelEndId } from '@/executor/utils/subflow-utils'

const logger = createLogger('ExecutionEngineV2')

export class ExecutionEngineV2 {
  private readyQueue: string[] = []
  private executing = new Set<Promise<void>>()
  private queueLock = Promise.resolve()
  private finalOutput: NormalizedBlockOutput = {}
  private responseOutputLocked = false
  private pausedBlocks: Map<string, PauseMetadata> = new Map()
  private allowResumeTriggers: boolean
  private cancelledFlag = false
  private errorFlag = false
  private stoppedEarlyFlag = false
  private executionError: Error | null = null
  private abortPromise!: Promise<void>
  private abortResolve!: () => void
  private cancellationController = new AbortController()
  private abortSignalListener: (() => void) | null = null
  private cancellationUnsubscribe: (() => void) | null = null
  private skippedFlag = false // Track if workflow was skipped
  private execLogger: Logger

  constructor(
    private context: ExecutionContext,
    private dag: DAG,
    private edgeManager: EdgeManager,
    private nodeOrchestrator: NodeExecutionOrchestrator
  ) {
    this.allowResumeTriggers = this.context.metadata.resumeFromSnapshot === true
    this.execLogger = logger.withMetadata({
      workflowId: this.context.workflowId,
      workspaceId: this.context.workspaceId,
      executionId: this.context.executionId,
      userId: this.context.userId,
      requestId: this.context.metadata.requestId,
    })
    this.context.abortSignal = combineExecutionAbortSignals(
      this.context.abortSignal
        ? [this.context.abortSignal, this.cancellationController.signal]
        : [this.cancellationController.signal]
    )
    this.initializeAbortHandler()
  }

  private async subscribeToCancellationSignal(): Promise<void> {
    if (!this.context.executionId) return
    const executionId = this.context.executionId
    this.cancellationUnsubscribe = await subscribeToExecutionCancellation(executionId, () => {
      this.execLogger.info('Execution cancelled via Redis signal', { executionId })
      this.signalCancelled()
    })
  }

  private initializeAbortHandler(): void {
    this.abortPromise = new Promise<void>((resolve) => {
      this.abortResolve = resolve
    })

    if (!this.context.abortSignal) return

    const signal = this.context.abortSignal
    if (signal.aborted) {
      this.signalCancelled(signal.reason)
      return
    }

    this.abortSignalListener = () => this.signalCancelled(signal.reason)
    signal.addEventListener('abort', this.abortSignalListener, { once: true })
  }

  private signalCancelled(reason: unknown = new DOMException('user', 'AbortError')): void {
    if (this.cancelledFlag) return
    this.cancelledFlag = true
    if (!this.cancellationController.signal.aborted) {
      this.cancellationController.abort(reason)
    }
    this.abortResolve()
  }

  private checkCancellation(): boolean {
    return this.cancelledFlag
  }

  async run(triggerBlockId?: string): Promise<ExecutionResult> {
    const startTime = performance.now()
    try {
      this.initializeQueue(triggerBlockId)
      await this.subscribeToCancellationSignal()

      while (this.hasWork()) {
        if (this.checkCancellation() || this.errorFlag || this.stoppedEarlyFlag) {
          break
        }
        await this.processQueue()
      }

      if (!this.cancelledFlag && !this.skippedFlag) {
        await this.waitForAllExecutions()
      }

      if (this.errorFlag && this.executionError && !this.responseOutputLocked) {
        throw this.executionError
      }

      if (this.pausedBlocks.size > 0) {
        return this.buildPausedResult(startTime)
      }

      const endTime = performance.now()
      this.context.metadata.endTime = new Date().toISOString()
      this.context.metadata.duration = endTime - startTime

      logger.info('Engine: run() completed', {
        success: !this.cancelledFlag && !this.skippedFlag,
        durationMs: endTime - startTime,
        workflowId: this.context.workflowId,
      })

      if (this.cancelledFlag) {
        this.finalizeIncompleteLogs()
        return {
          success: false,
          output: this.finalOutput,
          logs: this.context.blockLogs,
          executionState: this.getSerializableExecutionState(),
          metadata: this.context.metadata,
          status: 'cancelled',
        }
      }

      return {
        success: true,
        output: this.finalOutput,
        logs: this.context.blockLogs,
        executionState: this.getSerializableExecutionState(),
        metadata: this.context.metadata,
      }
    } catch (error) {
      const endTime = performance.now()
      this.context.metadata.endTime = new Date().toISOString()
      this.context.metadata.duration = endTime - startTime

      if (this.cancelledFlag) {
        this.finalizeIncompleteLogs()
        return {
          success: false,
          output: this.finalOutput,
          logs: this.context.blockLogs,
          executionState: this.getSerializableExecutionState(),
          metadata: this.context.metadata,
          status: 'cancelled',
        }
      }

      this.finalizeIncompleteLogs()

      const errorMessage = normalizeError(error)
      this.execLogger.error('Execution failed', { error: errorMessage })

      const executionResult: ExecutionResult = {
        success: false,
        output: this.finalOutput,
        error: errorMessage,
        logs: this.context.blockLogs,
        metadata: this.context.metadata,
      }

      if (error instanceof Error) {
        attachExecutionResult(error, executionResult)
      }
      throw error
    } finally {
      this.cleanup()
    }
  }

  private cleanup(): void {
    if (this.abortSignalListener && this.context.abortSignal) {
      this.context.abortSignal.removeEventListener('abort', this.abortSignalListener)
      this.abortSignalListener = null
    }
    if (this.cancellationUnsubscribe) {
      this.cancellationUnsubscribe()
      this.cancellationUnsubscribe = null
    }
  }

  private hasWork(): boolean {
    return this.readyQueue.length > 0 || this.executing.size > 0
  }

  private addToQueue(nodeId: string): void {
    const node = this.dag.nodes.get(nodeId)
    if (node?.metadata?.isResumeTrigger && !this.allowResumeTriggers) {
      return
    }

    if (!this.readyQueue.includes(nodeId)) {
      this.readyQueue.push(nodeId)
    }
  }

  private addMultipleToQueue(nodeIds: string[]): void {
    for (const nodeId of nodeIds) {
      this.addToQueue(nodeId)
    }
  }

  private dequeue(): string | undefined {
    return this.readyQueue.shift()
  }

  private trackExecution(promise: Promise<void>): void {
    const trackedPromise = promise
      .catch((error) => {
        if (!this.errorFlag) {
          this.errorFlag = true
          this.executionError = toError(error)
        }
      })
      .finally(() => {
        this.executing.delete(trackedPromise)
      })
    this.executing.add(trackedPromise)
  }

  private async waitForAnyExecution(): Promise<void> {
    if (this.executing.size > 0) {
      await Promise.race([...this.executing, this.abortPromise])
    }
  }

  private async waitForAllExecutions(): Promise<void> {
    await Promise.race([Promise.all(this.executing), this.abortPromise])
    if (this.executing.size > 0) {
      await Promise.allSettled(this.executing)
    }
  }

  private async withQueueLock<T>(fn: () => Promise<T> | T): Promise<T> {
    const prevLock = this.queueLock
    let resolveLock: () => void
    this.queueLock = new Promise((resolve) => {
      resolveLock = resolve
    })
    await prevLock
    try {
      return await fn()
    } finally {
      resolveLock!()
    }
  }

  private initializeQueue(triggerBlockId?: string): void {
    if (this.context.runFromBlockContext) {
      const { startBlockId } = this.context.runFromBlockContext
      this.execLogger.info('Initializing queue for run-from-block mode', {
        startBlockId,
        dirtySetSize: this.context.runFromBlockContext.dirtySet.size,
      })
      this.addToQueue(startBlockId)
      return
    }

    const pendingBlocks = this.context.metadata.pendingBlocks
    const remainingEdges = (this.context.metadata as any).remainingEdges

    if (remainingEdges && Array.isArray(remainingEdges) && remainingEdges.length > 0) {
      this.execLogger.info('Removing edges from resumed pause blocks', {
        edgeCount: remainingEdges.length,
        // edges: remainingEdges,
      })

      for (const edge of remainingEdges) {
        const targetNode = this.dag.nodes.get(edge.target)
        if (targetNode) {
          const hadEdge = targetNode.incomingEdges.has(edge.source)
          targetNode.incomingEdges.delete(edge.source)
          if (hadEdge) {
            this.edgeManager.markNodeWithActivatedEdge(targetNode.id)
          }

          if (this.edgeManager.isNodeReady(targetNode)) {
            this.execLogger.info('Node became ready after edge removal', { nodeId: targetNode.id })
            this.addToQueue(targetNode.id)
          }
        }
      }

      this.execLogger.info('Edge removal complete, queued ready nodes', {
        queueLength: this.readyQueue.length,
        // queuedNodes: this.readyQueue,
      })

      return
    }

    if (pendingBlocks && pendingBlocks.length > 0) {
      this.execLogger.info('Initializing queue from pending blocks (resume mode)', {
        //pendingBlocks,
        allowResumeTriggers: this.allowResumeTriggers,
        dagNodeCount: this.dag.nodes.size,
      })

      for (const nodeId of pendingBlocks) {
        this.addToQueue(nodeId)
      }

      this.execLogger.info('Pending blocks queued', {
        queueLength: this.readyQueue.length,
        // queuedNodes: this.readyQueue,
      })

      this.context.metadata.pendingBlocks = []
      return
    }

    if (this.context.metadata.resumeFromSnapshot === true) {
      this.execLogger.info('Resume snapshot has no downstream work to queue')
      return
    }

    if (triggerBlockId) {
      this.addToQueue(triggerBlockId)
      return
    }

    const startNode = Array.from(this.dag.nodes.values()).find(
      (node) =>
        node.block.metadata?.id === BlockType.START_TRIGGER ||
        node.block.metadata?.id === BlockType.STARTER
    )
    if (startNode) {
      this.addToQueue(startNode.id)
    } else {
      this.execLogger.warn('No start node found in DAG')
    }
  }

  private async processQueue(): Promise<void> {
    while (this.readyQueue.length > 0) {
      if (this.checkCancellation() || this.errorFlag || this.skippedFlag) {
        break
      }
      const nodeId = this.dequeue()
      if (!nodeId) continue
      logger.info('Engine: dequeued node for execution', {
        nodeId,
        queueRemaining: this.readyQueue.length,
        workflowId: this.context.workflowId,
      })
      const promise = this.executeNodeAsync(nodeId)
      this.trackExecution(promise)
    }

    if (this.executing.size > 0 && !this.cancelledFlag && !this.errorFlag && !this.skippedFlag) {
      logger.info('Engine: waiting for in-flight executions', {
        executingCount: this.executing.size,
        workflowId: this.context.workflowId,
      })
      await this.waitForAnyExecution()
    }
  }

  private async executeNodeAsync(nodeId: string): Promise<void> {
    const node = this.dag.nodes.get(nodeId)
    const blockName = node?.block.metadata?.name ?? node?.block.metadata?.id ?? 'unknown'

    if (await this.checkCancellation()) {
      logger.info('Node execution cancelled before starting', { nodeId, blockName })
      return
    }

    if (this.skippedFlag) {
      logger.info('Node execution skipped - workflow was skipped', { nodeId, blockName })
      return
    }

    logger.info('Engine: starting block execution', {
      nodeId,
      blockName,
      blockType: node?.block.metadata?.id,
      workflowId: this.context.workflowId,
    })

    try {
      const wasAlreadyExecuted = this.context.executedBlocks.has(nodeId)
      const result = await this.nodeOrchestrator.executeNode(this.context, nodeId)

      logger.info('Engine: block execution completed', {
        nodeId,
        blockName,
        workflowId: this.context.workflowId,
      })

      if (!wasAlreadyExecuted) {
        await this.withQueueLock(async () => {
          // Check skip flag again after execution (intent analyzer might have set it)
          if (!this.skippedFlag) {
            await this.handleNodeCompletion(nodeId, result.output, result.isFinalOutput)
          }
        })
      }
    } catch (error) {
      const errorMessage = normalizeError(error)
      this.execLogger.error('Node execution failed', {
        nodeId,
        blockName,
        workflowId: this.context.workflowId,
        error: errorMessage,
      })
      throw error
    }
  }

  private async handleNodeCompletion(
    nodeId: string,
    output: NormalizedBlockOutput,
    isFinalOutput: boolean
  ): Promise<void> {
    const node = this.dag.nodes.get(nodeId)
    if (!node) {
      this.execLogger.error('Node not found during completion', { nodeId })
      return
    }

    const loopId = node.metadata.subflowType === 'loop' ? node.metadata.subflowId : undefined

    if (this.stoppedEarlyFlag && this.responseOutputLocked) {
      // Workflow already ended via Response block. Skip state persistence (setBlockOutput),
      // parallel/loop scope tracking, and edge propagation — no downstream blocks will run.
      return
    }

    // Check if this is a Start block and run intent analyzer if workflow has Agent blocks
    const isStartBlock =
      node.block.metadata?.id === BlockType.START_TRIGGER ||
      node.block.metadata?.id === BlockType.STARTER

    if (isStartBlock && !this.context.intentAnalyzerResult) {
      logger.info('Engine: Start block completed, running intent analyzer', {
        workflowId: this.context.workflowId,
        executionId: this.context.executionId,
      })
      await this.runWorkflowLevelIntentAnalyzer(output)

      logger.info('Engine: intent analyzer finished', {
        workflowId: this.context.workflowId,
        skipped: this.skippedFlag,
      })

      // Check if workflow was skipped after intent analyzer - return immediately to prevent any further execution
      if (this.skippedFlag) {
        logger.info('Workflow skipped by intent analyzer — stopping execution immediately', {
          nodeId,
          blockId: node.block.id,
        })
        return
      }
    }

    // Check if workflow was skipped (from intent analyzer or block output) - BEFORE handling node completion
    if (this.skippedFlag || output.skippedWorkflow === true) {
      logger.info('Workflow skipped — stopping further execution', {
        nodeId,
        blockId: node.block.id,
        skippedByIntentAnalyzer: this.skippedFlag,
        skippedByBlock: output.skippedWorkflow === true,
      })
      if (output.skippedWorkflow === true) {
        this.finalOutput = output
      }
      this.readyQueue = []
      this.skippedFlag = true
      // Don't call handleNodeCompletion - this prevents downstream nodes from being queued
      return
    }

    if (output._pauseMetadata) {
      await this.nodeOrchestrator.handleNodeCompletion(this.context, nodeId, output)

      const pauseMetadata = output._pauseMetadata
      this.pausedBlocks.set(pauseMetadata.contextId, pauseMetadata)
      this.context.metadata.status = 'paused'
      this.context.metadata.pausePoints = Array.from(this.pausedBlocks.keys())

      return
    }

    // Only handle node completion if workflow is not skipped
    // This prevents downstream nodes from being queued when workflow is skipped
    await this.nodeOrchestrator.handleNodeCompletion(this.context, nodeId, output)

    const isResponseBlock = node.block.metadata?.id === BlockType.RESPONSE
    const isInsideLoop = !!loopId

    // Response blocks outside loops end the workflow. Inside loops they only end
    // the current iteration — loop sentinel-end must run to continue or exit.
    if (isResponseBlock && !isInsideLoop) {
      if (!this.responseOutputLocked) {
        this.finalOutput = output
        this.responseOutputLocked = true
      }
      this.stoppedEarlyFlag = true
      return
    }

    if (isResponseBlock && isInsideLoop) {
      this.finalOutput = output
    }

    if (isFinalOutput && !this.responseOutputLocked) {
      this.finalOutput = output
    }

    // Check if this is a terminal block (Response blocks or blocks with no outgoing edges)
    // Terminal blocks outside loops should stop the workflow, but inside loops they should allow continuation
    const blockType = node.block.metadata?.id
    const isTerminalBlock = isResponseBlock || node.outgoingEdges.size === 0
    if (this.context.stopAfterBlockId === nodeId) {
      // For loop/parallel sentinels, only stop if the subflow has fully exited (all iterations done)
      // shouldContinue: true means more iterations, shouldExit: true means loop is done
      const shouldContinue =
        output.shouldContinue === true || output.selectedRoute === EDGE.PARALLEL_CONTINUE
      if (!shouldContinue) {
        this.execLogger.info('Stopping execution after target block', { nodeId })
        this.stoppedEarlyFlag = true
        return
      }
    }

    // When a loop sentinel start exits early (e.g., empty forEach collection),
    // the loop body is skipped but we must still trigger the sentinel end so its
    // LOOP_EXIT edge routes execution to the block after the loop.
    if (
      node.metadata.isSentinel &&
      node.metadata.sentinelType === 'start' &&
      loopId &&
      output?.shouldExit === true &&
      output?.selectedRoute === EDGE.LOOP_EXIT
    ) {
      const sentinelEndId = buildSentinelEndId(loopId)
      const sentinelEndNode = this.dag.nodes.get(sentinelEndId)

      if (sentinelEndNode) {
        logger.info('Loop sentinel start exiting early, triggering sentinel end directly', {
          loopId,
          sentinelStartId: nodeId,
          sentinelEndId,
        })

        // Build the sentinel end output that will activate its LOOP_EXIT edge
        const sentinelEndOutput: NormalizedBlockOutput = {
          results: [],
          shouldContinue: false,
          shouldExit: true,
          selectedRoute: EDGE.LOOP_EXIT,
          totalIterations: 0,
        }

        // Set the sentinel end's output and mark it as executed
        await this.nodeOrchestrator.handleNodeCompletion(
          this.context,
          sentinelEndId,
          sentinelEndOutput
        )

        // Clear all incoming edges on sentinel end so it becomes ready
        sentinelEndNode.incomingEdges.clear()

        // Process sentinel end's outgoing edges to find blocks after the loop
        const exitReadyNodes = this.edgeManager.processOutgoingEdges(
          sentinelEndNode,
          sentinelEndOutput,
          false
        )

        logger.info('Loop early exit: routing to blocks after loop', {
          loopId,
          readyNodes: exitReadyNodes,
        })

        this.addMultipleToQueue(exitReadyNodes)
        return
      }
    }

    // For Response blocks inside loops, process outgoing edges normally
    // Response blocks should have edges to sentinel end (they're terminal nodes)
    const readyNodes = this.edgeManager.processOutgoingEdges(node, output, false)

    // If this is a terminal block inside a loop, ensure the loop's sentinel end gets triggered
    // Terminal blocks (Response blocks or blocks with no outgoing edges) indicate iteration completion
    // When they complete, the iteration is done and loop should continue
    if (isTerminalBlock && isInsideLoop) {
      if (loopId) {
        const sentinelEndId = buildSentinelEndId(loopId)
        const sentinelEndNode = this.dag.nodes.get(sentinelEndId)

        if (sentinelEndNode) {
          // Remove the incoming edge from the Response block to sentinel end (if it exists)
          // This simulates the edge being processed by the edge manager
          if (sentinelEndNode.incomingEdges.has(nodeId)) {
            sentinelEndNode.incomingEdges.delete(nodeId)
          }

          // For Response blocks, we need to force-trigger the sentinel end
          // Response blocks are terminal - when they complete, the iteration is done
          // Even if the sentinel end has other incoming edges (from deactivated paths),
          // we should trigger it because the Response block path has completed
          const sentinelEndInReadyNodes = readyNodes.includes(sentinelEndId)

          if (!sentinelEndInReadyNodes) {
            // Terminal blocks indicate iteration completion - their completion means the iteration is done
            // Force trigger the sentinel end to allow the loop to continue to the next iteration
            logger.info(
              'Terminal block completed in loop - forcing sentinel end trigger (iteration complete)',
              {
                loopId,
                terminalNodeId: nodeId,
                blockType: blockType || 'unknown',
                sentinelEndId,
                hadEdgeToSentinelEnd: node.outgoingEdges.size > 0,
                incomingEdgesCount: sentinelEndNode.incomingEdges.size,
                // incomingEdges: Array.from(sentinelEndNode.incomingEdges),
              }
            )
            // Force trigger the sentinel end - terminal block completion means iteration is done
            this.addToQueue(sentinelEndId)
          }
        }
      }
    }

    this.addMultipleToQueue(readyNodes)
  }

  private buildPausedResult(startTime: number): ExecutionResult {
    const endTime = performance.now()
    this.context.metadata.endTime = new Date().toISOString()
    this.context.metadata.duration = endTime - startTime
    this.context.metadata.status = 'paused'

    const snapshotSeed = serializePauseSnapshot(this.context, [], this.dag, this.edgeManager)
    const pausePoints: PausePoint[] = Array.from(this.pausedBlocks.values()).map((pause) => ({
      contextId: pause.contextId,
      blockId: pause.blockId,
      response: pause.response,
      registeredAt: pause.timestamp,
      resumeStatus: 'paused' as ResumeStatus,
      snapshotReady: true,
      parallelScope: pause.parallelScope,
      loopScope: pause.loopScope,
      resumeLinks: pause.resumeLinks,
      pauseKind: pause.pauseKind,
      resumeAt: pause.resumeAt,
    }))

    return {
      success: true,
      output: this.collectPauseResponses(),
      logs: this.context.blockLogs,
      executionState: this.getSerializableExecutionState(snapshotSeed),
      metadata: this.context.metadata,
      status: 'paused',
      pausePoints,
      snapshotSeed,
    }
  }

  /**
   * Runs intent analyzer once at workflow start if workflow has Agent blocks.
   * Stores result in context for Agent blocks to use.
   * If decision is SKIP, stops workflow execution.
   */
  private async runWorkflowLevelIntentAnalyzer(
    startBlockOutput: NormalizedBlockOutput
  ): Promise<void> {
    try {
      // Check if workflow has Agent blocks
      const workflowBlocks = this.context.workflow?.blocks || []
      const hasAgentBlocks = workflowBlocks.some((block) => block.metadata?.id === BlockType.AGENT)

      if (!hasAgentBlocks) {
        logger.debug('Workflow has no Agent blocks, skipping intent analyzer')
        return
      }

      // Only run for chat trigger type
      const triggerType = this.context.metadata?.triggerType
      if (triggerType !== 'chat') {
        logger.debug('Intent analyzer only runs for chat trigger type', { triggerType })
        return
      }

      // Extract user prompt and conversationId from Start block output
      const userPrompt = typeof startBlockOutput.input === 'string' ? startBlockOutput.input : ''
      const conversationId =
        typeof startBlockOutput.conversationId === 'string'
          ? startBlockOutput.conversationId
          : undefined

      if (!userPrompt || !conversationId) {
        logger.debug('Missing userPrompt or conversationId, skipping intent analyzer', {
          hasUserPrompt: !!userPrompt,
          hasConversationId: !!conversationId,
        })
        return
      }

      logger.info('Running workflow-level intent analyzer', {
        workflowId: this.context.workflowId,
        conversationId,
        userPromptPreview: userPrompt.substring(0, 100),
      })

      // Get first Agent block to use for intent analyzer (we need inputs structure)
      const firstAgentBlock = workflowBlocks.find((block) => block.metadata?.id === BlockType.AGENT)
      if (!firstAgentBlock) {
        logger.warn('Agent block not found despite hasAgentBlocks check')
        return
      }

      // Build minimal AgentInputs for intent analyzer
      const agentInputs = {
        conversationId,
        memoryType: 'conversation' as const, // Default to conversation memory
        userPrompt,
      }

      // Run intent analyzer
      const { analyzeIntent } = await import('@/executor/utils/intent-analyzer')
      const intentResult = await analyzeIntent({
        ctx: this.context,
        inputs: agentInputs,
        blockId: firstAgentBlock.id,
        userPrompt,
        model: undefined, // Will use default
      })

      // Store result in context
      this.context.intentAnalyzerResult = intentResult

      logger.info('Intent analyzer completed', {
        workflowId: this.context.workflowId,
        decision: intentResult.decision,
        searchResultsCount: intentResult.searchResults.length,
      })

      // If SKIP, stop workflow execution
      if (intentResult.decision === 'SKIP' && intentResult.skipResponse) {
        logger.info('Intent analyzer decided SKIP — stopping workflow execution', {
          workflowId: this.context.workflowId,
          conversationId,
        })

        // Build skip output matching agent handler format
        // Include user prompt and system prompt for UI rendering
        const skipOutput: NormalizedBlockOutput = {
          content: intentResult.skipResponse,
          model: 'gpt-4o',
          tokens: { input: 0, output: 0, total: 0 },
          toolCalls: { list: [], count: 0 },
          skippedWorkflow: true,
          // Store prompts for UI rendering
          userPrompt: userPrompt,
          systemPrompt: intentResult.skipSystemPrompt || undefined,
          // Store the formatted user message that was sent to LLM
          _actualPromptsForSkip: {
            userMessage: intentResult.skipUserMessage || userPrompt,
            systemPrompt: intentResult.skipSystemPrompt || '',
          },
        }

        // Set skip flag and clear queue to prevent any further execution
        this.skippedFlag = true
        this.readyQueue = []
        this.finalOutput = skipOutput

        // Persist skip response to memory if memory is enabled
        if (agentInputs.memoryType) {
          try {
            const { memoryService } = await import('@/executor/handlers/agent/memory')
            await memoryService.appendToMemory(this.context, agentInputs, {
              role: 'assistant',
              content: intentResult.skipResponse,
            })
          } catch (memoryError) {
            logger.warn('Failed to persist skip response to memory', { error: memoryError })
          }
        }
      }
    } catch (error) {
      logger.warn(
        'Failed to run workflow-level intent analyzer, continuing with normal execution',
        {
          error: normalizeError(error),
        }
      )
      // Continue execution even if intent analyzer fails
    }
  }

  private getSerializableExecutionState(snapshotSeed?: {
    snapshot: string
  }): SerializableExecutionState | undefined {
    try {
      const serializedSnapshot =
        snapshotSeed?.snapshot ??
        serializePauseSnapshot(this.context, [], this.dag, this.edgeManager).snapshot
      const parsedSnapshot = JSON.parse(serializedSnapshot) as {
        state?: SerializableExecutionState
      }
      return parsedSnapshot.state
    } catch (error) {
      this.execLogger.warn('Failed to serialize execution state', {
        error: toError(error).message,
      })
      return undefined
    }
  }

  private collectPauseResponses(): NormalizedBlockOutput {
    const responses = Array.from(this.pausedBlocks.values()).map((pause) => pause.response)

    if (responses.length === 1) {
      return responses[0]
    }

    return {
      pausedBlocks: responses,
      pauseCount: responses.length,
    }
  }

  /**
   * Finalizes any block logs that were still running when execution was cancelled.
   * Sets their endedAt to now and calculates the actual elapsed duration.
   */
  private finalizeIncompleteLogs(): void {
    const now = new Date()
    const nowIso = now.toISOString()

    for (const log of this.context.blockLogs) {
      if (!log.endedAt) {
        log.endedAt = nowIso
        log.durationMs = now.getTime() - new Date(log.startedAt).getTime()
      }
    }
  }
}
