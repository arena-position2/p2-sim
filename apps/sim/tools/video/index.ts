import { falaiVideoTool } from '@/tools/video/falai'
import { higgsfieldVideoTool } from '@/tools/video/higgsfield'
import { lumaVideoTool } from '@/tools/video/luma'
import { minimaxVideoTool } from '@/tools/video/minimax'
import { runwayVideoTool } from '@/tools/video/runway'
import { veoVideoTool } from '@/tools/video/veo'

/**
 * Upstream video providers Arena does not offer. Importing them keeps the modules
 * in the tree for the next sync; the registry only registers Fal.ai.
 */
const hiddenVideoTools = [
  runwayVideoTool,
  veoVideoTool,
  lumaVideoTool,
  minimaxVideoTool,
  higgsfieldVideoTool,
]

if (hiddenVideoTools.some((tool) => tool.id === falaiVideoTool.id)) {
  throw new Error('Fal.ai cannot be a hidden video provider')
}

export { falaiVideoTool }
