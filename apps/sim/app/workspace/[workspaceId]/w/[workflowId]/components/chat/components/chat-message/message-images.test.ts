/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import {
  isImageUrlLine,
  mergeToolOutputImageUrls,
  resolveMessageImagesAndProse,
} from '@/app/workspace/[workspaceId]/w/[workflowId]/components/chat/components/chat-message/constants'

const IMAGE_URL =
  'https://dev-agent.thearena.ai/api/files/serve/agent-generated-images%2F9475b37b-2f9f-4f36-8fc3-0596a3370466%2Fpdro2AgNALnhYCB7HlyE9Sm0kt6nHpF5%2F1782822080449-oqpYKF5Oh0pElZiUo-kUj.jpeg'

const IMAGE_URL_2 =
  'https://dev-agent.thearena.ai/api/files/serve/agent-generated-images%2F9475b37b-2f9f-4f36-8fc3-0596a3370466%2Fpdro2AgNALnhYCB7HlyE9Sm0kt6nHpF5%2F1782822098083-vAY9r6hPrIQ8Tiqhzr34D.jpeg'

const IMAGE_URL_3 =
  'https://dev-agent.thearena.ai/api/files/serve/agent-generated-images%2F9475b37b-2f9f-4f36-8fc3-0596a3370466%2Fpdro2AgNALnhYCB7HlyE9Sm0kt6nHpF5%2F1782822111994-kVLpr3ogBfh2RuxPPzCmT.jpeg'

describe('resolveMessageImagesAndProse', () => {
  it('extracts plain image URLs separated by blank lines', () => {
    const raw = `Here are three new variations:\n\n${IMAGE_URL}\n\n${IMAGE_URL_2}\n\n${IMAGE_URL_3}`

    const { urls, prose } = resolveMessageImagesAndProse(raw)

    expect(urls).toEqual([IMAGE_URL, IMAGE_URL_2, IMAGE_URL_3])
    expect(prose).toBe('Here are three new variations:')
  })

  it('extracts bullet-list image URLs', () => {
    const raw = `Here are three new variations:\n\n- ${IMAGE_URL}\n- ${IMAGE_URL_2}\n- ${IMAGE_URL_3}`

    const { urls, prose } = resolveMessageImagesAndProse(raw)

    expect(urls).toEqual([IMAGE_URL, IMAGE_URL_2, IMAGE_URL_3])
    expect(prose).toBe('Here are three new variations:')
  })

  it('extracts numbered-list image URLs', () => {
    const raw = `Here are three new variations:\n\n1. ${IMAGE_URL}\n2. ${IMAGE_URL_2}\n3. ${IMAGE_URL_3}`

    const { urls, prose } = resolveMessageImagesAndProse(raw)

    expect(urls).toEqual([IMAGE_URL, IMAGE_URL_2, IMAGE_URL_3])
    expect(prose).toBe('Here are three new variations:')
  })

  it('extracts image URLs from a mixed prose and list segment', () => {
    const raw = `Here are three new variations:\n- ${IMAGE_URL}\n- ${IMAGE_URL_2}\n- ${IMAGE_URL_3}`

    const { urls, prose } = resolveMessageImagesAndProse(raw)

    expect(urls).toEqual([IMAGE_URL, IMAGE_URL_2, IMAGE_URL_3])
    expect(prose).toBe('Here are three new variations:')
  })

  it('extracts markdown image links and backtick-wrapped URLs', () => {
    const raw = `Variations:\n![Variation 1](${IMAGE_URL})\n\`${IMAGE_URL_2}\``

    const { urls, prose } = resolveMessageImagesAndProse(raw)

    expect(urls).toEqual([IMAGE_URL, IMAGE_URL_2])
    expect(prose).toBe('Variations:')
  })

  it('extracts labeled and blockquoted image URLs', () => {
    const raw = `Results:\nVariation 1: ${IMAGE_URL}\n> ${IMAGE_URL_2}`

    const { urls, prose } = resolveMessageImagesAndProse(raw)

    expect(urls).toEqual([IMAGE_URL, IMAGE_URL_2])
    expect(prose).toBe('Results:')
  })

  it('extracts multiple image URLs from one line', () => {
    const raw = `${IMAGE_URL} ${IMAGE_URL_2}`

    const { urls, prose } = resolveMessageImagesAndProse(raw)

    expect(urls).toEqual([IMAGE_URL, IMAGE_URL_2])
    expect(prose).toBe('')
  })

  it('leaves image URLs inside fenced code untouched', () => {
    const phone = 'https://cdn.example.com/phone.jpg'
    const raw = [
      '```html',
      '<div>',
      `  <img src="${phone}" alt="phone" />`,
      '  <p>iPhone | 128GB</p>',
      '</div>',
      '```',
    ].join('\n')

    const { urls, prose } = resolveMessageImagesAndProse(raw)

    expect(urls).toEqual([])
    expect(prose).toBe(raw)
  })

  it('extracts an image URL after a fenced code block and keeps the fence', () => {
    const phone = 'https://cdn.example.com/phone.jpg'
    const fenced = [
      '```html',
      '<div>',
      `  <img src="${phone}" alt="phone" />`,
      '</div>',
      '```',
    ].join('\n')
    const raw = `${fenced}\n\n${IMAGE_URL}`

    const { urls, prose } = resolveMessageImagesAndProse(raw)

    expect(urls).toEqual([IMAGE_URL])
    expect(prose).toBe(fenced)
    expect(prose).toContain(phone)
  })

  it('renders a selected image file without its base64 payload', () => {
    const raw = JSON.stringify(
      {
        id: 'file_1',
        name: 'generated.png',
        url: IMAGE_URL,
        size: 128,
        type: 'image/png',
        base64:
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      },
      null,
      2
    )

    const { urls, prose } = resolveMessageImagesAndProse(raw)

    expect(urls).toEqual([IMAGE_URL])
    expect(prose).toBe('')
  })

  it('renders a selected images array without base64 payloads', () => {
    const raw = `\`\`\`json\n${JSON.stringify([
      {
        id: 'file-1',
        name: 'one.png',
        url: IMAGE_URL,
        key: 'agent-generated-images/wf/user/one.png',
        size: 10,
        type: 'image/png',
        base64:
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      },
      {
        id: 'file-2',
        name: 'two.png',
        url: IMAGE_URL_2,
        key: 'agent-generated-images/wf/user/two.png',
        size: 10,
        type: 'image/png',
        base64: '/9j/4AAQSkZJRgABAQAAAQABAAD/2wCEAAkGBxMTEhUTExMWFRUXGBcY',
      },
    ])}\n\`\`\``

    const { urls, prose } = resolveMessageImagesAndProse(raw)

    expect(urls).toEqual([IMAGE_URL, IMAGE_URL_2])
    expect(prose).toBe('')
  })

  it('hides inline base64 when an edited image URL is also present', () => {
    const payload =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
    const raw = `Updated the background.\n\n${IMAGE_URL}\n\ndata:image/png;base64,${payload}`

    const { urls, prose } = resolveMessageImagesAndProse(raw)

    expect(urls).toEqual([IMAGE_URL])
    expect(prose).toBe('Updated the background.')
  })

  it('drops a fenced image-file dump that echoes base64 beside the reply', () => {
    const payload =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
    const raw = [
      'Updated the sky.',
      '',
      '```json',
      JSON.stringify(
        {
          id: 'file_1',
          name: 'generated.png',
          url: IMAGE_URL,
          size: 128,
          type: 'image/png',
          base64: payload,
        },
        null,
        2
      ),
      '```',
    ].join('\n')

    const { urls, prose } = resolveMessageImagesAndProse(raw)

    expect(urls).toEqual([IMAGE_URL])
    expect(prose).toBe('Updated the sky.')
  })

  it('renders an execution image file record as the picture, not JSON', () => {
    const key =
      'execution/347b4522-46e3-45ac-a850-277f1a78ff60/760767d3-9144-4ecd-90e1-6275f71950b2/5d1b54d4-d52e-413c-8af7-d3796092a3df/7510eb0c-be7c-40b4-926a-e0fe33722b60/generated-image.png'
    const raw = JSON.stringify(
      {
        id: 'file_1792990794515_zrn6qoc',
        name: 'generated-image.png',
        size: 287761,
        type: 'application/octet-stream',
        url: '',
        key,
        context: 'execution',
      },
      null,
      2
    )

    const { urls, prose } = resolveMessageImagesAndProse(`${raw}\n\nUse this image.`)

    expect(prose).toBe('Use this image.')
    expect(urls).toEqual([`/api/files/serve/${encodeURIComponent(key)}`])
    expect(prose).not.toContain('generated-image.png')
  })

  it('extracts image URLs from JSON content payloads', () => {
    const raw = JSON.stringify({
      content: `Here are options:\n- ${IMAGE_URL}\n- ${IMAGE_URL_2}`,
      image: IMAGE_URL_3,
    })

    const { urls, prose } = resolveMessageImagesAndProse(raw)

    expect(urls).toEqual([IMAGE_URL_3, IMAGE_URL, IMAGE_URL_2])
    expect(prose).toBe('Here are options:')
  })
})

