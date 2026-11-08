import { createLogger } from '@sim/logger'
import { CONTROL_BACK_EDGE_HANDLES, EDGE, SUBFLOW_CONTROL_EDGE_HANDLES } from '@/executor/constants'
import type { DAG, DAGNode } from '@/executor/dag/builder'
import type { DAGEdge } from '@/executor/dag/types'
import type { NormalizedBlockOutput } from '@/executor/types'
import { buildSentinelEndId, extractLoopIdFromSentinel } from '@/executor/utils/subflow'

const logger = createLogger('EdgeManagerV2')

export class EdgeManagerV2 {
  private deactivatedEdges = new Set<string>()
  private nodesWithActivatedEdge = new Set<string>()

  constructor(private dag: DAG) {}

  processOutgoingEdges(
    node: DAGNode,
    output: NormalizedBlockOutput,
    skipBackwardsEdge = false
  ): string[] {
    const readyNodes: string[] = []
    const activatedTargets: string[] = []
    const edgesToDeactivate: Array<{ target: string; handle?: string }> = []

    for (const [, edge] of node.outgoingEdges) {
      if (skipBackwardsEdge && this.isBackwardsEdge(edge.sourceHandle)) {
        continue
      }

      if (!this.shouldActivateEdge(edge, output)) {
        if (!this.isSubflowControlEdge(edge.sourceHandle)) {
          edgesToDeactivate.push({ target: edge.target, handle: edge.sourceHandle })
        }
        continue
      }

      activatedTargets.push(edge.target)
    }

    // Track nodes that have received at least one activated edge
    for (const targetId of activatedTargets) {
      this.nodesWithActivatedEdge.add(targetId)
    }

    const cascadeTargets = new Set<string>()
    for (const { target, handle } of edgesToDeactivate) {
      this.deactivateEdgeAndDescendants(node.id, target, handle, cascadeTargets)
    }

    if (activatedTargets.length === 0) {
      for (const { target } of edgesToDeactivate) {
        if (this.isTerminalControlNode(target)) {
          cascadeTargets.add(target)
        }
      }
    }

    for (const targetId of activatedTargets) {
      const targetNode = this.dag.nodes.get(targetId)
      if (!targetNode) {
        logger.warn('Target node not found', { target: targetId })
        continue
      }
      targetNode.incomingEdges.delete(node.id)
    }

    for (const targetId of activatedTargets) {
      const canQueueTarget =
        this.isTargetReady(targetId) ||
        this.shouldForceQueueLoopSentinelEnd(node, targetId, activatedTargets)
      if (canQueueTarget && this.shouldAllowReadyTarget(node, targetId, output)) {
        readyNodes.push(targetId)
      }
    }

    const isDeadEnd = activatedTargets.length === 0
    const isRoutedDeadEnd = isDeadEnd && !!(output.selectedOption || output.selectedRoute)

    for (const targetId of cascadeTargets) {
      if (!readyNodes.includes(targetId) && !activatedTargets.includes(targetId)) {
        if (!isDeadEnd || !this.isTargetReady(targetId)) continue

        if (isRoutedDeadEnd) {
          // A condition/router deliberately selected a dead-end path.
          // Only queue the sentinel if it belongs to the SAME subflow as the
          // current node (the condition is inside the loop/parallel and the
          // loop still needs to continue/exit). Downstream subflow sentinels
          // should NOT fire.
          if (
            this.isEnclosingSentinel(node, targetId) &&
            this.shouldAllowReadyTarget(node, targetId, output)
          ) {
            readyNodes.push(targetId)
          }
        } else if (this.shouldAllowReadyTarget(node, targetId, output)) {
          readyNodes.push(targetId)
        }
      }
    }

    if (output.selectedRoute !== EDGE.LOOP_EXIT && output.selectedRoute !== EDGE.PARALLEL_EXIT) {
      for (const { target } of edgesToDeactivate) {
        if (
          !readyNodes.includes(target) &&
          !activatedTargets.includes(target) &&
          this.nodesWithActivatedEdge.has(target) &&
          this.isTargetReady(target)
        ) {
          // A nested loop body completing must not shortcut-queue an ancestor loop's
          // sentinel-end. Parent loops only advance via explicit loop_exit edges.
          if (!this.shouldAllowReadyTarget(node, target, output)) {
            continue
          }
          readyNodes.push(target)
        }
      }
    }

    return readyNodes
  }

