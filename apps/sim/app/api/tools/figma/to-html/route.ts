import Anthropic from '@anthropic-ai/sdk'
import { createLogger } from '@sim/logger'
import { getErrorMessage } from '@sim/utils/errors'
import type { NextRequest } from 'next/server'
import { NextResponse } from 'next/server'
import { createAnthropicMessage } from '@/lib/anthropic/create-message'
import { type FigmaToHtmlBody, figmaToHtmlContract } from '@/lib/api/contracts/tools/figma'
import { getValidationErrorMessage, parseRequest } from '@/lib/api/server'
import { checkInternalAuth } from '@/lib/auth/hybrid'
import { getBaseUrl } from '@/lib/core/utils/urls'
import { withRouteHandler } from '@/lib/core/utils/with-route-handler'
import { uploadWorkspaceFile } from '@/lib/uploads/contexts/workspace'
import { getMaxOutputTokensForModel } from '@/providers/models'

const logger = createLogger('FigmaToHTMLAPI')

export const dynamic = 'force-dynamic'
export const maxDuration = 300

const FIGMA_AI_MODEL = 'claude-opus-4-8'
const FIGMA_AI_MAX_OUTPUT_TOKENS = getMaxOutputTokensForModel(FIGMA_AI_MODEL)

const VECTOR_NODE_TYPES = new Set([
  'VECTOR',
  'BOOLEAN_OPERATION',
  'STAR',
  'LINE',
  'REGULAR_POLYGON',
  'POLYGON',
])

const MAX_RENDERED_NODES = 50
const MAX_ASSET_BYTES = 10 * 1024 * 1024
const ASSET_UPLOAD_BATCH_SIZE = 5

const CONTENT_TYPE_EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
}

/** Image asset URLs resolved from the Figma API for use in the generated HTML. */
interface FigmaImageAssets {
  /** Map of imageRef (from IMAGE fills) to a downloadable image URL. */
  imageFills: Record<string, string>
  /** Map of vector/icon node ID to a rendered SVG image URL. */
  nodeRenders: Record<string, string>
}

/** Extracts the source node entry from a nodes response, or the whole-file response. */
function getFigmaSource(figmaData: any, nodeId?: string): any {
  if (nodeId && figmaData.nodes) {
    const nodeKey = nodeId.replace(/-/g, ':')
    return figmaData.nodes[nodeKey] ?? figmaData.nodes[nodeId]
  }
  return figmaData
}

/** Collects all imageRef hashes from IMAGE fills/strokes in the node tree. */
function collectImageRefs(node: any, refs: Set<string>): void {
  if (!node) return
  const paints = [...(node.fills ?? []), ...(node.strokes ?? []), ...(node.background ?? [])]
  for (const paint of paints) {
    if (paint?.type === 'IMAGE' && paint.imageRef) {
      refs.add(paint.imageRef)
    }
  }
  if (Array.isArray(node.children)) {
    for (const child of node.children) {
      collectImageRefs(child, refs)
    }
  }
}

/** Collects IDs of visible vector/icon nodes so they can be rendered as SVG assets. */
function collectVectorNodeIds(node: any, ids: Set<string>): void {
  if (!node || node.visible === false) return
  if (VECTOR_NODE_TYPES.has(node.type)) {
    ids.add(node.id)
    return
  }
  if (Array.isArray(node.children)) {
    for (const child of node.children) {
      collectVectorNodeIds(child, ids)
    }
  }
}

/**
 * Resolves real image URLs for the design's assets from the Figma API.
 * Image fills come from GET /v1/files/:key/images (imageRef to URL map);
 * vector/icon nodes are rendered via GET /v1/images/:key as SVG.
 */
