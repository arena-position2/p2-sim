import { PresentationIcon } from '@/components/icons'
import type { BlockConfig } from '@/blocks/types'

export const PresentationBlock: BlockConfig = {
  type: 'presentation',
  name: 'Presentation',
  description: 'Create presentations',
  longDescription:
    'Integrate Presentation creation into the workflow. Can create presentations with customizable slides, tone, and verbosity.',
  category: 'tools',
  bgColor: '#F4B400',
  icon: PresentationIcon,
  subBlocks: [
    {
      id: 'operation',
      title: 'Operation',
      type: 'dropdown',
      options: [{ label: 'Create', id: 'create' }],
      value: () => 'create',
    },
    {
      id: 'numberOfSlides',
      title: 'Number of Slides',
      type: 'short-input',
      placeholder: 'Enter number of slides',
      required: true,
      condition: { field: 'operation', value: 'create' },
    },
    {
      id: 'tone',
      title: 'Tone',
      type: 'dropdown',
      options: [{ label: 'Professional', id: 'professional' }],
      value: () => 'professional',
      condition: { field: 'operation', value: 'create' },
    },
    {
      id: 'verbosity',
      title: 'Verbosity',
      type: 'dropdown',
      options: [{ label: 'Standard', id: 'standard' }],
      value: () => 'standard',
      condition: { field: 'operation', value: 'create' },
    },
    {
      id: 'template',
      title: 'Templates',
      type: 'dropdown',
      options: [
        { label: 'Position2', id: 'position2' },
        { label: 'Persona Template', id: 'persona-templates' },
      ],
      value: () => 'position2',
      condition: { field: 'operation', value: 'create' },
    },
    {
      id: 'content',
      title: 'Content',
      type: 'long-input',
      placeholder: 'Enter presentation content',
      condition: { field: 'operation', value: 'create' },
    },
    {
      id: 'slides_markdown',
      title: 'Slides Markdown',
      type: 'long-input',
      placeholder: 'Enter slides markdown as JSON array: ["slide 1 content", "slide 2 content"]',
      description:
        'Pre-provide markdown content for each slide (bypasses outline generation). Array of strings in JSON format. Auto-sets slide count.',
      condition: { field: 'operation', value: 'create' },
    },
    {
      id: 'instructions',
      title: 'Instructions',
      type: 'long-input',
      placeholder: 'Enter instructions for the presentation.',
      description:
        'Custom guidance for AI generation. Influences style, content focus, and formatting. Examples: "Emphasize security features", "Use professional tone", "Include metrics"',
      condition: { field: 'operation', value: 'create' },
    },
  ],
  tools: {
    access: ['presentation_create'],
    config: {
      tool: (params) => {
        switch (params.operation) {
          case 'create':
            return 'presentation_create'
          default:
            return 'presentation_create'
        }
      },
    },
  },
  inputs: {
    operation: { type: 'string', description: 'Operation to perform' },
    numberOfSlides: {
      type: 'number',
      description: 'Number of slides to create (auto-set if slides_markdown is provided)',
    },
    tone: { type: 'string', description: 'Tone of the presentation' },
    verbosity: { type: 'string', description: 'Verbosity level of the presentation' },
    template: { type: 'string', description: 'Presentation template' },
    content: { type: 'string', description: 'Presentation content/topic' },
    slides_markdown: {
      type: 'array',
      description:
        'Pre-provide markdown content for each slide. Bypasses outline generation. Auto-sets slide count.',
    },
    instructions: {
      type: 'string',
      description:
        'Custom guidance for AI generation (style, content focus, formatting). Applied during outline, layout, and content generation.',
    },
  },
  outputs: {
    presentationFile: { type: 'json', description: 'Presentation file' },
    presentationId: { type: 'string', description: 'Presentation ID' },
    message: { type: 'string', description: 'Status message' },
  },
}