  isNodeReady(node: DAGNode): boolean {
    return node.incomingEdges.size === 0 || this.countActiveIncomingEdges(node) === 0
  }

  restoreIncomingEdge(targetNodeId: string, sourceNodeId: string): void {
    const targetNode = this.dag.nodes.get(targetNodeId)
    if (!targetNode) {
      logger.warn('Cannot restore edge - target node not found', { targetNodeId })
      return
    }

    targetNode.incomingEdges.add(sourceNodeId)
  }

  clearDeactivatedEdges(): void {
    this.deactivatedEdges.clear()
    this.nodesWithActivatedEdge.clear()
  }

  getDeactivatedEdges(): string[] {
    return Array.from(this.deactivatedEdges)
  }

  getNodesWithActivatedEdge(): string[] {
    return Array.from(this.nodesWithActivatedEdge)
  }

  restoreDeactivatedEdges(edgeKeys?: string[], activatedNodeIds?: string[]): void {
    this.deactivatedEdges = new Set(
      (edgeKeys ?? []).map((edgeKey) => this.normalizeSerializedEdgeKey(edgeKey))
    )
    this.nodesWithActivatedEdge = new Set(activatedNodeIds ?? [])
  }

  markNodeWithActivatedEdge(nodeId: string): void {
    this.nodesWithActivatedEdge.add(nodeId)
  }

  clearNodesWithActivatedEdge(nodeIds: Set<string>): void {
    for (const nodeId of nodeIds) {
      this.nodesWithActivatedEdge.delete(nodeId)
    }
  }

  /**
   * Clear deactivated edges for a set of nodes (used when restoring loop state for next iteration).
   *
   * Only clears edges whose SOURCE is in the provided set. Edges pointing INTO a node in the set
   * whose source lives outside (e.g. an external branch whose path was cascade-deactivated) must
   * remain deactivated — otherwise `countActiveIncomingEdges` would count a source that will never
   * fire again, stalling the loop on its next iteration.
   *
   * Deactivated edge keys encode the source separately so node IDs with shared prefixes
   * cannot clear each other's deactivated edges.
   */
  clearDeactivatedEdgesForNodes(nodeIds: Set<string>): void {
    const edgesToRemove: string[] = []
    for (const edgeKey of this.deactivatedEdges) {
      const sourceId = this.parseEdgeKey(edgeKey)?.sourceId
      if (!sourceId) continue

      for (const nodeId of nodeIds) {
        if (sourceId === nodeId) {
          edgesToRemove.push(edgeKey)
          break
        }
      }
    }
    for (const edgeKey of edgesToRemove) {
      this.deactivatedEdges.delete(edgeKey)
    }
    for (const nodeId of nodeIds) {
      this.nodesWithActivatedEdge.delete(nodeId)
    }
  }

  /**
   * Clears deactivated edges where both source and target are inside the provided node set.
   * Used on loop iteration reset to clear stale internal edges without re-activating external
   * cascade-deactivated edges that point into the loop from outside.
   */
  clearInternalDeactivatedEdges(nodeIds: Set<string>): void {
    const edgesToRemove: string[] = []
    for (const edgeKey of this.deactivatedEdges) {
      const parsed = this.parseEdgeKey(edgeKey)
      if (!parsed) continue
      if (nodeIds.has(parsed.sourceId) && nodeIds.has(parsed.targetId)) {
        edgesToRemove.push(edgeKey)
      }
    }
    for (const edgeKey of edgesToRemove) {
      this.deactivatedEdges.delete(edgeKey)
    }
  }