async function fetchImageAssets(fileKey: string, document: any): Promise<FigmaImageAssets> {
  const headers = { 'X-Figma-Token': process.env.FIGMA_API_KEY || '' }
  const imageFills: Record<string, string> = {}
  const nodeRenders: Record<string, string> = {}

  const refs = new Set<string>()
  collectImageRefs(document, refs)

  const vectorIds = new Set<string>()
  collectVectorNodeIds(document, vectorIds)

  if (refs.size > 0) {
    try {
      const response = await fetch(`https://api.figma.com/v1/files/${fileKey}/images`, { headers })
      if (response.ok) {
        const data = await response.json()
        const allImages: Record<string, string> = data.meta?.images ?? {}
        for (const ref of refs) {
          if (allImages[ref]) {
            imageFills[ref] = allImages[ref]
          }
        }
      } else {
        logger.warn('Failed to fetch Figma image fills', { fileKey, status: response.status })
      }
    } catch (error) {
      logger.warn('Error fetching Figma image fills', {
        fileKey,
        error: getErrorMessage(error),
      })
    }
  }

  const idsToRender = Array.from(vectorIds).slice(0, MAX_RENDERED_NODES)
  if (idsToRender.length > 0) {
    try {
      const query = new URLSearchParams({ ids: idsToRender.join(','), format: 'svg' })
      const response = await fetch(`https://api.figma.com/v1/images/${fileKey}?${query}`, {
        headers,
      })
      if (response.ok) {
        const data = await response.json()
        const rendered: Record<string, string | null> = data.images ?? {}
        for (const [id, url] of Object.entries(rendered)) {
          if (url) {
            nodeRenders[id] = url
          }
        }
      } else {
        logger.warn('Failed to render Figma vector nodes', { fileKey, status: response.status })
      }
    } catch (error) {
      logger.warn('Error rendering Figma vector nodes', {
        fileKey,
        error: getErrorMessage(error),
      })
    }
  }

  return { imageFills, nodeRenders }
}

/** Builds a safe file name for a rehosted asset from its key and content type. */
function buildAssetFileName(prefix: string, key: string, contentType: string): string {
  const safeKey = key.replace(/[^a-zA-Z0-9]/g, '-')
  const extension = CONTENT_TYPE_EXTENSIONS[contentType] ?? 'png'
  return `figma-${prefix}-${safeKey}.${extension}`
}

/**
 * Builds an absolute serve URL for a workspace storage key, encoding each path
 * segment individually so the slashes stay readable (no %2F) in the HTML.
 */
function buildServeUrl(storageKey: string): string {
  const encodedPath = storageKey.split('/').map(encodeURIComponent).join('/')
  return `${getBaseUrl()}/api/files/serve/${encodedPath}?context=workspace`
}

/**
 * Downloads Figma's temporary S3 asset URLs and rehosts them as workspace
 * files (visible in the workspace Files page) so the generated HTML keeps
 * working after Figma's links expire (~14 days). Falls back to the original
 * URL if download or upload fails, or when no workspace context is available.
 */
async function rehostAssets(
  assets: FigmaImageAssets,
  workspaceId: string | undefined,
  userId: string | undefined
): Promise<FigmaImageAssets> {
  if (!workspaceId || !userId) {
    return assets
  }

  async function rehostUrl(url: string, fileName: (contentType: string) => string) {
    try {
      const response = await fetch(url)
      if (!response.ok) {
        logger.warn('Failed to download Figma asset', { url, status: response.status })
        return url
      }
      const contentType = response.headers.get('content-type')?.split(';')[0] ?? 'image/png'
      const buffer = Buffer.from(await response.arrayBuffer())
      if (buffer.length === 0 || buffer.length > MAX_ASSET_BYTES) {
        logger.warn('Skipping Figma asset with invalid size', { url, size: buffer.length })
        return url
      }
      const userFile = await uploadWorkspaceFile(
        workspaceId!,
        userId!,
        buffer,
        fileName(contentType),
        contentType
      )
      return buildServeUrl(userFile.key)
    } catch (error) {
      logger.warn('Failed to rehost Figma asset, keeping original URL', {
        url,
        error: getErrorMessage(error),
      })
      return url
    }
  }

  async function rehostMap(entries: Record<string, string>, prefix: string) {
    const rehosted: Record<string, string> = {}
    const pending = Object.entries(entries)
    for (let i = 0; i < pending.length; i += ASSET_UPLOAD_BATCH_SIZE) {
      const batch = pending.slice(i, i + ASSET_UPLOAD_BATCH_SIZE)
      await Promise.all(
        batch.map(async ([key, url]) => {
          rehosted[key] = await rehostUrl(url, (contentType) =>
            buildAssetFileName(prefix, key, contentType)
          )
        })
      )
    }
    return rehosted
  }

  const imageFills = await rehostMap(assets.imageFills, 'image')
  const nodeRenders = await rehostMap(assets.nodeRenders, 'node')

  return { imageFills, nodeRenders }
}

