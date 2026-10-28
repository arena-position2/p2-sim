import { ImageIcon } from '@/components/icons'
import {
  extractUrlsFromText,
  isS3Uri,
  mergeUrlsAndDeduplicate,
  parseImageUrls,
  s3UriToPathObject,
} from '@/lib/utils/parse-image-urls'
import { AuthMode, type BlockConfig } from '@/blocks/types'

const NANO_BANANA_PRO_MODEL = 'gemini-3-pro-image-preview'

export const ImageFusionBlock: BlockConfig = {
  type: 'image_fusion',
  name: 'Image Fusion',
  description: 'Fuse multiple images with Nano Banana Pro',
  authMode: AuthMode.ApiKey,
  longDescription:
    'Combine or fuse multiple images into one using Google Nano Banana Pro. Upload two or more images and describe how to merge them in the prompt. Use 1K resolution for faster results; 2K/4K may hit API deadlines with multiple images.',
  docsLink: 'https://docs.sim.ai/tools/image_generator',
  category: 'tools',
  bgColor: '#4D5FFF',
  icon: ImageIcon,
  subBlocks: [
    {
      id: 'model',
      title: 'Model',
      type: 'dropdown',
      options: [{ label: 'Nano Banana Pro', id: NANO_BANANA_PRO_MODEL }],
      value: () => NANO_BANANA_PRO_MODEL,
      hidden: true,
    },
    {
      id: 'prompt',
      title: 'Prompt',
      type: 'long-input',
      required: true,
      placeholder:
        'Describe how to combine or fuse the images (e.g. style, layout, elements to merge)...',
    },
    {
      id: 'aspectRatio',
      title: 'Aspect Ratio',
      type: 'dropdown',
      options: [
        { label: '1:1', id: '1:1' },
        { label: '2:3', id: '2:3' },
        { label: '3:2', id: '3:2' },
        { label: '3:4', id: '3:4' },
        { label: '4:3', id: '4:3' },
        { label: '4:5', id: '4:5' },
        { label: '5:4', id: '5:4' },
        { label: '9:16', id: '9:16' },
        { label: '16:9', id: '16:9' },
        { label: '21:9', id: '21:9' },
      ],
      value: () => '1:1',
    },
    {
      id: 'imageSize',
      title: 'Resolution',
      type: 'dropdown',
      options: [
        { label: '1K', id: '1K' },
        { label: '2K', id: '2K' },
        { label: '4K', id: '4K' },
      ],
      value: () => '1K',
    },
    {
      id: 'inputImages',
      title: 'Input Images (Fusion)',
      type: 'file-upload',
      acceptedTypes: 'image/*',
      multiple: true,
      uploadContext: 'image-fusion',
      allowStartFilesReference: true,
    },
    {
      id: 'inputImageUrls',
      title: 'Image URLs',
      type: 'long-input',
      placeholder:
        'Enter image URLs (one per line or comma-separated). Or use a reference like <agent1.urls>.',
    },
  ],
  tools: {
    access: ['google_nano_banana'],
    config: {
      tool: () => 'google_nano_banana',
      params: (params) => {
        if (!params.prompt) {
          throw new Error('Prompt is required')
        }
        const base: Record<string, unknown> = {
          model: NANO_BANANA_PRO_MODEL,
          prompt: params.prompt,
          aspectRatio: params.aspectRatio || '1:1',
          imageSize: params.imageSize || '1K',
        }
        const files = Array.isArray(params.inputImages) ? params.inputImages : []
        const urlsFromField = parseImageUrls(params.inputImageUrls)
        const urlsFromPrompt = extractUrlsFromText(params.prompt)
        const urls = mergeUrlsAndDeduplicate(urlsFromField, urlsFromPrompt)
        const httpUrls = urls.filter((u) => !isS3Uri(u))
        const s3Refs = urls.filter(isS3Uri).map(s3UriToPathObject)
        const merged = [...files, ...httpUrls, ...s3Refs]
        if (merged.length > 0) {
          base.inputImages = merged
        }
        return base
      },
    },
  },
  inputs: {
    model: { type: 'string', description: 'Model (fixed to Nano Banana Pro)' },
    prompt: { type: 'string', description: 'Description of how to fuse or combine the images' },
    aspectRatio: { type: 'string', description: 'Output aspect ratio' },
    imageSize: { type: 'string', description: 'Output resolution (1K/2K/4K)' },
    inputImages: {
      type: 'array',
      description: 'Multiple images to fuse; array of file refs { path, type? }',
    },
    inputImageUrls: {
      type: 'string',
      description:
        'Image URLs (newline or comma-separated, or reference like <agent1.urls>). Merged with inputImages.',
    },
  },
  outputs: {
    content: { type: 'string', description: 'Generation response' },
    image: { type: 'string', description: 'Generated image URL' },
    images: { type: 'array', description: 'Generated image URLs' },
    metadata: { type: 'json', description: 'Generation metadata' },
  },
}
