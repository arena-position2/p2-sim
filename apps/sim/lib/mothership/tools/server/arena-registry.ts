import { ApplyFileEdit, PrepareFileEdit } from '@/lib/mothership/generated/tool-catalog-v1'
import { withFileTabFlag } from '@/lib/mothership/resources/file-tabs'
import {
  ARENA_DUAL_REGISTERED_SERVER_TOOL_NAMES,
  ARENA_TO_SERVER_REGISTRY_TOOL_NAME,
} from '@/lib/mothership/tools/arena-server-tool-aliases'
import type { BaseServerTool } from '@/lib/mothership/tools/server/base-tool'
import { createFileServerTool } from '@/lib/mothership/tools/server/files/create-file'
import { editContentServerTool } from '@/lib/mothership/tools/server/files/edit-content'
import { workspaceFileServerTool } from '@/lib/mothership/tools/server/files/workspace-file'
import { knowledgeBaseServerTool } from '@/lib/mothership/tools/server/knowledge/knowledge-base'
import { searchOnlineServerTool } from '@/lib/mothership/tools/server/other/search-online'

const arenaToolByLeafName = {
  create_file: createFileServerTool,
  workspace_file: withFileTabFlag(workspaceFileServerTool),
  edit_content: withFileTabFlag(editContentServerTool),
  knowledge_base: knowledgeBaseServerTool,
  search_online: searchOnlineServerTool,
} as const satisfies Record<
  (typeof ARENA_DUAL_REGISTERED_SERVER_TOOL_NAMES)[number],
  BaseServerTool
>

/** Cloud ids already present on upstream's router. The overlay must not replace them. */
const upstreamOwnedServerIds = new Set<string>([PrepareFileEdit.id, ApplyFileEdit.id])

function buildArenaServerToolRegistry(): Record<string, BaseServerTool> {
  const registry: Record<string, BaseServerTool> = {}
  for (const arenaName of ARENA_DUAL_REGISTERED_SERVER_TOOL_NAMES) {
    const tool = arenaToolByLeafName[arenaName]
    registry[arenaName] = tool
    const serverId = ARENA_TO_SERVER_REGISTRY_TOOL_NAME[arenaName]
    if (!upstreamOwnedServerIds.has(serverId)) {
      registry[serverId] = tool
    }
  }
  return registry
}

/** Arena leaf names, plus Cloud ids upstream's router does not register. */
export const arenaServerToolRegistry: Record<string, BaseServerTool> =
  buildArenaServerToolRegistry()