/** Optimizes Figma data for AI processing by stripping unnecessary fields. */
function optimizeFigmaData(figmaData: any, nodeId: string): any {
  const source = getFigmaSource(figmaData, nodeId)
  if (!source?.document) {
    throw new Error(
      `Figma node data not found${nodeId ? ` for node "${nodeId}"` : ''}. Check the file key and node ID.`
    )
  }
  const optimized = {
    document: source.document,
    components: source.components || {},
    styles: source.styles || {},
    name: figmaData.name,
    lastModified: source.lastModified,
    version: source.version,
    thumbnailUrl: figmaData.thumbnailUrl,
  }

  function cleanNode(node: any): any {
    if (!node) return null

    return {
      id: node.id,
      name: node.name,
      type: node.type,
      visible: node.visible,
      absoluteBoundingBox: node.absoluteBoundingBox,
      fills: node.fills,
      strokes: node.strokes,
      strokeWeight: node.strokeWeight,
      cornerRadius: node.cornerRadius,
      characters: node.characters,
      style: node.style,
      layoutMode: node.layoutMode,
      primaryAxisAlignItems: node.primaryAxisAlignItems,
      counterAxisAlignItems: node.counterAxisAlignItems,
      paddingLeft: node.paddingLeft,
      paddingRight: node.paddingRight,
      paddingTop: node.paddingTop,
      paddingBottom: node.paddingBottom,
      itemSpacing: node.itemSpacing,
      children: node.children ? node.children.map(cleanNode).filter(Boolean) : undefined,
    }
  }

  if (optimized.document) {
    optimized.document = cleanNode(optimized.document)
  }

  return optimized
}

