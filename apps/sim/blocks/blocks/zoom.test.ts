import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockResolveZoomAdminAccessForUi, mockResolveWorkspaceIdForAdminCheck } = vi.hoisted(() => ({
  mockResolveZoomAdminAccessForUi: vi.fn(() => false),
  mockResolveWorkspaceIdForAdminCheck: vi.fn(() => 'ws-normal'),
}))

vi.mock('@/lib/workspaces/is-admin-workspace', () => ({
  resolveWorkspaceIdForAdminCheck: mockResolveWorkspaceIdForAdminCheck,
}))

vi.mock('@/lib/workspaces/zoom-admin-access-cache', () => ({
  resolveZoomAdminAccessForUi: mockResolveZoomAdminAccessForUi,
}))

import { ZoomBlock } from '@/blocks/blocks/zoom'
import type { BlockToolParamsContext } from '@/blocks/types'

describe('ZoomBlock', () => {
  const paramsFunction = ZoomBlock.tools.config?.params
  const toolFunction = ZoomBlock.tools.config?.tool

  if (!paramsFunction || !toolFunction) {
    throw new Error('ZoomBlock.tools.config is missing')
  }

  beforeEach(() => {
    vi.clearAllMocks()
    mockResolveZoomAdminAccessForUi.mockReturnValue(false)
    mockResolveWorkspaceIdForAdminCheck.mockReturnValue('ws-normal')
  })

  it('shows a single Zoom credential input with personal and admin connect paths', () => {
    const credential = ZoomBlock.subBlocks.find((subBlock) => subBlock.id === 'credential')
    const manualCredential = ZoomBlock.subBlocks.find(
      (subBlock) => subBlock.id === 'manualCredential'
    )
    const adminCredential = ZoomBlock.subBlocks.find(
      (subBlock) => subBlock.id === 'credentialAdmin'
    )
    const adminManualCredential = ZoomBlock.subBlocks.find(
      (subBlock) => subBlock.id === 'manualCredentialAdmin'
    )

    expect(credential?.title).toBe('Zoom account')
    expect(credential?.required).toBe(true)
    expect(credential?.additionalConnectOptions).toEqual([
      {
        label: 'Connect Zoom admin account',
        serviceId: 'zoom-admin',
      },
    ])
    expect(credential?.placeholder).toBe('Select or connect Zoom account')

    expect(manualCredential?.title).toBe('Zoom account')
    expect(manualCredential?.required).toBe(true)
    expect(manualCredential?.placeholder).toBe('Zoom credential ID')

    expect(adminCredential).toBeUndefined()
    expect(adminManualCredential).toBeUndefined()
  })

  it('uses the selected credential for normal Zoom operations', () => {
    const result = paramsFunction({
      operation: 'zoom_list_meetings',
      oauthCredential: 'selected-cred',
      userId: 'me',
    })

    expect(result.credential).toBe('selected-cred')
  })

  it('hides account recording operations outside admin workspaces', () => {
    const operationSubBlock = ZoomBlock.subBlocks.find((subBlock) => subBlock.id === 'operation')
    const options =
      typeof operationSubBlock?.options === 'function'
        ? operationSubBlock.options()
        : operationSubBlock?.options

    const optionIds = options?.map((option) => option.id) ?? []
    expect(optionIds).not.toContain('zoom_list_account_recordings')
    expect(optionIds).not.toContain('zoom_get_account_recordings_with_transcript')
    expect(optionIds).toContain('zoom_list_recordings')
  })

  it('shows account recording operations when Zoom Admin access is allowed', () => {
    mockResolveZoomAdminAccessForUi.mockReturnValue(true)

    const operationSubBlock = ZoomBlock.subBlocks.find((subBlock) => subBlock.id === 'operation')
    const options =
      typeof operationSubBlock?.options === 'function'
        ? operationSubBlock.options()
        : operationSubBlock?.options

    const optionIds = options?.map((option) => option.id) ?? []
    expect(optionIds).toContain('zoom_list_account_recordings')
    expect(optionIds).toContain('zoom_get_account_recordings_with_transcript')
  })

  it('allows account recording operations when Zoom Admin access is allowed', () => {
    mockResolveZoomAdminAccessForUi.mockReturnValue(true)

    const result = paramsFunction({
      operation: 'zoom_list_account_recordings',
      oauthCredential: 'selected-cred',
      fromDate: '2026-05-01',
      toDate: '2026-05-26',
    })

    expect(result.credential).toBe('selected-cred')
  })
})