  private isTargetReady(targetId: string): boolean {
    const targetNode = this.dag.nodes.get(targetId)
    return targetNode ? this.isNodeReady(targetNode) : false
  }

  private isEnclosingSentinel(sourceNode: DAGNode, sentinelId: string): boolean {
    const sentinel = this.dag.nodes.get(sentinelId)
    if (!sentinel?.metadata.isSentinel) return false

    const sourceSubflowType = sourceNode.metadata.subflowType
    const sentinelSubflowType = sentinel.metadata.subflowType
    const sourceSubflowId = sourceNode.metadata.subflowId
    const sentinelSubflowId = sentinel.metadata.subflowId

    if (
      sourceSubflowType &&
      sentinelSubflowType &&
      sourceSubflowType === sentinelSubflowType &&
      sourceSubflowId &&
      sentinelSubflowId &&
      sourceSubflowId === sentinelSubflowId
    ) {
      return true
    }

    return false
  }

  /**
   * True when `targetId` is the sentinel-end of a loop that encloses `sourceNode`'s loop.
   * Used to block the nodesWithActivatedEdge shortcut from advancing a parent loop
   * while a nested loop body is still executing.
   */
  private isAncestorLoopSentinelEnd(sourceNode: DAGNode, targetId: string): boolean {
    const target = this.dag.nodes.get(targetId)
    if (!target?.metadata.isSentinel || target.metadata.sentinelType !== 'end') {
      return false
    }
    if (target.metadata.subflowType !== 'loop' || !target.metadata.subflowId) {
      return false
    }

    const sourceLoopId = sourceNode.metadata.subflowId
    if (!sourceLoopId) {
      return false
    }

    const ancestorLoopId = target.metadata.subflowId
    if (sourceLoopId === ancestorLoopId) {
      return false
    }

    return this.isLoopNestedInside(sourceLoopId, ancestorLoopId)
  }

  private isLoopNestedInside(innerLoopId: string, ancestorLoopId: string): boolean {
    const ancestorConfig = this.dag.loopConfigs.get(ancestorLoopId)
    if (!ancestorConfig) {
      return false
    }

    if (ancestorConfig.nodes.includes(innerLoopId)) {
      return true
    }

    for (const nodeId of ancestorConfig.nodes) {
      if (this.dag.loopConfigs.has(nodeId) && this.isLoopNestedInside(innerLoopId, nodeId)) {
        return true
      }
    }

    return false
  }

  /**
   * Parent loop sentinel-ends may only become ready when a nested child loop
   * sentinel-end explicitly emits loop_exit — never from body nodes or while
   * the child's loop_exit edge is merely deactivated from loop_continue.
   */
  private shouldAllowReadyTarget(
    sourceNode: DAGNode,
    targetId: string,
    output: NormalizedBlockOutput
  ): boolean {
    if (!this.isAncestorLoopSentinelEnd(sourceNode, targetId)) {
      return true
    }

    if (
      sourceNode.metadata.isSentinel &&
      sourceNode.metadata.sentinelType === 'end' &&
      output.selectedRoute === EDGE.LOOP_EXIT &&
      sourceNode.id === this.getNestedChildSentinelEndForParent(targetId)
    ) {
      return true
    }

    return false
  }

  private getNestedChildSentinelEndForParent(parentSentinelEndId: string): string | null {
    const parentLoopId = this.dag.nodes.get(parentSentinelEndId)?.metadata.subflowId
    if (!parentLoopId) {
      return null
    }

    for (const nestedLoopId of this.dag.loopConfigs.keys()) {
      if (this.isLoopNestedInside(nestedLoopId, parentLoopId)) {
        return buildSentinelEndId(nestedLoopId)
      }
    }

    return null
  }

