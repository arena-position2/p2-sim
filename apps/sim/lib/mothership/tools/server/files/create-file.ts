import { createLogger } from '@sim/logger'
import { asOrchestrationError } from '@/lib/core/orchestration/types'
import { executeCopilotFileUseCase } from '@/lib/mothership/application/execute-file-use-case'
import { messageForCopilotFileError } from '@/lib/mothership/auth/file-delegation'
import {
  assertServerToolNotAborted,
  type BaseServerTool,
  type ServerToolContext,
} from '@/lib/mothership/tools/server/base-tool'
import {
  getDocumentFormatInfo,
  inferContentType,
} from '@/lib/mothership/tools/server/files/workspace-file'
import {
  createWorkspaceFileSecretProvenanceFromRegistry,
  EXACT_EMPTY_WORKSPACE_FILE_SECRET_PROVENANCE,
  type WorkspaceFileSecretProvenance,
} from '@/lib/uploads/contexts/workspace/workspace-file-secret-provenance'
import {
  createWorkspaceFileBufferByPath,
  updateWorkspaceFileContentBufferByPath,
  type WriteWorkspaceFileByPathResult,
} from '@/lib/workspace-files/application/write-workspace-file-by-path'
import { SIM_PAGE_CONTENT_TYPE } from '@/lib/workspace-files/page-compile'

const logger = createLogger('CreateFileServerTool')
const CREATE_FILE_TOOL_ID = 'create_empty_file'
/** Extensions that should carry an inline string body (not an empty office shell). */
const INLINE_TEXT_FILE_EXTENSION = /\.(md|txt|json|csv|html)$/i

interface CreateFileArgs {
  fileName: string
  content?: string | Record<string, unknown> | unknown[]
  contentType?: string
  outputs?: { files?: Array<{ path: string; mode?: 'create' | 'overwrite'; mimeType?: string }> }
  args?: Record<string, unknown>
}

interface CreateFileResult {
  success: boolean
  message: string
  data?: {
    id: string
    name: string
    contentType: string
    vfsPath: string
    size: number
  }
}

function stringifyCreateFileContent(value: unknown): string | undefined {
  if (typeof value === 'string') return value
  if (value && typeof value === 'object') {
    try {
      return JSON.stringify(value, null, 2)
    } catch {
      return undefined
    }
  }
  return undefined
}

function resolveCreateFileContent(params: CreateFileArgs): string | undefined {
  const nested = params.args
  const fromTop = stringifyCreateFileContent(params.content)
  if (fromTop !== undefined) return fromTop
  return stringifyCreateFileContent(nested?.content)
}