describe('isImageUrlLine', () => {
  it('accepts list-prefixed image URLs', () => {
    expect(isImageUrlLine(`- ${IMAGE_URL}`)).toBe(true)
    expect(isImageUrlLine(`1. ${IMAGE_URL}`)).toBe(true)
  })
})

describe('mergeToolOutputImageUrls', () => {
  it('keeps a generated image when sample HTML also contains an img src', () => {
    const sample = 'https://cdn.example.com/phone.jpg'
    const content = `\`\`\`html\n<img src="${sample}" />\n\`\`\`\n\n${IMAGE_URL}`

    const { uniqueUrls, prose } = mergeToolOutputImageUrls(IMAGE_URL, content)

    expect(uniqueUrls).toEqual([IMAGE_URL])
    expect(prose).toContain('```html')
    expect(prose).toContain(sample)
    expect(prose).not.toContain(IMAGE_URL)
  })

  it('hides base64 echoed in content when the image field already has a URL', () => {
    const payload =
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

    const { uniqueUrls, prose } = mergeToolOutputImageUrls(
      IMAGE_URL,
      `Here is the edit.\n\n${payload}`
    )

    expect(uniqueUrls).toEqual([IMAGE_URL])
    expect(prose).toBe('Here is the edit.')
  })

  it('merges image URLs from agent content text with list markers', () => {
    const content = `Here are three new variations:\n\n- ${IMAGE_URL}\n- ${IMAGE_URL_2}\n- ${IMAGE_URL_3}`

    const { uniqueUrls, prose } = mergeToolOutputImageUrls('', content)

    expect(uniqueUrls).toEqual([IMAGE_URL, IMAGE_URL_2, IMAGE_URL_3])
    expect(prose).toBe('Here are three new variations:')
  })
})