/** Generates the AI prompt for HTML/CSS conversion. */
function generateAIPrompt(figmaData: any, body: FigmaToHtmlBody, assets: FigmaImageAssets): string {
  const optimizedData = optimizeFigmaData(figmaData, body.nodeId || '')
  const figmaJson = JSON.stringify(optimizedData, null, 2)

  const hasImageFills = Object.keys(assets.imageFills).length > 0
  const hasNodeRenders = Object.keys(assets.nodeRenders).length > 0
  const assetSections: string[] = []
  if (hasImageFills) {
    assetSections.push(`IMAGE FILL URLS (keyed by imageRef from IMAGE fills in the design data):
${JSON.stringify(assets.imageFills, null, 2)}`)
  }
  if (hasNodeRenders) {
    assetSections.push(`RENDERED SVG URLS (keyed by node id, for vector/icon nodes):
${JSON.stringify(assets.nodeRenders, null, 2)}`)
  }
  const assetInstructions = assetSections.length
    ? `\nIMAGE ASSETS:
${assetSections.join('\n\n')}

IMAGE USAGE RULES:
- When a node has a fill of type IMAGE, look up its "imageRef" in the IMAGE FILL URLS map and use that exact URL in an <img> tag or CSS background-image
- When a node id appears in the RENDERED SVG URLS map, render it as <img> with that exact URL instead of trying to recreate the vector shape
- Use the URLs EXACTLY as provided - do NOT modify, shorten, or invent URLs
- NEVER embed images as base64 data URIs (data:image/...) - always reference the provided URLs directly
- NEVER use placeholder URLs (placeholder.com, via.placeholder, example.com, etc.)
- If no URL is available for an image, use a CSS background color matching the design instead of a broken image reference\n`
    : `\nIMAGE HANDLING:
- No image asset URLs are available for this design
- NEVER invent or use placeholder image URLs - represent image areas with CSS background colors or gradients matching the design instead\n`

  return `You are an expert frontend developer specializing in converting Figma designs to clean, semantic, and accessible HTML/CSS code.

CRITICAL REQUIREMENTS:
1. Process ALL sections and components in the Figma design
2. Include every text element, button, input field, image, and layout component
3. Generate complete, functional HTML with embedded CSS
4. Use modern HTML5 semantic elements and CSS Grid/Flexbox
5. Implement responsive design with mobile-first approach
6. Include proper accessibility attributes (ARIA labels, roles, etc.)
7. Use CSS custom properties for design tokens
8. Generate clean, maintainable code with comments
9. USE THE PROVIDED IMAGES: Replace any image placeholders with the actual image URLs provided below

Figma Design Data:
${figmaJson}
${assetInstructions}
CRITICAL OUTPUT REQUIREMENTS:
- Generate ONLY ONE complete HTML5 document with DOCTYPE, html, head, and body tags
- ALL CSS styles MUST be embedded in <style> tags within the <head> section
- DO NOT generate separate HTML and CSS sections
- DO NOT use external CSS files or separate CSS blocks
- Return a single, complete HTML document with embedded styles

Technical Requirements:
- Use semantic HTML5 elements (header, nav, main, section, article, aside, footer, button, input, etc.)
- Include comprehensive accessibility attributes
- Implement responsive design with CSS Grid and Flexbox
- Use CSS custom properties for design tokens
- Include proper focus management and keyboard navigation
- Generate clean, maintainable code with comments
- Process EVERY element in the design hierarchy - do not skip any children or nested elements
- Use the exact colors provided in the Figma data
- Preserve all text content exactly as shown in the design
- Include all visual elements, shapes, and components from the design
- Maintain the exact layout structure and positioning from Figma
- For images, use proper <img> tags with alt attributes for accessibility
- Remove all newline characters (\n) from the output
- Use class names that correspond to the CSS selectors

${body.customPrompt ? `\nAdditional Requirements: ${body.customPrompt}` : ''}

RESPONSE FORMAT - Return ONLY this:
<!DOCTYPE html><html><head><style>/* ALL CSS STYLES HERE */</style></head><body><!-- ALL HTML CONTENT HERE --></body></html>`
}

/** Generates fallback HTML with embedded CSS when the AI service fails. */
function generateFallbackCombinedHTML(): string {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0"><title>Figma Design</title><style>* { margin: 0; padding: 0; box-sizing: border-box; } body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; line-height: 1.6; color: #333; } .container { max-width: 1200px; margin: 0 auto; padding: 20px; } .header { background: #f8f9fa; padding: 20px 0; margin-bottom: 40px; } .content { display: grid; gap: 20px; } .section { background: white; border: 1px solid #e9ecef; border-radius: 8px; padding: 20px; } .button { background: #007bff; color: white; border: none; padding: 12px 24px; border-radius: 4px; cursor: pointer; font-size: 16px; } .button:hover { background: #0056b3; } @media (max-width: 768px) { .container { padding: 10px; } }</style></head><body><div class="container"><header class="header"><h1>Figma Design</h1><p>This is a fallback HTML structure. Please check your AI service configuration.</p></header><main class="content"><section class="section"><h2>Content Section</h2><p>This is a placeholder for your Figma design content.</p><button class="button">Action Button</button></section></main></div></body></html>`
}

/** Calls Claude to convert the Figma design data into a single HTML document. */
async function callAIService(prompt: string): Promise<{
  combinedHtml: string
  model: string
  inputTokens: number
  outputTokens: number
}> {
  try {
    const apiKey = process.env.ANTHROPIC_API_KEY

    if (!apiKey) {
      throw new Error(
        'ANTHROPIC_API_KEY environment variable is not set. Please set it to your Claude API key.'
      )
    }

    const anthropic = new Anthropic({ apiKey })

    const message = await createAnthropicMessage(anthropic, {
      model: FIGMA_AI_MODEL,
      max_tokens: FIGMA_AI_MAX_OUTPUT_TOKENS,
      system:
        'You are an expert frontend developer specializing in converting Figma designs to clean, semantic, and accessible HTML/CSS code. Always respond with a single HTML document that includes embedded CSS in <style> tags within the <head> section. Do NOT generate separate HTML and CSS sections. Return only one complete HTML document with embedded styles. Remove all newline characters from the output.',
      messages: [
        {
          role: 'user',
          content: prompt,
        },
      ],
    })

    const textContent = message.content.find((block) => block.type === 'text')
    if (!textContent || textContent.type !== 'text') {
      throw new Error('No text content in Claude API response')
    }

    return {
      combinedHtml: textContent.text,
      model: FIGMA_AI_MODEL,
      inputTokens: message.usage?.input_tokens ?? 0,
      outputTokens: message.usage?.output_tokens ?? 0,
    }
  } catch (error) {
    logger.error('AI service error', { error: getErrorMessage(error) })

    return {
      combinedHtml: generateFallbackCombinedHTML(),
      model: 'fallback',
      inputTokens: 0,
      outputTokens: 0,
    }
  }
}

