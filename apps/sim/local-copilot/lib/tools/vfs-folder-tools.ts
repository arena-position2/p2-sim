/**
 * Arena Local stubs for files-tree folder tools. Cloud has no mothership handlers
 * for these leaves, so without a Local intercept the model gets "Tool not found"
 * and thrashing. Folders are path prefixes — create_file with files/Apps/… is enough.
 */

import type { ToolExecutionContext, ToolExecutionResult } from '@/local-copilot/lib/tools/executor'

export const LOCAL_FILE_FOLDER_TOOL_NAMES = [
  'list_file_folders',
  'create_file_folder',
  'rename_file_folder',
  'move_file_folder',
  'delete_file_folder',
] as const

export type LocalFileFolderToolName = (typeof LOCAL_FILE_FOLDER_TOOL_NAMES)[number]

export function isLocalFileFolderToolName(toolName: string): toolName is LocalFileFolderToolName {
  return (LOCAL_FILE_FOLDER_TOOL_NAMES as readonly string[]).includes(toolName)
}

const CREATE_FILE_REDIRECT =
  'Folders are path prefixes under files/. Call create_file with fileName like files/Apps/Page.html (no separate folder step required).'

/**
 * Local folder-tool stubs — success for list/create so the model continues;
 * destructive rename/move/delete fail closed with a clear redirect.
 */
export async function executeLocalFileFolderTool(
  toolName: LocalFileFolderToolName,
  args: Record<string, unknown>,
  _ctx: ToolExecutionContext
): Promise<ToolExecutionResult> {
  switch (toolName) {
    case 'list_file_folders': {
      const message = `No separate folder listing is required in Arena Local Copilot. ${CREATE_FILE_REDIRECT}`
      return {
        toolName,
        success: true,
        result: {
          success: true,
          folders: [],
          message,
          followUpHint: CREATE_FILE_REDIRECT,
        },
      }
    }
    case 'create_file_folder': {
      const pathHint =
        typeof args.path === 'string' && args.path.trim()
          ? ` Use create_file with fileName under ${args.path.trim().replace(/\/$/, '')}/….`
          : typeof args.name === 'string' && args.name.trim()
            ? ` Use create_file with fileName like files/${args.name.trim()}/….`
            : ''
      const message =
        'Folder create is a no-op in Arena Local Copilot — the folder appears when you create_file under that path.' +
        pathHint
      return {
        toolName,
        success: true,
        result: {
          success: true,
          message,
          followUpHint: CREATE_FILE_REDIRECT,
        },
      }
    }
    case 'rename_file_folder':
    case 'move_file_folder':
    case 'delete_file_folder': {
      const message =
        `${toolName} is not available as a Local Copilot tool yet. ` +
        'Rename/move/delete individual files with rename_file / move_file / delete_file, ' +
        'or manage folders in the Files UI. ' +
        CREATE_FILE_REDIRECT
      return {
        toolName,
        success: false,
        error: message,
        result: { success: false, message, followUpHint: CREATE_FILE_REDIRECT },
      }
    }
  }
}
