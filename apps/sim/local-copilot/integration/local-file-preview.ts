import { isRecordLike } from '@sim/utils/object'
import { MothershipStreamV1EventType } from '@/lib/mothership/generated/mothership-stream-v1'
import {
  isToolCallStreamEvent,
  isToolResultStreamEvent,
  type SyntheticFilePreviewPayload,
} from '@/lib/mothership/request/session'
import type { OrchestratorOptions, StreamEvent } from '@/lib/mothership/request/types'
import {
  extractLocalFileChatResources,
  localFileBodyContent,
} from '@/local-copilot/integration/file-turn-persist'

const OFFICE_FILE_EXTENSION = /\.(pptx|docx|pdf)$/i
/** Wire preview payloads must use upstream's prepare_file_edit tool name. */
const FILE_PREVIEW_TOOL_NAME = 'prepare_file_edit' as const

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecordLike(value) ? value : undefined
}

function previewSessionToolCallId(event: StreamEvent, fallback: string): string {
  const parent = event.scope?.parentToolCallId
  return parent && parent.length > 0 ? parent : fallback
}

function withFileBodyOnContent(argumentsValue: unknown): unknown {
  const args = asRecord(argumentsValue)
  if (!args) return argumentsValue
  if (typeof args.content === 'string' && args.content.length > 0) return argumentsValue
  const body = localFileBodyContent(args)
  if (!body) return argumentsValue
  return { ...args, content: body }
}

/**
 * The shared preview adapter keys sessions by `workspace_file`'s own call id.
 * Arena File Agent span start uses the specialist id, so rewrite the preview
 * input (not the client tool frame) to that parent id. Also copy body aliases
 * onto `content` so the adapter's `args.content` path sees the write.
 */
export function adaptLocalFilePreviewStreamEvent(event: StreamEvent): StreamEvent {
  if (!isToolCallStreamEvent(event) && !isToolResultStreamEvent(event)) {
    return event
  }

  const toolName = event.payload.toolName

  if (isToolCallStreamEvent(event) && (toolName === 'edit_content' || toolName === 'create_file')) {
    const nextArguments = withFileBodyOnContent(event.payload.arguments)
    if (nextArguments !== event.payload.arguments) {
      return {
        ...event,
        payload: {
          ...event.payload,
          arguments: nextArguments as typeof event.payload.arguments,
        },
      }
    }
  }

  if (toolName === 'workspace_file') {
    const frameId = event.payload.toolCallId
    if (frameId) {
      const sessionId = previewSessionToolCallId(event, frameId)
      if (sessionId !== frameId) {
        return {
          ...event,
          payload: { ...event.payload, toolCallId: sessionId },
        } as StreamEvent
      }
    }
  }

  return event
}

function createFilePreviewMeta(argumentsValue: unknown):
  | {
      fileName: string
      content: string
    }
  | undefined {
  const args = asRecord(argumentsValue)
  if (!args) return undefined
  const content = localFileBodyContent(args)
  if (!content) return undefined

  let fileName: string | undefined
  if (typeof args.fileName === 'string' && args.fileName.trim()) {
    fileName = args.fileName.trim().split('/').pop()
  } else {
    const outputs = asRecord(args.outputs)
    const files = outputs?.files
    if (Array.isArray(files) && files[0] && typeof files[0] === 'object') {
      const path = (files[0] as { path?: unknown }).path
      if (typeof path === 'string' && path.trim()) {
        fileName = path.trim().split('/').pop()
      }
    }
  }
  if (fileName && OFFICE_FILE_EXTENSION.test(fileName)) return undefined
  return { fileName: fileName || 'File', content }
}

async function emitPreview(
  streamEvent: StreamEvent,
  options: Pick<OrchestratorOptions, 'onEvent'>,
  payload: SyntheticFilePreviewPayload
): Promise<void> {
  await options.onEvent?.({
    type: MothershipStreamV1EventType.tool,
    payload,
    ...(streamEvent.scope ? { scope: streamEvent.scope } : {}),
  })
}

/**
 * One-step markdown `create_file` never hits `workspace_file`, so the shared
 * adapter does not open a live preview. Emit the same preview phases locally.
 */
export async function emitLocalCreateFilePreview(input: {
  streamEvent: StreamEvent
  options: Pick<OrchestratorOptions, 'onEvent'>
  sessions: Set<string>
}): Promise<void> {
  const { streamEvent, options, sessions } = input

  if (isToolCallStreamEvent(streamEvent) && streamEvent.payload.toolName === 'create_file') {
    const frameId = streamEvent.payload.toolCallId
    const meta = createFilePreviewMeta(streamEvent.payload.arguments)
    if (!frameId || !meta) return
    const toolCallId = previewSessionToolCallId(streamEvent, frameId)
    sessions.add(toolCallId)
    await emitPreview(streamEvent, options, {
      toolCallId,
      toolName: FILE_PREVIEW_TOOL_NAME,
      previewPhase: 'file_preview_start',
    })
    await emitPreview(streamEvent, options, {
      toolCallId,
      toolName: FILE_PREVIEW_TOOL_NAME,
      previewPhase: 'file_preview_target',
      operation: 'update',
      target: { kind: 'new_file', fileName: meta.fileName },
    })
    await emitPreview(streamEvent, options, {
      toolCallId,
      toolName: FILE_PREVIEW_TOOL_NAME,
      previewPhase: 'file_preview_content',
      content: meta.content,
      contentMode: 'snapshot',
      previewVersion: 1,
      fileName: meta.fileName,
      targetKind: 'new_file',
      operation: 'update',
    })
    return
  }

  if (isToolResultStreamEvent(streamEvent) && streamEvent.payload.toolName === 'create_file') {
    const frameId = streamEvent.payload.toolCallId
    if (!frameId) return
    const toolCallId = previewSessionToolCallId(streamEvent, frameId)
    if (!sessions.has(toolCallId)) return
    sessions.delete(toolCallId)
    const resources = extractLocalFileChatResources(
      'create_file',
      undefined,
      streamEvent.payload.output
    )
    const fileId = resources[0]?.id
    await emitPreview(streamEvent, options, {
      toolCallId,
      toolName: FILE_PREVIEW_TOOL_NAME,
      previewPhase: 'file_preview_complete',
      ...(fileId ? { fileId } : {}),
      output: streamEvent.payload.output,
      previewVersion: 1,
    })
  }
}