/** Strips code fences, newlines, backslashes, and extra whitespace from the AI output. */
function cleanGeneratedHtml(html: string): string {
  return html
    .replace(/```html\n?/g, '')
    .replace(/```\n?/g, '')
    .replace(/\r?\n|\r/g, '')
    .replace(/\\/g, '')
    .replace(/\s\s+/g, ' ')
    .trim()
}

export const POST = withRouteHandler(async (request: NextRequest) => {
  const startTime = Date.now()

  const authResult = await checkInternalAuth(request, { requireWorkflowId: false })
  if (!authResult.success) {
    logger.error('Authentication failed for Figma to HTML:', authResult.error)
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const parsed = await parseRequest(
    figmaToHtmlContract,
    request,
    {},
    {
      validationErrorResponse: (error) =>
        NextResponse.json(
          { error: getValidationErrorMessage(error, 'Missing required parameters') },
          { status: 400 }
        ),
    }
  )
  if (!parsed.success) return parsed.response

  const body = parsed.data.body
  const { fileKey, nodeId, workspaceId } = body

  try {
    const figmaUrl = nodeId
      ? `https://api.figma.com/v1/files/${fileKey}/nodes?ids=${encodeURIComponent(nodeId.replace(/-/g, ':'))}`
      : `https://api.figma.com/v1/files/${fileKey}`

    const figmaResponse = await fetch(figmaUrl, {
      headers: { 'X-Figma-Token': process.env.FIGMA_API_KEY || '' },
    })

    if (!figmaResponse.ok) {
      logger.error('Figma API request failed', { fileKey, status: figmaResponse.status })
      return NextResponse.json(
        { error: `Figma API error: ${figmaResponse.status} ${figmaResponse.statusText}` },
        { status: figmaResponse.status === 404 ? 404 : 502 }
      )
    }

    const figmaData = await figmaResponse.json()

    // Resolve real image/SVG asset URLs so the generated HTML doesn't contain broken images
    const source = getFigmaSource(figmaData, nodeId)
    const figmaAssets = await fetchImageAssets(fileKey, source?.document ?? figmaData.document)

    const assets = await rehostAssets(figmaAssets, workspaceId, authResult.userId)

    const prompt = generateAIPrompt(figmaData, body, assets)
    const aiResult = await callAIService(prompt)

    logger.info('Figma to HTML conversion completed', {
      fileKey,
      nodeId,
      aiModel: aiResult.model,
      inputTokens: aiResult.inputTokens,
      outputTokens: aiResult.outputTokens,
    })

    return NextResponse.json({
      metadata: {
        fileKey,
        nodeId,
        processingTime: Date.now() - startTime,
        aiModel: aiResult.model,
        tokensUsed: aiResult.inputTokens + aiResult.outputTokens,
        inputTokens: aiResult.inputTokens,
        outputTokens: aiResult.outputTokens,
        combinedHtml: cleanGeneratedHtml(aiResult.combinedHtml),
      },
    })
  } catch (error) {
    const errorMessage = getErrorMessage(error, 'Figma to HTML conversion failed')
    logger.error('Figma to HTML conversion failed', { error: errorMessage, fileKey, nodeId })
    return NextResponse.json({ error: errorMessage }, { status: 500 })
  }
})