function mapParams(params: Record<string, unknown>, context?: BlockToolParamsContext) {
  const mapper = ZoomBlock.tools.config?.params
  if (!mapper) throw new Error('Zoom block has no params mapper')
  return mapper({ oauthCredential: 'cred', ...params }, context)
}

/** What a tool call sends: the merged row params and model args with the mapper result over them. */
function toolCall(args: Record<string, unknown>, operation: string) {
  return { ...args, ...mapParams(args, { operation }) }
}

describe('Zoom tool calls', () => {
  it('sends a stored From/To Date range on List Recordings', () => {
    const sent = toolCall(
      { userId: 'me', fromDate: '2026-10-01', toDate: '2026-10-31' },
      'zoom_list_recordings'
    )
    expect(sent.from).toBe('2026-10-01')
    expect(sent.to).toBe('2026-10-31')
  })

  it("keeps the model's from/to when the row has no dates", () => {
    const sent = toolCall(
      { userId: 'me', from: '2026-10-01', to: '2026-10-15' },
      'zoom_list_recordings'
    )
    expect(sent.from).toBe('2026-10-01')
    expect(sent.to).toBe('2026-10-15')
  })

  it("keeps the model's topic and list type", () => {
    expect(toolCall({ meetingId: '123', topic: 'Renamed' }, 'zoom_update_meeting').topic).toBe(
      'Renamed'
    )
    expect(toolCall({ userId: 'me', type: 'upcoming' }, 'zoom_list_meetings').type).toBe('upcoming')
  })

  it('accepts a numeric meeting ID from the model', () => {
    expect(toolCall({ meetingId: 85746065432 }, 'zoom_get_meeting').meetingId).toBe('85746065432')
  })

  it('coerces a stored meeting type and drops a stored "none" auto recording', () => {
    const sent = toolCall(
      { userId: 'me', topic: 'Standup', type: '8', autoRecording: 'none' },
      'zoom_create_meeting'
    )
    expect(sent.type).toBe(8)
    expect(sent.autoRecording).toBeUndefined()
  })

  it('does not turn auto recording off from a legacy row that stored "none" on Update Meeting', () => {
    const sent = toolCall({ meetingId: '123', autoRecording: 'none' }, 'zoom_update_meeting')
    expect(sent.autoRecording).toBeUndefined()
  })

  it("lets the model set auto recording from a new agent tool row's seed", () => {
    const field = ZoomBlock.subBlocks.find((subBlock) => subBlock.id === 'autoRecording')
    const seeded = field?.value?.({})
    const stored = seeded === undefined ? {} : { autoRecording: seeded }
    const sent = toolCall(
      { meetingId: '123', autoRecording: 'cloud', ...stored },
      'zoom_update_meeting'
    )
    expect(sent.autoRecording).toBe('cloud')
  })
})

describe('Zoom canvas update', () => {
  it('does not send a stale create topic', () => {
    const inputs = {
      operation: 'zoom_update_meeting',
      meetingId: '123',
      topic: 'Old create topic',
      topicUpdate: '',
    }
    expect({ ...inputs, ...mapParams(inputs) }.topic).not.toBe('Old create topic')
  })

  it('leaves the meeting type unchanged for a new Update Meeting block', () => {
    const typeField = ZoomBlock.subBlocks.find((subBlock) => subBlock.id === 'type')
    const seeded = typeField?.value?.({ operation: 'zoom_update_meeting' })
    const inputs = { operation: 'zoom_update_meeting', meetingId: '123', type: seeded }
    expect({ ...inputs, ...mapParams(inputs) }.type).toBeUndefined()
  })
})
