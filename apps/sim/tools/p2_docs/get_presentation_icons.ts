import { getPresentationIconLibrary } from '@/tools/google_slides/templates'
import type { IconLibrary } from '@/tools/google_slides/templates/schema'
import type { ToolConfig } from '@/tools/types'

interface GetPresentationIconsParams {
  category?: string
  color?: 'black' | 'white'
}

interface GetPresentationIconsResponse {
  success: boolean
  output: {
    version: string
    baseUrl: string
    icons: IconLibrary['icons']
    count: number
  }
}

export const getPresentationIconsTool: ToolConfig<
  GetPresentationIconsParams,
  GetPresentationIconsResponse
> = {
  id: 'p2_docs_get_presentation_icons',
  name: 'Get Icons Library',
  description:
    'Return the presentation icon catalog (ids, labels, categories, tags, and image URLs) for template slides',
  version: '1.0',

  params: {
    category: {
      type: 'string',
      required: false,
      visibility: 'user-or-llm',
      description: 'Optional category filter (e.g. marketing, technology, ai)',
    },
    color: {
      type: 'string',
      required: false,
      visibility: 'user-or-llm',
      description:
        'Icon color variant to return: "black" or "white". When a slide block specifies iconLibraryColor, pass that value here to receive only matching icons.',
    },
  },

  request: {
    url: '/api/tools/p2_docs/get_presentation_icons',
    method: 'GET',
    headers: () => ({}),
  },

  outputs: {
    version: { type: 'string', description: 'Icon library version' },
    baseUrl: { type: 'string', description: 'Base URL for icon assets' },
    icons: {
      type: 'json',
      description: 'Icon entries (id, label, category, color, tags, pngUrl, optional svgUrl)',
    },
    count: { type: 'number', description: 'Number of icons returned' },
  },
}

export async function executeGetPresentationIconsDirect(
  params: GetPresentationIconsParams
): Promise<GetPresentationIconsResponse> {
  const library = getPresentationIconLibrary()
  const categoryFilter = params.category?.trim().toLowerCase()
  const colorFilter = params.color?.trim().toLowerCase() as 'black' | 'white' | undefined

  let icons = library.icons
  if (categoryFilter) {
    icons = icons.filter((icon) => icon.category.toLowerCase() === categoryFilter)
  }
  if (colorFilter) {
    icons = icons.filter((icon) => icon.color === colorFilter)
  }

  return {
    success: true,
    output: {
      version: library.version,
      baseUrl: library.baseUrl,
      icons,
      count: icons.length,
    },
  }
}