export const createFileServerTool: BaseServerTool<CreateFileArgs, CreateFileResult> = {
  name: CREATE_FILE_TOOL_ID,
  async execute(params: CreateFileArgs, context?: ServerToolContext): Promise<CreateFileResult> {
    if (!context?.userId) {
      throw new Error('Authentication required')
    }
    const workspaceId = context.workspaceId
    if (!workspaceId) {
      return { success: false, message: 'Workspace ID is required' }
    }
    const nested = params.args
    const fileName = params.fileName || (nested?.fileName as string) || ''
    const explicitType = params.contentType || (nested?.contentType as string) || undefined
    const outputFile = params.outputs?.files?.[0]
    if (!outputFile?.path && !fileName) {
      return {
        success: false,
        message: 'create_empty_file requires outputs.files[0].path or fileName',
      }
    }
    const outputPath =
      outputFile?.path ?? (fileName.startsWith('files/') ? fileName : `files/${fileName}`)
    // .html defaults to plain text/html; a file is a Sim page only when the
    // model DECLARES it (the skill passes contentType text/x-sim-page at
    // creation) — or when the first apply_file_edit finds actual page
    // source, which re-stamps the record from reality either way.
    const contentType = outputFile?.mimeType ?? inferContentType(outputPath, explicitType)
    const content = resolveCreateFileContent(params)
    const leafName = outputPath.split('/').pop() ?? outputPath
    const docInfo = getDocumentFormatInfo(leafName)

    if (content !== undefined && docInfo.isDoc) {
      return {
        success: false,
        message:
          'create_file content is only supported for text files (.md, .txt, .json, .csv, .html). For DOCX/PPTX/PDF use create_file (empty shell) → workspace_file update → edit_content.',
      }
    }

    // A Sim page's stored name drops the .html the agent signals format with:
    // the record type carries the format, every surface then shows the bare
    // name with the plain file icon, and downloads re-append the extension.
    const storedPath =
      contentType === SIM_PAGE_CONTENT_TYPE ? outputPath.replace(/\.html?$/i, '') : outputPath
    assertServerToolNotAborted(context)
    const mode = outputFile?.mode ?? 'create'
    const fileContent = content ?? ''
    let secretProvenance: WorkspaceFileSecretProvenance =
      EXACT_EMPTY_WORKSPACE_FILE_SECRET_PROVENANCE
    if (fileContent.length > 0) {
      const contentProvenance = await createWorkspaceFileSecretProvenanceFromRegistry(
        context.resolvedSecretTraceRegistry,
        fileContent,
        { userId: context.userId, workspaceId }
      )
      secretProvenance = contentProvenance.safe
        ? contentProvenance.provenance
        : { status: 'unknown' }
    }

    const contentBuffer = Buffer.from(fileContent, 'utf-8')
    const createShell = () =>
      executeCopilotFileUseCase(context, createWorkspaceFileBufferByPath, {
        workspaceId,
        path: storedPath,
        mode: 'create',
        content: contentBuffer,
        contentType,
        exactName: true,
        secretProvenance,
      })

    // Text/json creates with no body are almost always a model mistake (object
    // `content` dropped, or content omitted). Fail instead of a silent empty shell.
    if (
      INLINE_TEXT_FILE_EXTENSION.test(outputPath) &&
      fileContent.length === 0 &&
      mode !== 'overwrite'
    ) {
      const hadContentKey =
        params.content !== undefined || (params.args !== undefined && 'content' in params.args)
      return {
        success: false,
        message: hadContentKey
          ? `create_file for "${outputPath}" received content that could not be written as text. Pass a string (or a JSON object for .json files) in \`content\`.`
          : `create_file for "${outputPath}" requires non-empty \`content\` for text/json/html/csv/markdown. Pass the full body in \`content\` — empty shells are only for DOCX/PPTX/PDF.`,
      }
    }
    try {
      let result: WriteWorkspaceFileByPathResult
      if (mode === 'overwrite') {
        try {
          result = await executeCopilotFileUseCase(
            context,
            updateWorkspaceFileContentBufferByPath,
            {
              workspaceId,
              path: storedPath,
              mode,
              content: contentBuffer,
              contentType,
              syncLiveDoc: false,
              secretProvenance,
            }
          )
        } catch (overwriteError) {
          // Upsert: overwrite of a missing path falls through to create.
          if (asOrchestrationError(overwriteError)?.code !== 'not_found') throw overwriteError
          result = await createShell()
        }
      } else {
        result = await createShell()
      }

      logger.info('File created via create_empty_file', {
        fileId: result.id,
        name: result.vfsPath,
        contentType,
        size: result.size,
        userId: context.userId,
      })

      const emptyShell = result.size === 0
      return {
        success: true,
        message: emptyShell
          ? `Empty file shell "${result.vfsPath}" created. Call workspace_file operation=update on this path, then edit_content with the full body — or call create_file again with content for text files.`
          : `File "${result.vfsPath}" created successfully (${result.size} bytes)`,
        data: {
          id: result.id,
          name: result.name,
          contentType,
          vfsPath: result.vfsPath,
          size: result.size,
        },
      }
    } catch (error) {
      return { success: false, message: messageForCopilotFileError(error, 'Failed to create file') }
    }
  },
}
