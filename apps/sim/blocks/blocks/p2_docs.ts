import { PresentationIcon } from '@/components/icons'
import type { BlockConfig } from '@/blocks/types'
import { IntegrationType } from '@/blocks/types'

export const P2DocsBlock: BlockConfig = {
  type: 'p2_docs',
  name: 'P2 Docs',
  description: 'Presentation template schemas, icons, and team data',
  longDescription:
    'Internal Position2 presentation helpers: fetch template JSON schemas, browse the slide icon library, and list P2 team members for deck generation. No OAuth required.',
  category: 'tools',
  integrationType: IntegrationType.Documents,
  bgColor: '#F4B400',
  icon: PresentationIcon,
  adminWorkspaceOnly: true,

  subBlocks: [
    {
      id: 'operation',
      title: 'Operation',
      type: 'dropdown',
      options: [
        { label: 'Get Template Schema', id: 'get_template_schema' },
        { label: 'Get Icons Library', id: 'get_presentation_icons' },
        { label: 'Get P2 Team Members', id: 'get_p2_users' },
      ],
      value: () => 'get_template_schema',
    },
    {
      id: 'templateSchemaTemplate',
      title: 'Template',
      type: 'dropdown',
      options: [{ label: 'Position2 2026', id: 'position2_2026' }],
      canonicalParamId: 'template',
      value: () => 'position2_2026',
      condition: { field: 'operation', value: 'get_template_schema' },
      required: true,
    },
    {
      id: 'iconsCategory',
      title: 'Category',
      type: 'short-input',
      placeholder: 'Optional: marketing, technology, ai, ...',
      canonicalParamId: 'category',
      condition: { field: 'operation', value: 'get_presentation_icons' },
    },
    {
      id: 'iconsColor',
      title: 'Color',
      type: 'dropdown',
      options: [
        { label: 'All', id: '' },
        { label: 'Black', id: 'black' },
        { label: 'White', id: 'white' },
      ],
      canonicalParamId: 'color',
      condition: { field: 'operation', value: 'get_presentation_icons' },
    },
    {
      id: 'p2UsersFilter',
      title: 'Filter',
      type: 'short-input',
      placeholder: 'Optional: filter by name or designation (e.g. "VP", "Board")',
      canonicalParamId: 'filter',
      condition: { field: 'operation', value: 'get_p2_users' },
    },
  ],

  tools: {
    access: [
      'p2_docs_get_template_schema',
      'p2_docs_get_presentation_icons',
      'p2_docs_get_p2_users',
    ],
    config: {
      tool: (params) => {
        switch (params.operation) {
          case 'get_template_schema':
            return 'p2_docs_get_template_schema'
          case 'get_presentation_icons':
            return 'p2_docs_get_presentation_icons'
          case 'get_p2_users':
            return 'p2_docs_get_p2_users'
          default:
            return 'p2_docs_get_template_schema'
        }
      },
      params: (params) => {
        if (params.operation === 'get_template_schema') {
          const template = (
            (params.templateSchemaTemplate as string) ||
            (params.template as string) ||
            'position2_2026'
          ).trim()
          return { template }
        }

        if (params.operation === 'get_presentation_icons') {
          const category = (
            (params.iconsCategory as string) ||
            (params.category as string) ||
            ''
          ).trim()
          const color = ((params.iconsColor as string) || (params.color as string) || '').trim()
          return {
            category: category || undefined,
            color: color === 'black' || color === 'white' ? color : undefined,
          }
        }

        if (params.operation === 'get_p2_users') {
          const filter = (
            (params.p2UsersFilter as string) ||
            (params.filter as string) ||
            ''
          ).trim()
          return { filter: filter || undefined }
        }

        return {}
      },
    },
  },

  inputs: {
    operation: { type: 'string', description: 'Operation to perform' },
    templateSchemaTemplate: { type: 'string', description: 'Template id (e.g. position2_2026)' },
    iconsCategory: { type: 'string', description: 'Optional icon category filter' },
    iconsColor: { type: 'string', description: 'Icon color variant (black or white)' },
    p2UsersFilter: { type: 'string', description: 'Optional team member filter keyword' },
  },

  outputs: {
    schema: {
      type: 'json',
      description: 'Full presentation template schema (slides, blocks, shapeIds)',
    },
    icons: {
      type: 'json',
      description: 'Presentation icon catalog entries (id, label, category, tags, pngUrl)',
    },
    count: { type: 'number', description: 'Number of icons returned' },
    baseUrl: { type: 'string', description: 'Base URL for presentation icon assets' },
    version: { type: 'string', description: 'Icon library version' },
    users: {
      type: 'array',
      description: 'List of matched P2 team members',
    },
    total: { type: 'number', description: 'Total number of team members returned' },
  },
}