  /**
   * When a loop-body node finishes an iteration path (only forwards to its own
   * sentinel-end), queue the sentinel even if a nested child's deactivated
   * loop_exit edge still blocks readiness. This covers error-handler paths that
   * skip a nested loop for the current outer iteration.
   */
  private shouldForceQueueLoopSentinelEnd(
    sourceNode: DAGNode,
    targetId: string,
    activatedTargets: string[]
  ): boolean {
    const loopId = sourceNode.metadata.subflowId
    if (!loopId || sourceNode.metadata.subflowType !== 'loop') {
      return false
    }

    const sentinelEndId = buildSentinelEndId(loopId)
    if (targetId !== sentinelEndId || !activatedTargets.includes(sentinelEndId)) {
      return false
    }

    for (const [, edge] of sourceNode.outgoingEdges) {
      if (this.isSubflowControlEdge(edge.sourceHandle)) {
        continue
      }
      if (edge.target !== sentinelEndId) {
        return false
      }
    }

    return true
  }

  private isNestedChildLoopExitEdge(
    sourceId: string,
    targetId: string,
    sourceHandle?: string
  ): boolean {
    if (sourceHandle !== EDGE.LOOP_EXIT) {
      return false
    }

    const childLoopId = extractLoopIdFromSentinel(sourceId)
    if (!childLoopId || sourceId !== buildSentinelEndId(childLoopId)) {
      return false
    }

    const targetNode = this.dag.nodes.get(targetId)
    if (
      !targetNode?.metadata.isSentinel ||
      targetNode.metadata.sentinelType !== 'end' ||
      targetNode.metadata.subflowType !== 'loop' ||
      !targetNode.metadata.subflowId
    ) {
      return false
    }

    return this.isLoopNestedInside(childLoopId, targetNode.metadata.subflowId)
  }

  private isSubflowControlEdge(handle?: string): boolean {
    return handle !== undefined && SUBFLOW_CONTROL_EDGE_HANDLES.has(handle)
  }

  private isBackwardsEdge(sourceHandle?: string): boolean {
    return sourceHandle !== undefined && CONTROL_BACK_EDGE_HANDLES.has(sourceHandle)
  }

  private isTerminalControlNode(nodeId: string): boolean {
    const node = this.dag.nodes.get(nodeId)
    if (!node || node.outgoingEdges.size === 0) return false

    for (const [, edge] of node.outgoingEdges) {
      if (!this.isSubflowControlEdge(edge.sourceHandle)) {
        return false
      }
    }
    return true
  }

  private shouldActivateEdge(edge: DAGEdge, output: NormalizedBlockOutput): boolean {
    const handle = edge.sourceHandle

    if (output.selectedRoute === EDGE.LOOP_EXIT) {
      return handle === EDGE.LOOP_EXIT
    }

    if (output.selectedRoute === EDGE.LOOP_CONTINUE) {
      return handle === EDGE.LOOP_CONTINUE || handle === EDGE.LOOP_CONTINUE_ALT
    }

    if (output.selectedRoute === EDGE.PARALLEL_EXIT) {
      return handle === EDGE.PARALLEL_EXIT
    }

    if (output.selectedRoute === EDGE.PARALLEL_CONTINUE) {
      return handle === EDGE.PARALLEL_CONTINUE
    }

    if (this.isSubflowControlEdge(handle)) {
      return false
    }

    if (!handle) {
      return true
    }

    if (handle.startsWith(EDGE.CONDITION_PREFIX)) {
      const conditionValue = handle.substring(EDGE.CONDITION_PREFIX.length)
      return output.selectedOption === conditionValue
    }

    if (handle.startsWith(EDGE.ROUTER_PREFIX)) {
      const routeId = handle.substring(EDGE.ROUTER_PREFIX.length)
      return output.selectedRoute === routeId
    }

    switch (handle) {
      case EDGE.ERROR:
        return !!output.error

      case EDGE.SOURCE:
        return !output.error

      default:
        return true
    }
  }

  private deactivateEdgeAndDescendants(
    sourceId: string,
    targetId: string,
    sourceHandle?: string,
    cascadeTargets?: Set<string>,
    isCascade = false
  ): void {
    const edgeKey = this.createEdgeKey(sourceId, targetId, sourceHandle)
    if (this.deactivatedEdges.has(edgeKey)) {
      return
    }

    this.deactivatedEdges.add(edgeKey)

    const targetNode = this.dag.nodes.get(targetId)
    if (!targetNode) return

    if (isCascade && this.isTerminalControlNode(targetId)) {
      cascadeTargets?.add(targetId)
    }

    // Don't cascade if node has active incoming edges OR has received an activated edge
    if (
      this.hasActiveIncomingEdges(targetNode, edgeKey) ||
      this.nodesWithActivatedEdge.has(targetId)
    ) {
      return
    }

    for (const [, outgoingEdge] of targetNode.outgoingEdges) {
      if (!this.isBackwardsEdge(outgoingEdge.sourceHandle)) {
        this.deactivateEdgeAndDescendants(
          targetId,
          outgoingEdge.target,
          outgoingEdge.sourceHandle,
          cascadeTargets,
          true
        )
      }
    }
  }

  /**
   * Checks if a node has any active incoming edges besides the one being excluded.
   */
  private hasActiveIncomingEdges(node: DAGNode, excludeEdgeKey: string): boolean {
    for (const incomingSourceId of node.incomingEdges) {
      const incomingNode = this.dag.nodes.get(incomingSourceId)
      if (!incomingNode) continue

      for (const [, incomingEdge] of incomingNode.outgoingEdges) {
        if (incomingEdge.target === node.id) {
          const incomingEdgeKey = this.createEdgeKey(
            incomingSourceId,
            node.id,
            incomingEdge.sourceHandle
          )
          if (incomingEdgeKey === excludeEdgeKey) continue
          if (
            !this.deactivatedEdges.has(incomingEdgeKey) ||
            this.isNestedChildLoopExitEdge(incomingSourceId, node.id, incomingEdge.sourceHandle)
          ) {
            return true
          }
        }
      }
    }

    return false
  }

  private countActiveIncomingEdges(node: DAGNode): number {
    let count = 0

    for (const sourceId of node.incomingEdges) {
      const sourceNode = this.dag.nodes.get(sourceId)
      if (!sourceNode) continue

      for (const [, edge] of sourceNode.outgoingEdges) {
        if (edge.target === node.id) {
          const edgeKey = this.createEdgeKey(sourceId, edge.target, edge.sourceHandle)
          if (
            !this.deactivatedEdges.has(edgeKey) ||
            this.isNestedChildLoopExitEdge(sourceId, node.id, edge.sourceHandle)
          ) {
            count++
            break
          }
        }
      }
    }

    return count
  }

  private createEdgeKey(sourceId: string, targetId: string, sourceHandle?: string): string {
    return JSON.stringify([sourceId, targetId, sourceHandle ?? EDGE.DEFAULT])
  }

  private parseEdgeKey(
    edgeKey: string
  ): { sourceId: string; targetId: string; handle: string } | null {
    let parsed: unknown
    try {
      parsed = JSON.parse(edgeKey)
    } catch {
      return null
    }
    if (
      Array.isArray(parsed) &&
      parsed.length === 3 &&
      typeof parsed[0] === 'string' &&
      typeof parsed[1] === 'string' &&
      typeof parsed[2] === 'string'
    ) {
      return { sourceId: parsed[0], targetId: parsed[1], handle: parsed[2] }
    }
    return null
  }

  private normalizeSerializedEdgeKey(edgeKey: string): string {
    if (this.parseEdgeKey(edgeKey)) {
      return edgeKey
    }

    for (const [sourceId, sourceNode] of this.dag.nodes) {
      for (const [, edge] of sourceNode.outgoingEdges) {
        const legacyKey = `${sourceId}-${edge.target}-${edge.sourceHandle ?? EDGE.DEFAULT}`
        if (legacyKey === edgeKey) {
          return this.createEdgeKey(sourceId, edge.target, edge.sourceHandle)
        }
      }
    }

    return edgeKey
  }
}
