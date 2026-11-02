/**
 * @vitest-environment jsdom
 */
import { act } from 'react'
import type { Spec } from '@json-render/core'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('@sim/emcn', () => ({
  cn: (...args: unknown[]) => args.filter(Boolean).join(' '),
}))

vi.mock('streamdown/styles.css', () => ({}))

vi.mock('@/app/(interfaces)/gui-apps/generative-app-theme.css', () => ({}))

vi.mock('echarts', () => ({
  init: () => ({
    setOption: () => undefined,
    resize: () => undefined,
    dispose: () => undefined,
  }),
}))

vi.mock('next/image', () => ({
  default: ({ alt, ...props }: { alt?: string }) => <img alt={alt} {...props} />,
}))

vi.mock('@/app/(interfaces)/chat/components/message/components/ArenaLogo.svg', () => ({
  default: '/arena-logo.svg',
}))

import type { ArenaGenerativeChatProtocol } from '@/lib/arena-generative-ui/chat-protocol'
import { selectedItemHostState } from '@/lib/arena-generative-ui/types'
import {
  type ArenaGenerativeUxPlan,
  injectSamePageSelectChrome,
} from '@/lib/arena-generative-ui/ux-compiler'
import { SpecRenderer } from '@/app/(interfaces)/gui-apps/[identifier]/spec-renderer'

const homeSpec: Spec = {
  root: 'page',
  elements: {
    page: {
      type: 'Page',
      props: { title: 'Home' },
      children: ['nav', 'form'],
    },
    nav: {
      type: 'NavLink',
      props: { label: 'Results', to: 'results' },
      children: [],
    },
    form: {
      type: 'Form',
      props: { actionId: 'submit_lead' },
      children: ['name', 'submit'],
    },
    name: {
      type: 'TextInput',
      props: { name: 'name', label: 'Name' },
      children: [],
    },
    submit: {
      type: 'SubmitButton',
      props: { label: 'Submit' },
      children: [],
    },
  },
}

const replySpec: Spec = {
  root: 'page',
  elements: {
    page: {
      type: 'Page',
      props: { title: 'Chat' },
      children: ['reply'],
    },
    reply: {
      type: 'DataText',
      props: { statePath: 'output.content', fallback: 'Waiting for a reply…' },
      children: [],
    },
  },
}

const progressSpec: Spec = {
  root: 'page',
  elements: {
    page: {
      type: 'Page',
      props: { title: 'Home' },
      children: ['progress'],
    },
    progress: {
      type: 'ProgressSteps',
      props: {
        steps: 'Connecting\nResearching',
        durationMs: 1000,
      },
      children: [],
    },
  },
}

describe('SpecRenderer', () => {
  let unmount: (() => void) | undefined

  afterEach(() => {
    unmount?.()
    unmount = undefined
  })

  function render(options?: {
    spec?: Spec
    state?: Record<string, unknown>
    pending?: boolean
    pendingActionIds?: ReadonlySet<string>
    actionHostKeys?: Record<string, readonly string[]>
    proseAliasKeys?: readonly string[]
    actionHiddenInputs?: Record<string, readonly string[]>
    actionChatProtocol?: Record<string, ArenaGenerativeChatProtocol>
    uxPlan?: ArenaGenerativeUxPlan
    currentPath?: string
    onNavigate?: ReturnType<typeof vi.fn>
    onRunAction?: ReturnType<typeof vi.fn>
    onSelectItem?: ReturnType<typeof vi.fn>
    onClearItem?: ReturnType<typeof vi.fn>
    onClearSelection?: ReturnType<typeof vi.fn>
    onCancelPending?: ReturnType<typeof vi.fn>
  }) {
    const onNavigate = options?.onNavigate ?? vi.fn()
    const onRunAction = options?.onRunAction ?? vi.fn().mockResolvedValue(undefined)
    const onSelectItem = options?.onSelectItem ?? vi.fn()
    const onClearItem = options?.onClearItem ?? vi.fn()
    const onClearSelection = options?.onClearSelection ?? vi.fn()
    const onCancelPending = options?.onCancelPending ?? vi.fn()
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root: Root = createRoot(container)
    act(() => {
      root.render(
        <SpecRenderer
          spec={options?.spec ?? homeSpec}
          state={options?.state ?? {}}
          pending={options?.pending ?? false}
          pendingActionIds={options?.pendingActionIds}
          actionHostKeys={options?.actionHostKeys}
          proseAliasKeys={options?.proseAliasKeys}
          actionHiddenInputs={options?.actionHiddenInputs}
          actionChatProtocol={options?.actionChatProtocol}
          uxPlan={options?.uxPlan}
          currentPath={options?.currentPath}
          onNavigate={onNavigate}
          onRunAction={onRunAction}
          onSelectItem={onSelectItem}
          onClearItem={onClearItem}
          onClearSelection={onClearSelection}
          onCancelPending={onCancelPending}
        />
      )
    })
    unmount = () => {
      act(() => {
        root.unmount()
      })
      container.remove()
    }
    return {
      container,
      onNavigate,
      onRunAction,
      onSelectItem,
      onClearItem,
      onClearSelection,
      onCancelPending,
    }
  }

  function chooseSelectOption(container: HTMLElement, name: string, option: string) {
    const hidden = container.querySelector(
      `input[type="hidden"][name="${name}"]`
    ) as HTMLInputElement | null
    const trigger = hidden?.parentElement?.querySelector(
      'button[aria-haspopup="listbox"]'
    ) as HTMLButtonElement
    expect(trigger).toBeTruthy()
    act(() => {
      trigger.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    const choice = Array.from(container.querySelectorAll('[role="option"]')).find(
      (node) => node.textContent === option
    )
    expect(choice).toBeTruthy()
    act(() => {
      choice?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
  }

  it('navigates when a NavLink is clicked', () => {
    const { container, onNavigate } = render()
    const link = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Results'
    )
    expect(link).toBeTruthy()
    act(() => {
      link?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(onNavigate).toHaveBeenCalledWith('results')
  })

  it('posts form values through onRunAction', () => {
    const { container, onRunAction } = render()
    const input = container.querySelector('input[name="name"]') as HTMLInputElement
    const form = container.querySelector('form')
    expect(input).toBeTruthy()
    expect(form).toBeTruthy()

    act(() => {
      input.value = 'Ada'
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.dispatchEvent(new Event('change', { bubbles: true }))
    })

    act(() => {
      form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })

    expect(onRunAction).toHaveBeenCalledWith(
      'submit_lead',
      expect.objectContaining({ name: 'Ada' })
    )
  })

  describe('form controls', () => {
    function formSpec(
      fields: Record<string, { type: string; props: Record<string, unknown> }>
    ): Spec {
      return {
        root: 'page',
        elements: {
          page: { type: 'Page', props: {}, children: ['form'] },
          form: {
            type: 'Form',
            props: { actionId: 'save' },
            children: [...Object.keys(fields), 'submit'],
          },
          ...Object.fromEntries(
            Object.entries(fields).map(([id, field]) => [
              id,
              { type: field.type, props: field.props, children: [] },
            ])
          ),
          submit: { type: 'SubmitButton', props: { label: 'Save' }, children: [] },
        },
      }
    }

    it('blocks submit and shows errorText when a required field is empty', () => {
      const { container, onRunAction } = render({
        spec: formSpec({
          name: {
            type: 'TextInput',
            props: { name: 'name', label: 'Name', required: true, errorText: 'Name is required' },
          },
        }),
      })
      act(() => {
        container
          .querySelector('form')
          ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
      })
      expect(onRunAction).not.toHaveBeenCalled()
      expect(container.querySelector('[data-testid="field-error-name"]')?.textContent).toBe(
        'Name is required'
      )
    })

    it('hides a showWhen field and omits it from the action payload', () => {
      const { container, onRunAction } = render({
        spec: formSpec({
          notify: {
            type: 'Switch',
            props: { name: 'notify', label: 'Notify', defaultChecked: false },
          },
          email: {
            type: 'TextInput',
            props: { name: 'email', label: 'Email', required: true, showWhen: 'notify' },
          },
        }),
      })
      expect(container.querySelector('input[name="email"]')).toBeNull()
      act(() => {
        container
          .querySelector('form')
          ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
      })
      expect(onRunAction).toHaveBeenCalledWith('save', expect.objectContaining({ notify: false }))
      expect(onRunAction.mock.calls[0]?.[1]).not.toHaveProperty('email')
    })

    it('hides visitorEmail fields and omits them from the action payload', () => {
      const { container, onRunAction } = render({
        spec: formSpec({
          company: {
            type: 'TextInput',
            props: { name: 'company', label: 'Company', defaultValue: 'Acme' },
          },
          userEmail: {
            type: 'TextInput',
            props: { name: 'userEmail', label: 'Your email', defaultValue: 'typed@acme.com' },
          },
        }),
        actionHiddenInputs: { save: ['userEmail'] },
      })
      expect(container.querySelector('input[name="userEmail"]')).toBeNull()
      expect(container.querySelector('input[name="company"]')).toBeTruthy()
      act(() => {
        container
          .querySelector('form')
          ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
      })
      expect(onRunAction).toHaveBeenCalledWith('save', expect.objectContaining({ company: 'Acme' }))
      expect(onRunAction.mock.calls[0]?.[1]).not.toHaveProperty('userEmail')
    })

    it('submits Checkbox, NumberInput, and MultiSelect with coerced types', () => {
      const { container, onRunAction } = render({
        spec: formSpec({
          agree: {
            type: 'Checkbox',
            props: { name: 'agree', label: 'Agree', defaultChecked: true },
          },
          count: {
            type: 'NumberInput',
            props: { name: 'count', label: 'Count', defaultValue: '3' },
          },
          tags: {
            type: 'MultiSelect',
            props: {
              name: 'tags',
              label: 'Tags',
              options: 'alpha, beta, gamma',
              defaultValue: 'alpha, gamma',
            },
          },
        }),
      })
      act(() => {
        container
          .querySelector('form')
          ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
      })
      expect(onRunAction).toHaveBeenCalledWith('save', {
        agree: true,
        count: 3,
        tags: ['alpha', 'gamma'],
      })
    })

    it('seeds a field from host state via statePath', () => {
      const { container } = render({
        spec: formSpec({
          company: {
            type: 'TextInput',
            props: { name: 'company', label: 'Company', statePath: 'company' },
          },
        }),
        state: { company: 'Arena' },
      })
      expect((container.querySelector('input[name="company"]') as HTMLInputElement).value).toBe(
        'Arena'
      )
    })

    it('renders RadioGroup and DateInput', () => {
      const { container } = render({
        spec: formSpec({
          channel: {
            type: 'RadioGroup',
            props: {
              name: 'channel',
              label: 'Channel',
              options: 'email, sms',
              defaultValue: 'sms',
            },
          },
          start: {
            type: 'DateInput',
            props: { name: 'start', label: 'Start', defaultValue: '2026-08-18' },
          },
        }),
      })
      const sms = container.querySelector('input[type="radio"][value="sms"]') as HTMLInputElement
      expect(sms.checked).toBe(true)
      expect((container.querySelector('input[type="date"]') as HTMLInputElement).value).toBe(
        '2026-08-18'
      )
    })
  })

  it('uses SubmitButton.actionId when Form.actionId is missing', () => {
    const spec: Spec = {
      root: 'page',
      elements: {
        page: { type: 'Page', props: { title: 'Chat' }, children: ['form'] },
        form: { type: 'Form', props: {}, children: ['prompt', 'submit'] },
        prompt: { type: 'TextInput', props: { name: 'input', label: 'Message' }, children: [] },
        submit: {
          type: 'SubmitButton',
          props: { label: 'Send', actionId: 'ask_chat' },
          children: [],
        },
      },
    }
    const { container, onRunAction } = render({ spec })
    const form = container.querySelector('form')
    act(() => {
      form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })
    expect(onRunAction).toHaveBeenCalledWith('ask_chat', expect.any(Object))
  })

  it('renders DataText markdown headings, emphasis, and lists', () => {
    const { container } = render({
      spec: replySpec,
      state: {
        output: {
          content: '## Summary\n\n**Bold** reply\n\n- first\n- second',
        },
      },
    })

    expect(container.querySelector('h2')?.textContent).toBe('Summary')
    expect(container.querySelector('strong')?.textContent).toContain('Bold')
    const items = Array.from(container.querySelectorAll('li')).map((item) => item.textContent)
    expect(items).toEqual(expect.arrayContaining(['first', 'second']))
  })

  it('renders the DataText fallback as plain text', () => {
    const { container } = render({ spec: replySpec, state: {} })
    expect(container.textContent).toContain('Waiting for a reply…')
    expect(container.querySelector('strong')).toBeNull()
  })

  it('renders the DataText fallback when content is an empty string', () => {
    const spec: Spec = {
      root: 'page',
      elements: {
        page: { type: 'Page', props: { title: 'Results' }, children: ['body'] },
        body: {
          type: 'DataText',
          props: { statePath: 'content', fallback: 'Waiting for a reply…' },
          children: [],
        },
      },
    }
    const { container } = render({ spec, state: { content: '' } })
    expect(container.textContent).toContain('Waiting for a reply…')
    expect(container.querySelector('[data-testid="skeleton"]')).toBeNull()
  })

  it('shows a DataText skeleton while pending when content is an empty string', () => {
    const spec: Spec = {
      root: 'page',
      elements: {
        page: { type: 'Page', props: { title: 'Results' }, children: ['body'] },
        body: {
          type: 'DataText',
          props: { statePath: 'content', fallback: 'Waiting for a reply…' },
          children: [],
        },
      },
    }
    const { container } = render({ spec, state: { content: '' }, pending: true })
    expect(container.querySelector('[data-testid="skeleton"]')).toBeTruthy()
    expect(container.textContent).not.toContain('Waiting for a reply…')
  })

  describe('Chat live content', () => {
    const chatSpec: Spec = {
      root: 'page',
      elements: {
        page: { type: 'Page', props: { title: 'Results' }, children: ['chat'] },
        chat: {
          type: 'Chat',
          props: { actionId: 'submit_lead', placeholder: 'Ask a follow-up' },
          children: [],
        },
      },
    }
    const protocol = { submit_lead: { input: true } }

    it('paints streamed content above the composer when the page has no DataText content', () => {
      const { container } = render({
        spec: chatSpec,
        state: { content: '## Hello stream' },
        actionChatProtocol: protocol,
      })

      expect(container.querySelector('[data-testid="generative-chat-transcript"]')).toBeTruthy()
      expect(container.querySelector('h2')?.textContent).toBe('Hello stream')
      expect(container.querySelector('[data-testid="generative-chat"]')).toBeTruthy()
    })

    it('shows left-side typing dots while the Chat action is pending and empty', () => {
      const { container } = render({
        spec: chatSpec,
        state: {},
        pending: true,
        pendingActionIds: new Set(['submit_lead']),
        actionHostKeys: { submit_lead: ['content'] },
        actionChatProtocol: protocol,
      })

      const transcript = container.querySelector('[data-testid="generative-chat-transcript"]')
      const typing = container.querySelector('[data-testid="generative-chat-typing"]')
      const turn = container.querySelector('[data-testid="generative-chat-turn"]')
      expect(transcript).toBeTruthy()
      expect(typing).toBeTruthy()
      expect(turn?.getAttribute('data-role')).toBe('assistant')
      expect(turn?.className).toContain('self-start')
      expect(transcript?.querySelector('[data-testid="skeleton"]')).toBeNull()
    })

    it('shows typing dots in the empty last assistant turn while a follow-up is in flight', () => {
      const { container } = render({
        spec: chatSpec,
        state: {
          chatTurns: [
            { role: 'user', content: 'Hello' },
            { role: 'assistant', content: '' },
          ],
        },
        pending: true,
        pendingActionIds: new Set(['submit_lead']),
        actionChatProtocol: protocol,
      })

      const turns = container.querySelectorAll('[data-testid="generative-chat-turn"]')
      expect(turns).toHaveLength(2)
      expect(turns[1]?.getAttribute('data-role')).toBe('assistant')
      expect(turns[1]?.querySelector('[data-testid="generative-chat-typing"]')).toBeTruthy()
      expect(container.querySelector('[data-testid="skeleton"]')).toBeNull()
    })

    it('shows a visitor error on the last assistant turn', () => {
      const { container } = render({
        spec: chatSpec,
        state: {
          chatTurns: [
            { role: 'user', content: 'Hello' },
            { role: 'assistant', content: '', error: 'This did not go through. Try again.' },
          ],
        },
        actionChatProtocol: protocol,
      })

      expect(container.querySelector('[data-testid="generative-chat-typing"]')).toBeNull()
      expect(
        container.querySelector('[data-testid="generative-chat-turn-error"]')?.textContent
      ).toBe('This did not go through. Try again.')
      expect(container.querySelector('[data-testid="generative-chat-transcript-end"]')).toBeTruthy()
    })

    it('hides typing dots once assistant tokens have arrived', () => {
      const { container } = render({
        spec: chatSpec,
        state: {
          chatTurns: [
            { role: 'user', content: 'Hello' },
            { role: 'assistant', content: 'Partial' },
          ],
        },
        pending: true,
        pendingActionIds: new Set(['submit_lead']),
        actionChatProtocol: protocol,
      })

      expect(container.querySelector('[data-testid="generative-chat-typing"]')).toBeNull()
      expect(container.textContent).toContain('Partial')
    })

    it('does not duplicate content when DataText already binds statePath content', () => {
      const spec: Spec = {
        root: 'page',
        elements: {
          page: { type: 'Page', props: { title: 'Results' }, children: ['body', 'chat'] },
          body: {
            type: 'DataText',
            props: { statePath: 'content', fallback: '' },
            children: [],
          },
          chat: {
            type: 'Chat',
            props: { actionId: 'submit_lead', placeholder: 'Ask a follow-up' },
            children: [],
          },
        },
      }
      const { container } = render({
        spec,
        state: { content: '## Hello stream' },
        actionChatProtocol: protocol,
      })

      expect(container.querySelector('[data-testid="generative-chat-transcript"]')).toBeNull()
      expect(container.querySelector('h2')?.textContent).toBe('Hello stream')
      expect(container.querySelector('[data-testid="generative-chat"]')).toBeTruthy()
    })

    it('hides the transcript when idle and content is empty', () => {
      const { container } = render({
        spec: chatSpec,
        state: {},
        actionChatProtocol: protocol,
      })

      expect(container.querySelector('[data-testid="generative-chat-transcript"]')).toBeNull()
      expect(container.querySelector('[data-testid="generative-chat"]')).toBeTruthy()
    })

    it('submits follow-ups as surface chat', () => {
      const { container, onRunAction } = render({
        spec: chatSpec,
        state: { content: '## Hello stream' },
        actionChatProtocol: protocol,
      })
      const textarea = container.querySelector(
        '[data-testid="generative-chat"] textarea'
      ) as HTMLTextAreaElement
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set

      act(() => {
        setter?.call(textarea, 'Follow up')
        textarea.dispatchEvent(new Event('input', { bubbles: true }))
      })
      act(() => {
        container
          .querySelector('[data-testid="generative-chat"]')
          ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
      })

      expect(onRunAction).toHaveBeenCalledWith(
        'submit_lead',
        expect.objectContaining({ input: 'Follow up', conversationId: expect.any(String) }),
        { surface: 'chat' }
      )
    })

    it('renders appended chatTurns without dropping earlier messages', () => {
      const { container } = render({
        spec: chatSpec,
        state: {
          chatTurns: [
            { role: 'user', content: 'First' },
            { role: 'assistant', content: 'Reply one' },
            { role: 'user', content: 'Second' },
            { role: 'assistant', content: 'Reply two' },
          ],
        },
        actionChatProtocol: protocol,
      })

      const turns = Array.from(container.querySelectorAll('[data-testid="generative-chat-turn"]'))
      expect(turns).toHaveLength(4)
      expect(turns.map((node) => node.getAttribute('data-role'))).toEqual([
        'user',
        'assistant',
        'user',
        'assistant',
      ])
      expect(container.textContent).toContain('First')
      expect(container.textContent).toContain('Reply one')
      expect(container.textContent).toContain('Second')
      expect(container.textContent).toContain('Reply two')
    })

    it('hides DataText content when chatTurns are present so Chat owns the arena', () => {
      const spec: Spec = {
        root: 'page',
        elements: {
          page: { type: 'Page', props: { title: 'Results' }, children: ['body', 'chat'] },
          body: {
            type: 'DataText',
            props: { statePath: 'content', fallback: '' },
            children: [],
          },
          chat: {
            type: 'Chat',
            props: { actionId: 'submit_lead', placeholder: 'Ask a follow-up' },
            children: [],
          },
        },
      }
      const { container } = render({
        spec,
        state: {
          content: 'Latest only',
          chatTurns: [
            { role: 'user', content: 'First' },
            { role: 'assistant', content: 'Reply one' },
          ],
        },
        actionChatProtocol: protocol,
      })

      expect(container.querySelectorAll('[data-testid="generative-chat-turn"]')).toHaveLength(2)
      expect(container.textContent).toContain('First')
      expect(container.textContent).toContain('Reply one')
      const headings = container.querySelectorAll('h2')
      expect(headings.length).toBe(0)
    })
  })

  it('renders a markdown string when DataText is bound to field.content', () => {
    const spec: Spec = {
      root: 'page',
      elements: {
        page: { type: 'Page', props: { title: 'Results' }, children: ['body'] },
        body: {
          type: 'DataText',
          props: {
            statePath: 'artical_data.content',
            fallback: 'No recommendations yet',
          },
          children: [],
        },
      },
    }
    const { container } = render({
      spec,
      state: { artical_data: '# Root Canal Treatment' },
    })
    expect(container.textContent).toContain('Root Canal Treatment')
    expect(container.textContent).not.toContain('No recommendations yet')
  })

  it('renders nested output.content when DataText is bound to content', () => {
    const spec: Spec = {
      root: 'page',
      elements: {
        page: { type: 'Page', props: { title: 'Chat' }, children: ['reply'] },
        reply: {
          type: 'DataText',
          props: { statePath: 'content', fallback: 'Waiting…' },
          children: [],
        },
      },
    }
    const { container } = render({
      spec,
      state: { content: 'Hello from the model' },
    })
    expect(container.textContent).toContain('Hello from the model')
    expect(container.textContent).not.toContain('Waiting…')
  })

  it('renders an object DataText value as nested text, not [object Object]', () => {
    const spec: Spec = {
      root: 'page',
      elements: {
        page: { type: 'Page', props: { title: 'Chat' }, children: ['reply'] },
        reply: {
          type: 'DataText',
          props: { statePath: 'output', fallback: 'Waiting…' },
          children: [],
        },
      },
    }
    const { container } = render({
      spec,
      state: { output: { content: 'Nested reply' } },
    })
    expect(container.textContent).toContain('Nested reply')
    expect(container.textContent).not.toContain('[object Object]')
  })

  it('keeps a DataText JSON payload as prose, not a Table', () => {
    const spec: Spec = {
      root: 'page',
      elements: {
        page: { type: 'Page', props: { title: 'Report' }, children: ['body'] },
        body: {
          type: 'DataText',
          props: { statePath: 'content', fallback: 'Waiting…' },
          children: [],
        },
      },
    }
    const { container } = render({
      spec,
      state: {
        content: JSON.stringify(
          {
            companies: [{ id: '1441', industry: 'Software Development' }],
            tokens: { total: 10 },
            finishReason: 'stop',
          },
          null,
          2
        ),
      },
    })
    expect(container.querySelector('table')).toBeNull()
    expect(container.textContent).toContain('Software Development')
    expect(container.textContent).toContain('1441')
    expect(container.textContent).not.toContain('finishReason')
  })

  it('hides ProgressSteps when not pending', () => {
    const { container } = render({ spec: progressSpec, pending: false })
    expect(container.textContent).not.toContain('Connecting')
  })

  it('defaults Section to the wide cap and drops it for width full', () => {
    const sectionSpec = (width?: string): Spec => ({
      root: 'page',
      elements: {
        page: { type: 'Page', props: {}, children: ['section'] },
        section: { type: 'Section', props: width ? { width } : {}, children: [] },
      },
    })

    const wide = render({ spec: sectionSpec() })
    expect(wide.container.querySelector('section')?.className).toContain('max-w-[1280px]')
    unmount?.()
    unmount = undefined

    const full = render({ spec: sectionSpec('full') })
    expect(full.container.querySelector('section')?.className).toContain('max-w-none')
    expect(full.container.querySelector('section')?.className).not.toContain('max-w-[1280px]')
  })

  it('narrows a SearchField hero Section even when width is wide', () => {
    const spec: Spec = {
      root: 'page',
      elements: {
        page: { type: 'Page', props: {}, children: ['section'] },
        section: {
          type: 'Section',
          props: { width: 'wide' },
          children: ['header', 'search'],
        },
        header: { type: 'PageHeader', props: { title: 'Analyze a company' }, children: [] },
        search: {
          type: 'SearchField',
          props: { name: 'company', placeholder: 'Company name', actionId: 'analyze' },
          children: [],
        },
      },
    }
    const { container } = render({ spec })
    expect(container.querySelector('section')?.className).toContain('max-w-2xl')
    expect(container.querySelector('section')?.className).not.toContain('max-w-[1280px]')
    expect(container.querySelector('[data-testid="task-surface"]')).toBeNull()
    expect(container.querySelector('[data-testid="search-field"]')).toBeTruthy()
  })

  it('does not wrap a SearchField already inside a Card', () => {
    const spec: Spec = {
      root: 'page',
      elements: {
        page: { type: 'Page', props: {}, children: ['section'] },
        section: { type: 'Section', props: {}, children: ['card'] },
        card: { type: 'Card', props: {}, children: ['search'] },
        search: {
          type: 'SearchField',
          props: { name: 'company', placeholder: 'Company name', actionId: 'analyze' },
          children: [],
        },
      },
    }
    const { container } = render({ spec })
    expect(container.querySelector('[data-testid="task-surface"]')).toBeNull()
    expect(
      container.querySelector('[data-testid="card"] [data-testid="search-field"]')
    ).toBeTruthy()
  })

  it('keeps SearchField flush when surface is none', () => {
    const spec: Spec = {
      root: 'page',
      elements: {
        page: { type: 'Page', props: {}, children: ['section'] },
        section: { type: 'Section', props: {}, children: ['search'] },
        search: {
          type: 'SearchField',
          props: {
            name: 'company',
            placeholder: 'Company name',
            actionId: 'analyze',
            surface: 'none',
          },
          children: [],
        },
      },
    }
    const { container } = render({ spec })
    expect(container.querySelector('[data-testid="task-surface"]')).toBeNull()
    expect(container.querySelector('[data-testid="search-field"]')).toBeTruthy()
  })

  it('leaves a Form unwrapped when it is not already in a Card', () => {
    const spec: Spec = {
      root: 'page',
      elements: {
        page: { type: 'Page', props: {}, children: ['section'] },
        section: { type: 'Section', props: {}, children: ['form'] },
        form: { type: 'Form', props: { actionId: 'save' }, children: ['name'] },
        name: { type: 'TextInput', props: { name: 'name', label: 'Name' }, children: [] },
      },
    }
    const { container } = render({ spec })
    expect(container.querySelector('[data-testid="task-surface"]')).toBeNull()
    expect(container.querySelector('form')).toBeTruthy()
  })

  it('keeps a featured Card title at the title type size', () => {
    const spec: Spec = {
      root: 'page',
      elements: {
        page: { type: 'Page', props: {}, children: ['card'] },
        card: { type: 'Card', props: { title: 'Enhance an article' }, children: [] },
      },
    }
    const { container } = render({ spec })
    const title = container.querySelector('[data-testid="card"] h2')
    expect(title?.className).toContain('gui-title-size')
    expect(title?.className).not.toContain('gui-section-size')
  })

  it('maps Repeat item Card titles to the section type size', () => {
    const spec: Spec = {
      root: 'page',
      elements: {
        page: { type: 'Page', props: {}, children: ['list'] },
        list: { type: 'Repeat', props: { statePath: 'history' }, children: ['card'] },
        card: { type: 'Card', props: { title: '{item.url}' }, children: [] },
      },
    }
    const { container } = render({
      spec,
      state: {
        history: [{ url: 'https://news.example.com/long-article-slug' }],
      },
    })
    const title = container.querySelector('[data-testid="card"] h2')
    expect(title?.textContent).toBe('https://news.example.com/long-article-slug')
    expect(title?.className).toContain('gui-section-size')
    expect(title?.className).not.toContain('gui-title-size')
  })

  it('maps Heading h3 to the section type size', () => {
    const spec: Spec = {
      root: 'page',
      elements: {
        page: { type: 'Page', props: {}, children: ['heading'] },
        heading: {
          type: 'Heading',
          props: { text: 'About', level: 'h3', tone: 'muted' },
          children: [],
        },
      },
    }
    const { container } = render({ spec })
    const heading = container.querySelector('h3')
    expect(heading?.className).toContain('gui-section-size')
    expect(heading?.className).not.toContain('gui-title-size')
    expect(heading?.className).toContain('gui-text-muted')
  })

  it('narrows a form-only Section and stretches Form to fill its Card', () => {
    const spec: Spec = {
      root: 'page',
      elements: {
        page: { type: 'Page', props: {}, children: ['section'] },
        section: {
          type: 'Section',
          props: { width: 'wide' },
          children: ['header', 'card'],
        },
        header: { type: 'PageHeader', props: { title: 'Enhance' }, children: [] },
        card: { type: 'Card', props: {}, children: ['form'] },
        form: { type: 'Form', props: { actionId: 'enhance' }, children: ['url', 'submit'] },
        url: {
          type: 'TextInput',
          props: { name: 'url', label: 'Article URL' },
          children: [],
        },
        submit: { type: 'SubmitButton', props: { label: 'Enhance' }, children: [] },
      },
    }
    const { container } = render({ spec })
    expect(container.querySelector('section')?.className).toContain('max-w-2xl')
    expect(container.querySelector('section')?.className).not.toContain('max-w-[1280px]')
    expect(container.querySelector('form')?.className).not.toContain('max-w-(--gui-measure')
    expect(container.querySelector('form')?.className).toContain('w-full')
    expect(container.querySelector('[data-testid="task-surface"]')).toBeNull()
    expect(container.querySelector('input[name="url"]')?.parentElement?.className).toContain(
      'w-full'
    )
  })

  it('keeps a form-only Section full when width is explicitly full', () => {
    const spec: Spec = {
      root: 'page',
      elements: {
        page: { type: 'Page', props: {}, children: ['section'] },
        section: { type: 'Section', props: { width: 'full' }, children: ['form'] },
        form: { type: 'Form', props: { actionId: 'save' }, children: ['name'] },
        name: { type: 'TextInput', props: { name: 'name', label: 'Name' }, children: [] },
      },
    }
    const { container } = render({ spec })
    expect(container.querySelector('section')?.className).toContain('max-w-none')
  })

  it('does not narrow a Section that also has a Table', () => {
    const spec: Spec = {
      root: 'page',
      elements: {
        page: { type: 'Page', props: {}, children: ['section'] },
        section: { type: 'Section', props: { width: 'wide' }, children: ['form', 'table'] },
        form: { type: 'Form', props: { actionId: 'filter' }, children: ['q'] },
        q: { type: 'TextInput', props: { name: 'q', label: 'Query' }, children: [] },
        table: {
          type: 'Table',
          props: { columns: 'Name', rows: 'Ada' },
          children: [],
        },
      },
    }
    const { container } = render({ spec })
    expect(container.querySelector('section')?.className).toContain('max-w-[1280px]')
  })

  it('does not narrow the page Section for a Form inside Modal', () => {
    const spec: Spec = {
      root: 'page',
      elements: {
        page: { type: 'Page', props: {}, children: ['section'] },
        section: { type: 'Section', props: { width: 'wide' }, children: ['open', 'modal'] },
        open: {
          type: 'Button',
          props: { label: 'Create', setValue: 'creating=true' },
          children: [],
        },
        modal: {
          type: 'Modal',
          props: { title: 'Create', showWhen: 'creating' },
          children: ['form'],
        },
        form: { type: 'Form', props: { actionId: 'create' }, children: ['name'] },
        name: { type: 'TextInput', props: { name: 'name', label: 'Name' }, children: [] },
      },
    }
    const { container } = render({ spec, state: { creating: true } })
    expect(container.querySelector('section')?.className).toContain('max-w-[1280px]')
  })

  it('collapses a one-child Columns shell so the Form fills the Card', () => {
    const spec: Spec = {
      root: 'page',
      elements: {
        page: { type: 'Page', props: {}, children: ['section'] },
        section: { type: 'Section', props: { width: 'wide' }, children: ['card'] },
        card: { type: 'Card', props: {}, children: ['columns'] },
        columns: { type: 'Columns', props: { layout: 'equal' }, children: ['form'] },
        form: { type: 'Form', props: { actionId: 'enhance' }, children: ['url'] },
        url: {
          type: 'TextInput',
          props: { name: 'url', label: 'Article URL' },
          children: [],
        },
      },
    }
    const { container } = render({ spec })
    expect(container.querySelector('section')?.className).toContain('max-w-2xl')
    expect(container.querySelector('.md\\:grid-cols-2')).toBeNull()
    expect(container.querySelector('form')?.className).toContain('w-full')
  })

  it('renders Grid with auto-fit template columns sized from columns', () => {
    const spec: Spec = {
      root: 'page',
      elements: {
        page: { type: 'Page', props: {}, children: ['grid'] },
        grid: { type: 'Grid', props: { columns: '3' }, children: ['card'] },
        card: { type: 'Card', props: { title: 'Item' }, children: [] },
      },
    }
    const { container } = render({ spec })
    const grid = container.querySelector('.grid') as HTMLElement
    expect(grid.style.gridTemplateColumns).toBe('repeat(auto-fit, minmax(min(100%, 300px), 1fr))')
  })

  it('renders a two-column Grid inside Form as equal tracks and drops the form measure', () => {
    const spec: Spec = {
      root: 'page',
      elements: {
        page: { type: 'Page', props: {}, children: ['form'] },
        form: { type: 'Form', props: { actionId: 'generate' }, children: ['grid', 'submit'] },
        grid: {
          type: 'Grid',
          props: { columns: '2' },
          children: ['keyword', 'client'],
        },
        keyword: {
          type: 'TextInput',
          props: { name: 'keyword', label: 'Keyword' },
          children: [],
        },
        client: {
          type: 'TextInput',
          props: { name: 'client', label: 'Client' },
          children: [],
        },
        submit: { type: 'SubmitButton', props: { label: 'Generate' }, children: [] },
      },
    }
    const { container } = render({ spec })
    const form = container.querySelector('form')
    expect(form?.className).toContain('w-full')
    expect(form?.className).not.toContain('max-w-(--gui-measure')
    const grid = container.querySelector('.grid') as HTMLElement
    expect(grid.className).toContain('md:grid-cols-2')
    expect(grid.style.gridTemplateColumns).toBe('')
  })

  it('keeps a two-column Grid around a single Form', () => {
    const spec: Spec = {
      root: 'page',
      elements: {
        page: { type: 'Page', props: {}, children: ['grid'] },
        grid: { type: 'Grid', props: { columns: '2' }, children: ['form'] },
        form: { type: 'Form', props: { actionId: 'generate' }, children: ['url'] },
        url: {
          type: 'TextInput',
          props: { name: 'url', label: 'Article URL' },
          children: [],
        },
      },
    }
    const { container } = render({ spec })
    const grid = container.querySelector('.grid') as HTMLElement
    expect(grid.className).not.toContain('grid-cols-1')
    expect(grid.style.gridTemplateColumns.length).toBeGreaterThan(0)
  })

  it('makes a Card a direct child of a horizontal Stack instead of wrapping it in a span', () => {
    const spec: Spec = {
      root: 'page',
      elements: {
        page: { type: 'Page', props: {}, children: ['stack'] },
        stack: {
          type: 'Stack',
          props: { direction: 'horizontal', justify: 'between', wrap: true },
          children: ['card'],
        },
        card: { type: 'Card', props: { title: 'Item' }, children: [] },
      },
    }
    const { container } = render({ spec })
    const stack = container.querySelector('.flex-row') as HTMLElement
    expect(stack.className).toContain('justify-between')
    expect(stack.className).toContain('flex-wrap')
    expect(container.querySelector('span > div')).toBeNull()
    expect(stack.firstElementChild?.tagName).toBe('DIV')
    expect(stack.firstElementChild?.textContent).toContain('Item')
  })

  it('renders Table rows from a statePath array', () => {
    const spec: Spec = {
      root: 'page',
      elements: {
        page: { type: 'Page', props: {}, children: ['table'] },
        table: {
          type: 'Table',
          props: { columns: 'title, score', statePath: 'output.items' },
          children: [],
        },
      },
    }
    const { container } = render({
      spec,
      state: {
        output: {
          items: [
            { title: 'First', score: 9 },
            { title: 'Second', score: 4 },
          ],
        },
      },
    })
    const headers = Array.from(container.querySelectorAll('th')).map((cell) => cell.textContent)
    expect(headers).toEqual(['title', 'score'])
    const rows = Array.from(container.querySelectorAll('tbody tr')).map((row) =>
      Array.from(row.querySelectorAll('td')).map((cell) => cell.textContent)
    )
    expect(rows).toEqual([
      ['First', '9'],
      ['Second', '4'],
    ])
  })

  it('renders static Table rows split on the pipe separator', () => {
    const spec: Spec = {
      root: 'page',
      elements: {
        page: { type: 'Page', props: {}, children: ['table'] },
        table: {
          type: 'Table',
          props: { columns: 'Name, Role', rows: 'Ada | Engineer\nGrace | Admiral' },
          children: [],
        },
      },
    }
    const { container } = render({ spec })
    const rows = Array.from(container.querySelectorAll('tbody tr')).map((row) =>
      Array.from(row.querySelectorAll('td')).map((cell) => cell.textContent)
    )
    expect(rows).toEqual([
      ['Ada', 'Engineer'],
      ['Grace', 'Admiral'],
    ])
  })

  it('renders host rows on a sole Table that authored rows without statePath', () => {
    const spec: Spec = {
      root: 'page',
      elements: {
        page: { type: 'Page', props: {}, children: ['table'] },
        table: {
          type: 'Table',
          props: { columns: 'Name, Role', rows: 'Ada | Engineer' },
          children: [],
        },
      },
    }
    const { container } = render({
      spec,
      state: {
        rows: [
          { Name: 'Ada', Role: 'Engineer' },
          { Name: 'Alan', Role: 'Cryptanalyst' },
        ],
      },
    })
    const rows = Array.from(container.querySelectorAll('tbody tr')).map((row) =>
      Array.from(row.querySelectorAll('td')).map((cell) => cell.textContent)
    )
    expect(rows).toEqual([
      ['Ada', 'Engineer'],
      ['Alan', 'Cryptanalyst'],
    ])
  })

  it('renders host rows on an unpathed Table beside a Repeat collection', () => {
    const spec: Spec = {
      root: 'page',
      elements: {
        page: { type: 'Page', props: {}, children: ['list', 'table'] },
        list: { type: 'Repeat', props: { statePath: 'projects' }, children: ['card'] },
        card: { type: 'Card', props: { title: '{item.name}' }, children: [] },
        table: {
          type: 'Table',
          props: { columns: 'Name, Role', rows: 'Ada | Engineer' },
          children: [],
        },
      },
    }
    const { container } = render({
      spec,
      state: {
        projects: [{ id: 'p1', name: 'Alpha' }],
        rows: [
          { Name: 'Ada', Role: 'Engineer' },
          { Name: 'Alan', Role: 'Cryptanalyst' },
        ],
      },
    })
    const rows = Array.from(container.querySelectorAll('tbody tr')).map((row) =>
      Array.from(row.querySelectorAll('td')).map((cell) => cell.textContent)
    )
    expect(rows).toEqual([
      ['Ada', 'Engineer'],
      ['Alan', 'Cryptanalyst'],
    ])
  })

  it('filters static Table rows locally when SearchField has no actionId', () => {
    const spec: Spec = {
      root: 'page',
      elements: {
        page: { type: 'Page', props: {}, children: ['search', 'hint', 'table'] },
        search: {
          type: 'SearchField',
          props: { name: 'query', placeholder: 'Search tasks...', submitLabel: 'Search' },
          children: [],
        },
        hint: {
          type: 'Chip',
          props: { text: 'pull', setValue: 'query=pull' },
          children: [],
        },
        table: {
          type: 'Table',
          props: {
            columns: 'TASK, STATUS',
            rows: 'Prepare Q3 budget report | Active\nReview pull requests | Active\nSchedule team standup | Completed',
            emptyText: 'No matching tasks.',
          },
          children: [],
        },
      },
    }
    const { container, onRunAction } = render({ spec })
    const chip = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'pull'
    )
    act(() => {
      chip?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    const rows = Array.from(container.querySelectorAll('tbody tr')).map((row) =>
      Array.from(row.querySelectorAll('td')).map((cell) => cell.textContent)
    )
    expect(rows).toEqual([['Review pull requests', 'Active']])
    expect(onRunAction).not.toHaveBeenCalled()
  })

  it('filters static Table rows locally when a Filter Select changes', () => {
    const spec: Spec = {
      root: 'page',
      elements: {
        page: { type: 'Page', props: {}, children: ['filters', 'table'] },
        filters: { type: 'Filter', props: {}, children: ['status'] },
        status: {
          type: 'Select',
          props: { name: 'status', label: 'Status', options: 'All,Active,Completed' },
          children: [],
        },
        table: {
          type: 'Table',
          props: {
            columns: 'TASK, STATUS',
            rows: 'Prepare Q3 budget report | Active\nSchedule team standup | Completed',
          },
          children: [],
        },
      },
    }
    const { container } = render({ spec })
    const hidden = container.querySelector(
      'input[type="hidden"][name="status"]'
    ) as HTMLInputElement
    expect(hidden).toBeTruthy()
    expect(container.querySelector('button[aria-haspopup="listbox"]')?.textContent).toBe(
      'Choose an option'
    )
    chooseSelectOption(container, 'status', 'Completed')
    const rows = Array.from(container.querySelectorAll('tbody tr')).map((row) =>
      Array.from(row.querySelectorAll('td')).map((cell) => cell.textContent)
    )
    expect(rows).toEqual([['Schedule team standup', 'Completed']])
  })

  it('shows Select labels and runs actionId with valueFields on change', () => {
    const spec: Spec = {
      root: 'page',
      elements: {
        page: { type: 'Page', props: {}, children: ['city'] },
        city: {
          type: 'Select',
          props: {
            name: 'city',
            label: 'City',
            defaultValue: 'Bengaluru',
            options: 'Bengaluru|12.9716,77.5946\nLondon|51.5074,-0.1278',
            valueFields: 'latitude,longitude',
            actionId: 'load_forecast',
          },
          children: [],
        },
      },
    }
    const { container, onRunAction } = render({ spec })
    expect(container.querySelector('button[aria-haspopup="listbox"]')?.textContent).toBe(
      'Bengaluru'
    )
    expect(container.textContent).not.toContain('Bengaluru|12.9716')
    chooseSelectOption(container, 'city', 'London')
    expect(onRunAction).toHaveBeenCalledWith(
      'load_forecast',
      expect.objectContaining({
        city: '51.5074,-0.1278',
        latitude: '51.5074',
        longitude: '-0.1278',
      })
    )
  })

  it('does not locally filter when SearchField actionId is a known host action', () => {
    const spec: Spec = {
      root: 'page',
      elements: {
        page: { type: 'Page', props: {}, children: ['search', 'hint', 'table'] },
        search: {
          type: 'SearchField',
          props: { name: 'query', actionId: 'search_tasks', submitLabel: 'Search' },
          children: [],
        },
        hint: {
          type: 'Chip',
          props: { text: 'pull', setValue: 'query=pull' },
          children: [],
        },
        table: {
          type: 'Table',
          props: {
            columns: 'TASK',
            rows: 'Prepare Q3 budget report\nReview pull requests',
          },
          children: [],
        },
      },
    }
    const { container } = render({
      spec,
      actionHostKeys: { search_tasks: ['tasks'] },
    })
    const chip = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'pull'
    )
    act(() => {
      chip?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    const rows = Array.from(container.querySelectorAll('tbody tr')).map((row) =>
      Array.from(row.querySelectorAll('td')).map((cell) => cell.textContent)
    )
    expect(rows).toEqual([['Prepare Q3 budget report'], ['Review pull requests']])
  })

  it('pages a bound Table locally when there is no pagination API', () => {
    const items = Array.from({ length: 25 }, (_, index) => ({
      title: `Row ${index + 1}`,
      score: index + 1,
    }))
    const spec: Spec = {
      root: 'page',
      elements: {
        page: { type: 'Page', props: {}, children: ['table'] },
        table: {
          type: 'Table',
          props: { columns: 'title, score', statePath: 'items' },
          children: [],
        },
      },
    }
    const { container } = render({ spec, state: { items } })
    const cellText = () =>
      Array.from(container.querySelectorAll('tbody tr')).map((row) =>
        Array.from(row.querySelectorAll('td')).map((cell) => cell.textContent)
      )
    expect(cellText()).toHaveLength(20)
    expect(cellText()[0]).toEqual(['Row 1', '1'])
    expect(cellText()[19]).toEqual(['Row 20', '20'])
    expect(container.textContent).toContain('Showing 1–20 of 25')
    const next = container.querySelector('[aria-label="Next page"]') as HTMLButtonElement
    expect(next).toBeTruthy()
    expect(container.querySelector('[aria-label="Previous page"]')).toHaveProperty('disabled', true)
    act(() => {
      next.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(cellText()).toEqual([
      ['Row 21', '21'],
      ['Row 22', '22'],
      ['Row 23', '23'],
      ['Row 24', '24'],
      ['Row 25', '25'],
    ])
    expect(container.textContent).toContain('Showing 21–25 of 25')
    expect(container.querySelector('[aria-label="Next page"]')).toHaveProperty('disabled', true)
  })

  it('hides the local Table pager when a filter leaves a short list', () => {
    const items = [
      ...Array.from({ length: 22 }, (_, index) => ({
        title: `Active ${index + 1}`,
        status: 'Active',
      })),
      { title: 'Done A', status: 'Completed' },
      { title: 'Done B', status: 'Completed' },
      { title: 'Done C', status: 'Completed' },
    ]
    const spec: Spec = {
      root: 'page',
      elements: {
        page: { type: 'Page', props: {}, children: ['filters', 'table'] },
        filters: { type: 'Filter', props: {}, children: ['status'] },
        status: {
          type: 'Select',
          props: { name: 'status', label: 'Status', options: 'All,Active,Completed' },
          children: [],
        },
        table: {
          type: 'Table',
          props: { columns: 'title, status', statePath: 'items' },
          children: [],
        },
      },
    }
    const { container } = render({ spec, state: { items } })
    expect(container.querySelectorAll('tbody tr')).toHaveLength(20)
    expect(container.querySelector('[aria-label="Next page"]')).toBeTruthy()
    chooseSelectOption(container, 'status', 'Completed')
    const rows = Array.from(container.querySelectorAll('tbody tr')).map((row) =>
      Array.from(row.querySelectorAll('td')).map((cell) => cell.textContent)
    )
    expect(rows).toEqual([
      ['Done A', 'Completed'],
      ['Done B', 'Completed'],
      ['Done C', 'Completed'],
    ])
    expect(container.querySelector('[aria-label="Next page"]')).toBeNull()
    expect(container.textContent).not.toContain('Showing')
  })

  it('does not locally page a Table when actionHostKeys include hasMore', () => {
    const items = Array.from({ length: 25 }, (_, index) => ({
      title: `Row ${index + 1}`,
    }))
    const spec: Spec = {
      root: 'page',
      elements: {
        page: { type: 'Page', props: {}, children: ['table'] },
        table: {
          type: 'Table',
          props: { columns: 'title', statePath: 'items' },
          children: [],
        },
      },
    }
    const { container } = render({
      spec,
      state: { items, hasMore: true },
      actionHostKeys: { load_list: ['items', 'hasMore'] },
    })
    expect(container.querySelectorAll('tbody tr')).toHaveLength(25)
    expect(container.querySelector('[aria-label="Next page"]')).toBeNull()
    expect(container.textContent).not.toContain('Showing')
  })

  describe('Repeat', () => {
    const articles = [
      { id: 'a1', title: 'First', score: 9, url: 'https://example.com/a' },
      { id: 'a2', title: 'Second', score: 4, url: 'https://example.com/b' },
    ]

    const repeatSpec: Spec = {
      root: 'page',
      elements: {
        page: { type: 'Page', props: {}, children: ['grid'] },
        grid: { type: 'Grid', props: { columns: '2' }, children: ['repeat'] },
        repeat: { type: 'Repeat', props: { statePath: 'articles' }, children: ['card'] },
        card: {
          type: 'Card',
          props: { title: '{item.title}' },
          children: ['open', 'score'],
        },
        open: {
          type: 'NavLink',
          props: { label: 'Open', to: 'article?id={item.id}' },
          children: [],
        },
        score: {
          type: 'DataText',
          props: { statePath: 'item.score' },
          children: [],
        },
      },
    }

    it('renders one Card per array item as a Grid item', () => {
      const { container } = render({ spec: repeatSpec, state: { articles } })
      const grid = container.querySelector('.grid') as HTMLElement
      expect(grid.className).not.toContain('grid-cols-1')
      expect(grid.style.gridTemplateColumns).toBe('repeat(auto-fit, minmax(min(100%, 520px), 1fr))')
      const wrapper = grid.firstElementChild as HTMLElement
      expect(wrapper.className).toContain('contents')
      const cards = Array.from(wrapper.children)
      expect(cards).toHaveLength(2)
      expect(cards[0]?.querySelector('h2')?.textContent).toBe('First')
      expect(cards[1]?.querySelector('h2')?.textContent).toBe('Second')
      expect(container.textContent).toContain('9')
      expect(container.textContent).toContain('4')
    })

    it('formats ISO dates on card copy and keeps two-column Repeat grids', () => {
      const spec: Spec = {
        root: 'page',
        elements: {
          page: { type: 'Page', props: {}, children: ['grid'] },
          grid: { type: 'Grid', props: { columns: '2' }, children: ['repeat'] },
          repeat: { type: 'Repeat', props: { statePath: 'history' }, children: ['card'] },
          card: {
            type: 'Card',
            props: { title: '{item.keyword}', footerText: '{item.date}' },
            children: [],
          },
        },
      }
      const { container } = render({
        spec,
        state: {
          history: [
            { id: 'h1', keyword: 'Dental implants', date: '2026-08-24T06:28:56.717Z' },
            { id: 'h2', keyword: 'Clear aligners', date: '2026-08-23' },
          ],
        },
      })
      const grid = container.querySelector('.grid') as HTMLElement
      expect(grid.className).not.toContain('grid-cols-1')
      expect(container.textContent).toContain('Aug 23, 2026')
      expect(container.textContent).not.toContain('2026-08-23')
      expect(container.textContent).not.toContain('2026-08-24T06:28:56.717Z')
    })

    it('honours a dateFormat pipe on History card copy', () => {
      const spec: Spec = {
        root: 'page',
        elements: {
          page: { type: 'Page', props: {}, children: ['repeat'] },
          repeat: { type: 'Repeat', props: { statePath: 'history' }, children: ['card'] },
          card: {
            type: 'Card',
            props: { title: '{item.keyword}', footerText: '{item.date|DD/MM/YYYY}' },
            children: [],
          },
        },
      }
      const { container } = render({
        spec,
        state: { history: [{ id: 'h1', keyword: 'Dental implants', date: '2026-08-23' }] },
      })
      expect(container.textContent).toContain('23/08/2026')
      expect(container.textContent).not.toContain('Aug 23, 2026')
    })

    it('honours a currency pipe and Stat numberFormat', () => {
      const spec: Spec = {
        root: 'page',
        elements: {
          page: { type: 'Page', props: {}, children: ['stat', 'repeat'] },
          stat: {
            type: 'Stat',
            props: { label: 'Revenue', statePath: 'revenue', numberFormat: 'currency' },
            children: [],
          },
          repeat: { type: 'Repeat', props: { statePath: 'history' }, children: ['card'] },
          card: {
            type: 'Card',
            props: { title: '{item.keyword}', footerText: '{item.price|currency}' },
            children: [],
          },
        },
      }
      const { container } = render({
        spec,
        state: {
          revenue: 12800,
          history: [{ id: 'h1', keyword: 'Dental implants', price: 1234 }],
        },
      })
      expect(container.textContent).toContain('$12,800.00')
      expect(container.textContent).toContain('$1,234.00')
    })

    it('copies visible markdown from a Copy Markdown host button', async () => {
      const writeText = vi.fn().mockResolvedValue(undefined)
      Object.assign(navigator, { clipboard: { writeText } })
      const spec: Spec = {
        root: 'page',
        elements: {
          page: { type: 'Page', props: {}, children: ['copy', 'body'] },
          copy: {
            type: 'Button',
            props: { label: 'Copy Markdown', copyContent: true },
            children: [],
          },
          body: {
            type: 'DataText',
            props: { statePath: 'content', fallback: '' },
            children: [],
          },
        },
      }
      const { container } = render({
        spec,
        state: { content: '# Dental implants\n\nWriter-ready copy.' },
      })
      const button = container.querySelector(
        '[data-testid="host-copy-markdown"]'
      ) as HTMLButtonElement
      await act(async () => {
        button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })
      expect(writeText).toHaveBeenCalledWith('# Dental implants\n\nWriter-ready copy.')
    })

    it('downloads a PDF from a Download PDF host button', async () => {
      const createObjectURL = vi.fn().mockReturnValue('blob:pdf')
      const revokeObjectURL = vi.fn()
      Object.assign(URL, { createObjectURL, revokeObjectURL })
      const click = vi
        .spyOn(HTMLAnchorElement.prototype, 'click')
        .mockImplementation(() => undefined)
      const spec: Spec = {
        root: 'page',
        elements: {
          page: { type: 'Page', props: {}, children: ['download', 'body'] },
          download: {
            type: 'Button',
            props: { label: 'Download PDF', downloadPdf: true },
            children: [],
          },
          body: {
            type: 'DataText',
            props: { statePath: 'content', fallback: '' },
            children: [],
          },
        },
      }
      const { container } = render({
        spec,
        state: { content: '# Dental implants\n\nWriter-ready copy.' },
      })
      const button = container.querySelector(
        '[data-testid="host-download-pdf"]'
      ) as HTMLButtonElement
      await act(async () => {
        button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })
      expect(createObjectURL).toHaveBeenCalled()
      expect(click).toHaveBeenCalled()
      click.mockRestore()
    })

    it('pages locally when there is no pagination API', () => {
      const manyArticles = Array.from({ length: 25 }, (_, index) => ({
        id: `a${index + 1}`,
        title: `Card ${index + 1}`,
        score: index + 1,
        url: `https://example.com/${index + 1}`,
      }))
      const { container } = render({ spec: repeatSpec, state: { articles: manyArticles } })
      const grid = container.querySelector('.grid') as HTMLElement
      const wrapper = grid.firstElementChild as HTMLElement
      expect(Array.from(wrapper.children)).toHaveLength(20)
      expect(wrapper.children[0]?.querySelector('h2')?.textContent).toBe('Card 1')
      expect(wrapper.children[19]?.querySelector('h2')?.textContent).toBe('Card 20')
      expect(container.textContent).toContain('Showing 1–20 of 25')
      const next = container.querySelector('[aria-label="Next page"]') as HTMLButtonElement
      act(() => {
        next.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })
      const pagedWrapper = (container.querySelector('.grid') as HTMLElement)
        .firstElementChild as HTMLElement
      expect(Array.from(pagedWrapper.children)).toHaveLength(5)
      expect(pagedWrapper.children[0]?.querySelector('h2')?.textContent).toBe('Card 21')
      expect(pagedWrapper.children[4]?.querySelector('h2')?.textContent).toBe('Card 25')
      expect(container.textContent).toContain('Showing 21–25 of 25')
    })

    it('interpolates the row id into in-app navigation so onLoad can fetch that record', () => {
      const { container, onNavigate } = render({ spec: repeatSpec, state: { articles } })
      const links = Array.from(container.querySelectorAll('button')).filter(
        (button) => button.textContent === 'Open'
      )
      act(() => {
        links[1]?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })
      expect(onNavigate).toHaveBeenCalledWith('article?id=a2')
    })

    it('sends the row fields when a Button inside Repeat runs an action', () => {
      const spec: Spec = {
        root: 'page',
        elements: {
          page: { type: 'Page', props: {}, children: ['repeat'] },
          repeat: { type: 'Repeat', props: { statePath: 'articles' }, children: ['run'] },
          run: {
            type: 'Button',
            props: { label: 'Save', actionId: 'save_article' },
            children: [],
          },
        },
      }
      const { container, onRunAction } = render({ spec, state: { articles } })
      const buttons = Array.from(container.querySelectorAll('button')).filter(
        (button) => button.textContent === 'Save'
      )
      act(() => {
        buttons[0]?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })
      expect(onRunAction).toHaveBeenCalledWith(
        'save_article',
        expect.objectContaining({ id: 'a1', title: 'First' })
      )
    })

    it('copies the Repeat row when selectItem is set and does not run an action', () => {
      const spec: Spec = {
        root: 'page',
        elements: {
          page: { type: 'Page', props: {}, children: ['repeat'] },
          repeat: { type: 'Repeat', props: { statePath: 'articles' }, children: ['open'] },
          open: {
            type: 'Button',
            props: { label: 'Open', selectItem: true, navigateTo: 'results' },
            children: [],
          },
        },
      }
      const { container, onNavigate, onRunAction, onSelectItem } = render({
        spec,
        state: { articles },
      })
      const buttons = Array.from(container.querySelectorAll('button')).filter(
        (button) => button.textContent === 'Open'
      )
      act(() => {
        buttons[1]?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })
      expect(onSelectItem).toHaveBeenCalledWith(articles[1], 1)
      expect(onNavigate).toHaveBeenCalledWith('results')
      expect(onRunAction).not.toHaveBeenCalled()
    })

    it('selects the Repeat row when setValue opens the editing overlay', () => {
      const spec: Spec = {
        root: 'page',
        elements: {
          page: { type: 'Page', props: {}, children: ['repeat'] },
          repeat: { type: 'Repeat', props: { statePath: 'articles' }, children: ['edit'] },
          edit: {
            type: 'Button',
            props: { label: 'Edit', setValue: 'editing=true' },
            children: [],
          },
        },
      }
      const { container, onSelectItem, onRunAction } = render({ spec, state: { articles } })
      const buttons = Array.from(container.querySelectorAll('button')).filter(
        (button) => button.textContent === 'Edit'
      )
      act(() => {
        buttons[1]?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })
      expect(onSelectItem).toHaveBeenCalledWith(articles[1], 1)
      expect(onRunAction).not.toHaveBeenCalled()
    })

    it('prefills the edit overlay from the selected Repeat row', () => {
      const spec: Spec = {
        root: 'page',
        elements: {
          page: { type: 'Page', props: {}, children: ['repeat', 'edit_modal'] },
          repeat: { type: 'Repeat', props: { statePath: 'articles' }, children: ['edit'] },
          edit: {
            type: 'Button',
            props: { label: 'Edit', setValue: 'editing=true' },
            children: [],
          },
          edit_modal: {
            type: 'Modal',
            props: { title: 'Edit item', showWhen: 'editing' },
            children: ['edit_form'],
          },
          edit_form: {
            type: 'Form',
            props: { actionId: 'save_item' },
            children: ['title'],
          },
          title: {
            type: 'TextInput',
            props: { name: 'title', label: 'Title' },
            children: [],
          },
        },
      }
      const { container } = render({ spec, state: { articles } })
      const buttons = Array.from(container.querySelectorAll('button')).filter(
        (button) => button.textContent === 'Edit'
      )
      act(() => {
        buttons[1]?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })
      expect((container.querySelector('#field-title') as HTMLInputElement | null)?.value).toBe(
        'Second'
      )
    })

    it('clears the create overlay so it does not keep the last edit', () => {
      const spec: Spec = {
        root: 'page',
        elements: {
          page: {
            type: 'Page',
            props: {},
            children: ['repeat', 'new_item', 'edit_modal', 'create_modal'],
          },
          repeat: { type: 'Repeat', props: { statePath: 'articles' }, children: ['edit'] },
          edit: {
            type: 'Button',
            props: { label: 'Edit', setValue: 'editing=true' },
            children: [],
          },
          new_item: {
            type: 'Button',
            props: { label: 'New', setValue: 'creating=true' },
            children: [],
          },
          edit_modal: {
            type: 'Modal',
            props: { title: 'Edit item', showWhen: 'editing' },
            children: ['edit_title'],
          },
          edit_title: {
            type: 'TextInput',
            props: { name: 'title', label: 'Title' },
            children: [],
          },
          create_modal: {
            type: 'Modal',
            props: { title: 'New item', showWhen: 'creating' },
            children: ['create_title'],
          },
          create_title: {
            type: 'TextInput',
            props: { name: 'title', label: 'Title' },
            children: [],
          },
        },
      }
      const { container } = render({ spec, state: { articles } })
      const editButtons = Array.from(container.querySelectorAll('button')).filter(
        (button) => button.textContent === 'Edit'
      )
      act(() => {
        editButtons[1]?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })
      expect((container.querySelector('#field-title') as HTMLInputElement | null)?.value).toBe(
        'Second'
      )
      const newButton = Array.from(container.querySelectorAll('button')).find(
        (button) => button.textContent === 'New'
      )
      act(() => {
        newButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })
      expect((container.querySelector('#field-title') as HTMLInputElement | null)?.value).toBe('')
    })

    it('hides DataText until showWhen selectedId matches', () => {
      const spec: Spec = {
        root: 'page',
        elements: {
          page: { type: 'Page', props: {}, children: ['body'] },
          body: {
            type: 'DataText',
            props: { statePath: 'content', fallback: '', showWhen: 'selectedId' },
            children: [],
          },
        },
      }
      const hidden = render({ spec, state: { content: '# Hidden report' } })
      expect(hidden.container.textContent).not.toContain('Hidden report')
      unmount?.()

      const shown = render({
        spec,
        state: { content: '# Hidden report', selectedId: 'run_1' },
      })
      expect(shown.container.textContent).toContain('Hidden report')
    })

    it('hides Repeat on a same-page selectItem page while selectedId is set', () => {
      const spec: Spec = {
        root: 'page',
        elements: {
          page: { type: 'Page', props: {}, children: ['repeat', 'detail'] },
          repeat: { type: 'Repeat', props: { statePath: 'articles' }, children: ['open'] },
          open: {
            type: 'Button',
            props: { label: 'Open', selectItem: true },
            children: [],
          },
          detail: {
            type: 'DataText',
            props: { statePath: 'content', fallback: '', showWhen: 'selectedId' },
            children: [],
          },
        },
      }
      const list = render({ spec, state: { articles }, currentPath: 'history' })
      expect(list.container.textContent).toContain('Open')
      expect(list.container.textContent).not.toContain('Hidden report')
      unmount?.()

      const detail = render({
        spec,
        state: { articles, selectedId: 'a1', content: '# Hidden report' },
        currentPath: 'history',
      })
      expect(detail.container.textContent).not.toContain('Open')
      expect(detail.container.textContent).toContain('Hidden report')
    })

    it('keeps a Workspace Repeat visible while selectedId is set', () => {
      const spec: Spec = {
        root: 'page',
        elements: {
          page: { type: 'Page', props: {}, children: ['shell'] },
          shell: {
            type: 'Workspace',
            props: { inspectorWhen: 'selectedId' },
            children: ['navigator', 'primary', 'inspector'],
          },
          navigator: { type: 'Stack', props: {}, children: ['repeat'] },
          repeat: { type: 'Repeat', props: { statePath: 'projects' }, children: ['open'] },
          open: { type: 'Button', props: { label: 'Open', selectItem: true }, children: [] },
          primary: { type: 'Stack', props: {}, children: ['heading'] },
          heading: { type: 'Text', props: { text: 'Tasks stay here' }, children: [] },
          inspector: {
            type: 'DataText',
            props: { statePath: 'content', fallback: 'Select a project.' },
            children: [],
          },
        },
      }
      const { container } = render({
        spec,
        currentPath: 'home',
        state: {
          projects: [{ id: 'p1', name: 'Alpha' }],
          selectedId: 'p1',
          content: 'Project notes',
        },
      })
      expect(container.textContent).toContain('Open')
      expect(container.textContent).toContain('Tasks stay here')
      expect(container.textContent).toContain('Project notes')
    })

    it('narrows a Workspace sibling collection to the selected row', () => {
      const spec: Spec = {
        root: 'page',
        elements: {
          page: { type: 'Page', props: {}, children: ['shell'] },
          shell: {
            type: 'Workspace',
            props: { inspectorWhen: 'selectedId' },
            children: ['navigator', 'primary'],
          },
          navigator: { type: 'Stack', props: {}, children: ['projects'] },
          projects: { type: 'Repeat', props: { statePath: 'projects' }, children: ['open'] },
          open: { type: 'Button', props: { label: 'Open', selectItem: true }, children: [] },
          primary: { type: 'Stack', props: {}, children: ['tasks'] },
          tasks: { type: 'Repeat', props: { statePath: 'tasks' }, children: ['card'] },
          card: { type: 'Card', props: { title: '{item.name}' }, children: [] },
        },
      }
      const { container } = render({
        spec,
        currentPath: 'home',
        state: {
          projects: [
            { id: 'p1', name: 'Alpha' },
            { id: 'p2', name: 'Beta' },
          ],
          tasks: [
            { id: 't1', name: 'Ship Alpha', projectId: 'p1' },
            { id: 't2', name: 'Plan Beta', projectId: 'p2' },
          ],
          selectedId: 'p1',
        },
      })
      expect(container.textContent).toContain('Open')
      expect(container.textContent).toContain('Ship Alpha')
      expect(container.textContent).not.toContain('Plan Beta')
    })

    it('keeps Columns-as-Workspace lists visible and filters the sibling collection', () => {
      const spec: Spec = {
        root: 'page',
        elements: {
          page: { type: 'Page', props: {}, children: ['columns'] },
          columns: {
            type: 'Columns',
            props: { layout: 'sidebar-left' },
            children: ['projects', 'tasks'],
          },
          projects: { type: 'Repeat', props: { statePath: 'projects' }, children: ['open'] },
          open: { type: 'Button', props: { label: 'Open', selectItem: true }, children: [] },
          tasks: { type: 'Repeat', props: { statePath: 'tasks' }, children: ['card'] },
          card: { type: 'Card', props: { title: '{item.name}' }, children: [] },
        },
      }
      const { container } = render({
        spec,
        currentPath: 'home',
        state: {
          projects: [{ id: 'p1', name: 'Alpha' }],
          tasks: [
            { id: 't1', name: 'Ship Alpha', projectId: 'p1' },
            { id: 't2', name: 'Plan Beta', projectId: 'p2' },
          ],
          selectedId: 'p1',
        },
      })
      expect(container.textContent).toContain('Open')
      expect(container.textContent).toContain('Ship Alpha')
      expect(container.textContent).not.toContain('Plan Beta')
    })

    it('lifts Table.rows into Repeat when both share a statePath', () => {
      const spec: Spec = {
        root: 'page',
        elements: {
          page: { type: 'Page', props: {}, children: ['tasks', 'table'] },
          tasks: { type: 'Repeat', props: { statePath: 'tasks' }, children: ['card'] },
          card: { type: 'Card', props: { title: '{item.Name}' }, children: [] },
          table: {
            type: 'Table',
            props: {
              statePath: 'tasks',
              columns: 'Id, Name',
              rows: 't1 | Ship Alpha',
            },
            children: [],
          },
        },
      }
      const { container } = render({ spec, currentPath: 'home', state: {} })
      expect(container.textContent).toContain('Ship Alpha')
    })

    it('narrows dummy Workspace Table.rows by Project Id', () => {
      const spec: Spec = {
        root: 'page',
        elements: {
          page: { type: 'Page', props: {}, children: ['shell'] },
          shell: {
            type: 'Workspace',
            props: { inspectorWhen: 'selectedId' },
            children: ['navigator', 'primary'],
          },
          navigator: { type: 'Stack', props: {}, children: ['projects'] },
          projects: { type: 'Repeat', props: { statePath: 'projects' }, children: ['open'] },
          open: { type: 'Button', props: { label: 'Open', selectItem: true }, children: [] },
          primary: { type: 'Stack', props: {}, children: ['table'] },
          table: {
            type: 'Table',
            props: {
              columns: 'Id, Name, Project Id',
              rows: 't1 | Ship Alpha | p1\nt2 | Plan Beta | p2\nt3 | Review Alpha | p1',
            },
            children: [],
          },
        },
      }
      const { container } = render({
        spec,
        currentPath: 'home',
        state: {
          projects: [{ id: 'p1', name: 'Alpha' }],
          selectedId: 'p1',
        },
      })
      const names = Array.from(container.querySelectorAll('tbody tr')).map(
        (row) => row.querySelectorAll('td')[1]?.textContent
      )
      expect(names).toEqual(['Ship Alpha', 'Review Alpha'])
    })

    it('keeps the Workspace parent filter after a child row is selected', () => {
      const spec: Spec = {
        root: 'page',
        elements: {
          page: { type: 'Page', props: {}, children: ['shell'] },
          shell: {
            type: 'Workspace',
            props: { inspectorWhen: 'selectedId' },
            children: ['navigator', 'primary'],
          },
          navigator: { type: 'Stack', props: {}, children: ['projects'] },
          projects: { type: 'Repeat', props: { statePath: 'projects' }, children: ['open'] },
          open: { type: 'Button', props: { label: 'Open', selectItem: true }, children: [] },
          primary: { type: 'Stack', props: {}, children: ['tasks'] },
          tasks: { type: 'Repeat', props: { statePath: 'tasks' }, children: ['card'] },
          card: { type: 'Card', props: { title: '{item.name}' }, children: [] },
        },
      }
      const { container } = render({
        spec,
        currentPath: 'home',
        state: {
          projects: [
            { id: 'p1', name: 'Alpha' },
            { id: 'p2', name: 'Beta' },
          ],
          tasks: [
            { id: 't1', name: 'Ship Alpha', projectId: 'p1' },
            { id: 't2', name: 'Plan Beta', projectId: 'p2' },
            { id: 't3', name: 'Review Alpha', projectId: 'p1' },
          ],
          selectedId: 't1',
          selected: { id: 't1', name: 'Ship Alpha', projectId: 'p1' },
        },
      })
      expect(container.textContent).toContain('Ship Alpha')
      expect(container.textContent).toContain('Review Alpha')
      expect(container.textContent).not.toContain('Plan Beta')
    })

    it('keeps a Drawer inspect collection visible while selectedId is set', () => {
      const spec: Spec = {
        root: 'page',
        elements: {
          page: { type: 'Page', props: {}, children: ['repeat', 'drawer'] },
          repeat: { type: 'Repeat', props: { statePath: 'tasks' }, children: ['open'] },
          open: { type: 'Button', props: { label: 'Open', selectItem: true }, children: [] },
          drawer: {
            type: 'Drawer',
            props: { showWhen: 'selectedId' },
            children: ['body'],
          },
          body: {
            type: 'DataText',
            props: { statePath: 'content', fallback: '' },
            children: [],
          },
        },
      }
      const { container } = render({
        spec,
        currentPath: 'home',
        state: {
          tasks: [{ id: 't1', name: 'Ship' }],
          selectedId: 't1',
          content: 'Task detail',
        },
      })
      expect(container.textContent).toContain('Open')
      expect(container.textContent).toContain('Task detail')
    })

    it('compiles a missed same-page Open so markdown is not under the list', () => {
      const authored: Spec = {
        root: 'page',
        elements: {
          page: { type: 'Page', props: {}, children: ['repeat', 'body'] },
          repeat: { type: 'Repeat', props: { statePath: 'articles' }, children: ['open'] },
          open: {
            type: 'Button',
            props: { label: 'Open', selectItem: true },
            children: [],
          },
          body: {
            type: 'DataText',
            props: { statePath: 'content', fallback: '' },
            children: [],
          },
        },
      }
      const spec = injectSamePageSelectChrome(authored, 'history')
      const list = render({
        spec,
        state: { articles, content: '# Hidden report' },
        currentPath: 'history',
      })
      expect(list.container.textContent).toContain('Open')
      expect(list.container.textContent).not.toContain('Hidden report')
      expect(list.container.textContent).not.toContain('Back')
      unmount?.()

      const detail = render({
        spec,
        state: { articles, selectedId: 'a1', content: '# Hidden report' },
        currentPath: 'history',
      })
      expect(detail.container.textContent).not.toContain('Open')
      expect(detail.container.textContent).toContain('Hidden report')
      expect(detail.container.textContent).toContain('Back')
    })

    it('calls onClearItem instead of onNavigate when Back targets the current path', () => {
      const spec: Spec = {
        root: 'page',
        elements: {
          page: { type: 'Page', props: {}, children: ['repeat', 'back'] },
          repeat: { type: 'Repeat', props: { statePath: 'articles' }, children: ['open'] },
          open: {
            type: 'Button',
            props: { label: 'Open', selectItem: true },
            children: [],
          },
          back: {
            type: 'Button',
            props: { label: 'Back to history', navigateTo: 'history' },
            children: [],
          },
        },
      }
      const { container, onNavigate, onClearItem } = render({
        spec,
        state: { articles, selectedId: 'a1' },
        currentPath: 'history',
      })
      const back = Array.from(container.querySelectorAll('button')).find(
        (button) => button.textContent === 'Back to history'
      )
      act(() => {
        back?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })
      expect(onClearItem).toHaveBeenCalledTimes(1)
      expect(onNavigate).not.toHaveBeenCalled()
    })

    it('calls onClearItem for a NavLink to the current path while a row is selected', () => {
      const spec: Spec = {
        root: 'page',
        elements: {
          page: { type: 'Page', props: {}, children: ['repeat', 'back'] },
          repeat: { type: 'Repeat', props: { statePath: 'articles' }, children: ['open'] },
          open: {
            type: 'Button',
            props: { label: 'Open', selectItem: true },
            children: [],
          },
          back: {
            type: 'NavLink',
            props: { label: 'Back to history', to: 'history' },
            children: [],
          },
        },
      }
      const { container, onNavigate, onClearItem } = render({
        spec,
        state: { articles, selectedId: 'a1' },
        currentPath: 'history',
      })
      const back = Array.from(container.querySelectorAll('button')).find(
        (button) => button.textContent === 'Back to history'
      )
      act(() => {
        back?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })
      expect(onClearItem).toHaveBeenCalledTimes(1)
      expect(onNavigate).not.toHaveBeenCalled()
    })

    it('clears the copied row when clearItem is set', () => {
      const spec: Spec = {
        root: 'page',
        elements: {
          page: { type: 'Page', props: {}, children: ['back'] },
          back: {
            type: 'Button',
            props: { label: 'Back', clearItem: true, showWhen: 'selectedId' },
            children: [],
          },
        },
      }
      const hidden = render({ spec, state: {} })
      expect(hidden.container.textContent).not.toContain('Back')
      unmount?.()

      const { container, onClearItem, onNavigate } = render({
        spec,
        state: { selectedId: 'run_1' },
      })
      const back = Array.from(container.querySelectorAll('button')).find(
        (button) => button.textContent === 'Back'
      )
      act(() => {
        back?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })
      expect(onClearItem).toHaveBeenCalledTimes(1)
      expect(onNavigate).not.toHaveBeenCalled()
    })

    it('hides a list Section with showWhen !selectedId while a row is selected', () => {
      const spec: Spec = {
        root: 'page',
        elements: {
          page: { type: 'Page', props: {}, children: ['list', 'detail'] },
          list: {
            type: 'Section',
            props: { showWhen: '!selectedId' },
            children: ['repeat'],
          },
          repeat: { type: 'Repeat', props: { statePath: 'articles' }, children: ['card'] },
          card: { type: 'Card', props: { title: '{item.title}' }, children: [] },
          detail: {
            type: 'DataText',
            props: { statePath: 'content', fallback: '', showWhen: 'selectedId' },
            children: [],
          },
        },
      }
      const shown = render({ spec, state: { articles } })
      expect(shown.container.textContent).toContain('First')
      unmount?.()

      const hidden = render({
        spec,
        state: { articles, selectedId: 'a1', content: '# Report' },
      })
      expect(hidden.container.textContent).not.toContain('First')
      expect(hidden.container.textContent).toContain('Report')
    })

    it('hides Repeat, Stack, and Grid when showWhen !selectedId matches', () => {
      const spec: Spec = {
        root: 'page',
        elements: {
          page: { type: 'Page', props: {}, children: ['stack'] },
          stack: {
            type: 'Stack',
            props: { showWhen: '!selectedId' },
            children: ['grid'],
          },
          grid: {
            type: 'Grid',
            props: { showWhen: '!selectedId' },
            children: ['repeat'],
          },
          repeat: {
            type: 'Repeat',
            props: { statePath: 'articles', showWhen: '!selectedId' },
            children: ['card'],
          },
          card: { type: 'Card', props: { title: '{item.title}' }, children: [] },
        },
      }
      const shown = render({ spec, state: { articles } })
      expect(shown.container.textContent).toContain('First')
      unmount?.()

      const hidden = render({
        spec,
        state: { articles, selectedId: 'a1' },
      })
      expect(hidden.container.textContent).not.toContain('First')
    })

    it('renders Repeat rows from nested run_data.history and item.input fields', () => {
      const spec: Spec = {
        root: 'page',
        elements: {
          page: { type: 'Page', props: {}, children: ['repeat'] },
          repeat: { type: 'Repeat', props: { statePath: 'run_data' }, children: ['card'] },
          card: { type: 'Card', props: { title: '{item.keyword}' }, children: [] },
        },
      }
      const { container } = render({
        spec,
        pending: false,
        state: {
          run_data: {
            history: [
              {
                id: 'h1',
                input: { keyword: 'Dental Implants', client: 'Gentle Dental' },
                createdAt: '2026-08-24T06:28:56.717Z',
              },
            ],
          },
        },
      })
      expect(container.querySelector('[data-testid="empty-state"]')).toBeNull()
      expect(container.querySelector('h2')?.textContent).toBe('Dental Implants')
    })

    it('pages a large array so the page cannot mount thousands of Cards', () => {
      const items = Array.from({ length: 60 }, (_, index) => ({
        id: `n${index}`,
        title: `Item ${index}`,
      }))
      const spec: Spec = {
        root: 'page',
        elements: {
          page: { type: 'Page', props: {}, children: ['repeat'] },
          repeat: { type: 'Repeat', props: { statePath: 'items' }, children: ['card'] },
          card: { type: 'Card', props: { title: '{item.title}' }, children: [] },
        },
      }
      const { container } = render({ spec, state: { items } })
      expect(container.querySelectorAll('h2')).toHaveLength(20)
      expect(container.textContent).toContain('Showing 1–20 of 60')
      expect(container.querySelector('[aria-label="Next page"]')).toBeTruthy()
    })

    it('lets an inner Repeat bind to item.comments on the outer row', () => {
      const spec: Spec = {
        root: 'page',
        elements: {
          page: { type: 'Page', props: {}, children: ['posts'] },
          posts: { type: 'Repeat', props: { statePath: 'posts' }, children: ['post'] },
          post: { type: 'Card', props: { title: '{item.title}' }, children: ['comments'] },
          comments: { type: 'Repeat', props: { statePath: 'item.comments' }, children: ['note'] },
          note: { type: 'Text', props: { text: '{item}' }, children: [] },
        },
      }
      const { container } = render({
        spec,
        state: { posts: [{ title: 'Hello', comments: ['nice', 'meh'] }] },
      })
      expect(container.querySelector('h2')?.textContent).toBe('Hello')
      expect(container.textContent).toContain('nice')
      expect(container.textContent).toContain('meh')
    })

    it('shows No results when the array is empty and nothing is pending', () => {
      const { container } = render({ spec: repeatSpec, pending: false, state: { articles: [] } })
      expect(container.querySelector('[data-testid="empty-state"]')?.textContent).toBe('No results')
      expect(container.querySelector('[data-testid="empty-state"]')?.className).not.toContain(
        'border-dashed'
      )
      expect(container.querySelector('h2')).toBeNull()
    })

    it('uses emptyText when the collection is empty', () => {
      const spec: Spec = {
        root: 'page',
        elements: {
          page: { type: 'Page', props: {}, children: ['repeat'] },
          repeat: {
            type: 'Repeat',
            props: { statePath: 'articles', emptyText: 'No matching articles' },
            children: ['card'],
          },
          card: { type: 'Card', props: { title: '{item.title}' }, children: [] },
        },
      }
      const { container } = render({ spec, pending: false, state: { articles: [] } })
      expect(container.querySelector('[data-testid="empty-state"]')?.textContent).toBe(
        'No matching articles'
      )
    })

    it('keeps the skeleton while pending so an empty array is not a false zero-result', () => {
      const { container } = render({ spec: repeatSpec, pending: true, state: { articles: [] } })
      expect(container.querySelector('[data-testid="empty-state"]')).toBeNull()
      expect(container.querySelectorAll('[data-testid="skeleton"]').length).toBeGreaterThan(0)
    })

    it('skeletons two cards when the parent Grid asks for columns 2', () => {
      const { container } = render({ spec: repeatSpec, pending: true, state: { articles: [] } })
      expect(container.querySelectorAll('[data-testid="skeleton"]')).toHaveLength(2)
    })

    it('skeletons four cards when the parent Grid asks for columns 4', () => {
      const wideSpec: Spec = {
        ...repeatSpec,
        elements: {
          ...repeatSpec.elements,
          grid: { type: 'Grid', props: { columns: '4' }, children: ['repeat'] },
        },
      }
      const { container } = render({ spec: wideSpec, pending: true, state: { articles: [] } })
      expect(container.querySelectorAll('[data-testid="skeleton"]')).toHaveLength(4)
    })
  })

  it('navigates to the Tabs item path and marks the active tab', () => {
    const spec: Spec = {
      root: 'page',
      elements: {
        page: { type: 'Page', props: {}, children: ['tabs'] },
        tabs: {
          type: 'Tabs',
          props: { items: 'Home|home\nReports|reports', activePath: 'home' },
          children: [],
        },
      },
    }
    const { container, onNavigate, onClearSelection } = render({
      spec,
      currentPath: 'home',
      state: { selectedId: 'run_1', content: '# Kept' },
    })
    const buttons = Array.from(container.querySelectorAll('nav button'))
    expect(buttons.map((button) => button.textContent)).toEqual(['Home', 'Reports'])
    expect(buttons[0]?.className).toContain('font-medium')
    expect(buttons[0]?.getAttribute('aria-current')).toBe('page')
    expect(buttons[1]?.getAttribute('aria-current')).toBeNull()
    act(() => {
      buttons[1]?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(onClearSelection).toHaveBeenCalled()
    expect(onNavigate).toHaveBeenCalledWith('reports')
  })

  it('renders PageHeader title, subtitle, and trailing action', () => {
    const spec: Spec = {
      root: 'page',
      elements: {
        page: { type: 'Page', props: {}, children: ['header'] },
        header: {
          type: 'PageHeader',
          props: { title: 'Recommendations', subtitle: 'Ranked for you' },
          children: ['cta'],
        },
        cta: { type: 'Button', props: { label: 'Refresh', navigateTo: 'home' }, children: [] },
      },
    }
    const { container } = render({ spec })
    expect(container.querySelector('h1')?.textContent).toBe('Recommendations')
    expect(container.textContent).toContain('Ranked for you')
    expect(container.textContent).toContain('Refresh')
  })

  it('renders AppHeader as a sticky full-bleed bar with the Arena logo and title', () => {
    const spec: Spec = {
      root: 'page',
      elements: {
        page: { type: 'Page', props: {}, children: ['chrome', 'section'] },
        chrome: {
          type: 'AppHeader',
          props: { title: 'Company Research AI', icon: 'spark' },
          children: [],
        },
        section: {
          type: 'Section',
          props: { width: 'wide' },
          children: ['hero'],
        },
        hero: {
          type: 'PageHeader',
          props: { title: 'Research any company', align: 'center' },
          children: [],
        },
      },
    }
    const { container } = render({ spec })
    const header = container.querySelector('[data-testid="app-header"]') as HTMLElement
    expect(header).toBeTruthy()
    expect(header.textContent).toContain('Company Research AI')
    expect(header.className).toContain('sticky')
    expect(header.className).toContain('top-0')
    expect(header.className).toContain('z-20')
    expect(header.className).toContain('bg-(--gui-surface,#ffffff)')
    expect(header.querySelector('[data-testid="app-header-logo"]')).toBeTruthy()
    expect(header.querySelector('[data-testid="app-header-mark"]')).toBeNull()
    const inner = header.firstElementChild as HTMLElement
    expect(inner?.className).toContain('px-4')
    const section = container.querySelector('section')
    expect(section?.contains(header)).toBe(false)
    expect(container.querySelector('h1')?.textContent).toBe('Research any company')
  })

  it('hoists a brand row out of Section so it cannot sit under scrolling content', () => {
    const spec: Spec = {
      root: 'page',
      elements: {
        page: { type: 'Page', props: {}, children: ['section'] },
        section: {
          type: 'Section',
          props: { width: 'wide' },
          children: ['brand', 'hero'],
        },
        brand: {
          type: 'Stack',
          props: { direction: 'horizontal', align: 'center', justify: 'between', gap: 'sm' },
          children: ['logo', 'name'],
        },
        logo: { type: 'Icon', props: { name: 'spark', well: 'square' }, children: [] },
        name: {
          type: 'Heading',
          props: { text: 'Company Research AI', level: 'h2' },
          children: [],
        },
        hero: {
          type: 'PageHeader',
          props: { title: 'Research any company', align: 'center' },
          children: [],
        },
      },
    }
    const { container } = render({ spec })
    const header = container.querySelector('[data-testid="app-header"]') as HTMLElement
    expect(header).toBeTruthy()
    expect(header.className).toContain('sticky')
    expect(header.className).toContain('z-20')
    expect(header.textContent).toContain('Company Research AI')
    expect(header.querySelector('[data-testid="app-header-logo"]')).toBeTruthy()
    const section = container.querySelector('section')
    expect(section?.contains(header)).toBe(false)
    expect(section?.textContent).toContain('Research any company')
    expect(section?.querySelector('h2')).toBeNull()
  })

  it('renders Stat and KeyValue values from host state', () => {
    const spec: Spec = {
      root: 'page',
      elements: {
        page: { type: 'Page', props: {}, children: ['stat', 'details'] },
        stat: {
          type: 'Stat',
          props: { label: 'Matches', statePath: 'output.count', hint: 'this week' },
          children: [],
        },
        details: {
          type: 'KeyValue',
          props: { statePath: 'output.meta' },
          children: [],
        },
      },
    }
    const { container } = render({
      spec,
      state: { output: { count: 42, meta: { source: 'arena' } } },
    })
    expect(container.textContent).toContain('Matches')
    expect(container.textContent).toContain('42')
    expect(container.textContent).toContain('this week')
    expect(container.querySelector('dt')?.textContent).toBe('source')
    expect(container.querySelector('dd')?.textContent).toBe('arena')
  })

  it('formats nested KeyValue arrays as a list and object rows as a table', () => {
    const spec: Spec = {
      root: 'page',
      elements: {
        page: { type: 'Page', props: {}, children: ['details'] },
        details: {
          type: 'KeyValue',
          props: { statePath: 'coverage_report' },
          children: [],
        },
      },
    }
    const { container } = render({
      spec,
      state: {
        coverage_report: {
          faq_added: true,
          faq_questions_added: ['How much did Nvidia invest directly in OpenAI?'],
          citations_count: 10,
          citations_found: [
            {
              claim: 'Nvidia mobilised capital.',
              source_name: 'NVIDIA',
              source_url: 'https://investor.nvidia.com/example',
            },
          ],
        },
      },
    })
    expect(container.textContent).toContain('Yes')
    expect(container.textContent).not.toContain('["How much')
    expect(container.querySelector('ul')?.textContent).toContain(
      'How much did Nvidia invest directly in OpenAI?'
    )
    expect(container.querySelector('table')?.textContent).toContain('Nvidia mobilised capital.')
    expect(container.querySelector('a')?.getAttribute('href')).toBe(
      'https://investor.nvidia.com/example'
    )
  })

  it('renders Card description under the title', () => {
    const spec: Spec = {
      root: 'page',
      elements: {
        page: { type: 'Page', props: {}, children: ['card'] },
        card: {
          type: 'Card',
          props: { title: 'System parameters', description: 'Configure the next run.' },
          children: [],
        },
      },
    }
    const { container } = render({ spec })
    expect(container.querySelector('h2')?.textContent).toBe('System parameters')
    expect(container.textContent).toContain('Configure the next run.')
  })

  it('renders a Stat delta with a tone class', () => {
    const spec: Spec = {
      root: 'page',
      elements: {
        page: { type: 'Page', props: {}, children: ['up', 'down'] },
        up: {
          type: 'Stat',
          props: { label: 'Reports', value: '12,480', delta: '+14.2%', deltaTone: 'positive' },
          children: [],
        },
        down: {
          type: 'Stat',
          props: { label: 'Errors', value: '3', delta: '-2', deltaTone: 'negative' },
          children: [],
        },
      },
    }
    const { container } = render({ spec })
    expect(container.textContent).toContain('+14.2%')
    const tones = Array.from(container.querySelectorAll('span')).map((node) => node.className)
    expect(tones.some((name) => name.includes('text-(--gui-success-text,#23784f)'))).toBe(true)
    expect(tones.some((name) => name.includes('text-(--gui-error-text,#921010)'))).toBe(true)
  })

  it('renders a Sparkline from comma-separated values', () => {
    const spec: Spec = {
      root: 'page',
      elements: {
        page: { type: 'Page', props: {}, children: ['chart'] },
        chart: {
          type: 'Sparkline',
          props: { values: '1, 3, 2', label: 'Weekly orders' },
          children: [],
        },
      },
    }
    const { container } = render({ spec })
    expect(container.querySelector('[data-testid="sparkline"]')?.textContent).toContain(
      'Weekly orders'
    )
    expect(container.querySelector('polyline')?.getAttribute('points')).toBeTruthy()
  })

  it('renders a Chart from dummy categories and values', () => {
    const spec: Spec = {
      root: 'page',
      elements: {
        page: { type: 'Page', props: {}, children: ['chart'] },
        chart: {
          type: 'Chart',
          props: {
            title: 'Spend',
            chartType: 'bar',
            categories: 'Mon, Tue',
            values: '10, 20',
          },
          children: [],
        },
      },
    }
    const { container } = render({ spec })
    expect(container.querySelector('[data-testid="chart"]')).toBeTruthy()
    expect(container.querySelector('[aria-label="Spend"]')).toBeTruthy()
  })

  it('renders Chart empty copy when the bound path has no rows', () => {
    const spec: Spec = {
      root: 'page',
      elements: {
        page: { type: 'Page', props: {}, children: ['chart'] },
        chart: {
          type: 'Chart',
          props: {
            chartType: 'line',
            statePath: 'daily',
            emptyText: 'No volume yet.',
          },
          children: [],
        },
      },
    }
    const { container } = render({ spec, state: { daily: [] } })
    expect(container.textContent).toContain('No volume yet.')
  })

  it('renders EmptyState with title and body', () => {
    const spec: Spec = {
      root: 'page',
      elements: {
        page: { type: 'Page', props: {}, children: ['empty'] },
        empty: {
          type: 'EmptyState',
          props: { title: 'No orders yet', body: 'New orders will show up here.', icon: 'inbox' },
          children: [],
        },
      },
    }
    const { container } = render({ spec })
    expect(container.querySelector('[data-testid="empty-state"]')?.textContent).toContain(
      'No orders yet'
    )
    expect(container.textContent).toContain('New orders will show up here.')
    expect(container.querySelector('[data-testid="empty-state"]')?.className).toContain(
      'gui-measure'
    )
  })

  it('renders Combobox as a searchable listbox and FileInput under a non-reserved name', () => {
    const spec: Spec = {
      root: 'page',
      elements: {
        page: { type: 'Page', props: {}, children: ['form'] },
        form: { type: 'Form', props: { actionId: 'save' }, children: ['role', 'resume'] },
        role: {
          type: 'Combobox',
          props: { name: 'role', label: 'Role', options: 'Analyst, Operator, Admin' },
          children: [],
        },
        resume: {
          type: 'FileInput',
          props: { name: 'resume', label: 'Resume', accept: '.pdf' },
          children: [],
        },
      },
    }
    const { container } = render({ spec })
    expect(container.querySelector('input[aria-label="Search options"]')).toBeNull()
    const trigger = container.querySelector('button[aria-haspopup="listbox"]') as HTMLButtonElement
    act(() => {
      trigger.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(container.querySelector('input[aria-label="Search options"]')).toBeTruthy()
    expect(container.querySelector('input[type="file"][name="resume"]')).toBeTruthy()
    expect(container.querySelector('input[type="file"][name="files"]')).toBeNull()
  })

  it('maps new catalog icons onto Lucide glyphs', () => {
    const spec: Spec = {
      root: 'page',
      elements: {
        page: { type: 'Page', props: {}, children: ['icon'] },
        icon: { type: 'Icon', props: { name: 'plus' }, children: [] },
      },
    }
    const { container } = render({ spec })
    expect(container.querySelector('svg')).toBeTruthy()
  })

  it('hides catalog EmptyState while the page is pending', () => {
    const spec: Spec = {
      root: 'page',
      elements: {
        page: { type: 'Page', props: {}, children: ['empty'] },
        empty: {
          type: 'EmptyState',
          props: { title: 'No results', body: 'Try again later.' },
          children: [],
        },
      },
    }
    const { container } = render({ spec, pending: true })
    expect(container.querySelector('[data-testid="empty-state"]')).toBeNull()
  })

  it('paints a circular loader instead of skeletons when uxPlan asks', () => {
    const spec: Spec = {
      root: 'page',
      elements: {
        page: { type: 'Page', props: {}, children: ['repeat'] },
        repeat: {
          type: 'Repeat',
          props: { statePath: 'items', emptyText: 'None' },
          children: ['card'],
        },
        card: { type: 'Card', props: { title: '{item.title}' }, children: [] },
      },
    }
    const { container } = render({
      spec,
      pending: true,
      state: { items: [] },
      uxPlan: { actions: {}, fallbackLoading: {}, loadingChrome: 'spinner' },
    })
    expect(container.querySelector('[data-testid="circular-loader"]')).toBeTruthy()
    expect(container.querySelector('[data-testid="skeleton"]')).toBeNull()
  })

  it('renders EmptyState children as the next useful action', () => {
    const spec: Spec = {
      root: 'page',
      elements: {
        page: { type: 'Page', props: {}, children: ['empty'] },
        empty: {
          type: 'EmptyState',
          props: { title: 'No companies yet', body: 'Search to add the first one.' },
          children: ['go'],
        },
        go: { type: 'Button', props: { label: 'Search companies' }, children: [] },
      },
    }
    const { container } = render({ spec })
    expect(container.querySelector('[data-testid="empty-state"]')?.textContent).toContain(
      'Search companies'
    )
    const action = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Search companies'
    )
    expect(action).toBeTruthy()
  })

  describe('skeletons', () => {
    const skeletonSpec = (type: string, props: Record<string, unknown>): Spec => ({
      root: 'page',
      elements: {
        page: { type: 'Page', props: {}, children: ['target'] },
        target: { type, props, children: [] },
      },
    })

    function skeletonCount(container: HTMLElement): number {
      return container.querySelectorAll('[data-testid="skeleton"]').length
    }

    it('hides an explicit Skeleton when not pending and shows it while pending', () => {
      const spec = skeletonSpec('Skeleton', { variant: 'card', lines: 3 })

      const idle = render({ spec, pending: false })
      expect(skeletonCount(idle.container)).toBe(0)
      unmount?.()
      unmount = undefined

      const busy = render({ spec, pending: true })
      expect(skeletonCount(busy.container)).toBe(1)
    })

    it('honours the Skeleton lines count', () => {
      const { container } = render({
        spec: skeletonSpec('Skeleton', { variant: 'text', lines: 5 }),
        pending: true,
      })
      const skeleton = container.querySelector('[data-testid="skeleton"]') as HTMLElement
      expect(skeleton.querySelectorAll('.animate-pulse').length).toBe(5)
    })

    it.each([
      ['Table', { statePath: 'articles', columns: 'title' }],
      ['Repeat', { statePath: 'articles' }],
      ['Stat', { label: 'Articles ranked', statePath: 'count' }],
      ['KeyValue', { statePath: 'meta' }],
      ['DataText', { statePath: 'summary' }],
      ['Chart', { chartType: 'line', statePath: 'orderVolume' }],
    ])('auto-skeletons a bound %s while pending with no data', (type, props) => {
      const spec =
        type === 'Repeat'
          ? ({
              root: 'page',
              elements: {
                page: { type: 'Page', props: {}, children: ['target'] },
                target: { type: 'Repeat', props, children: ['card'] },
                card: { type: 'Card', props: { title: '{item.title}' }, children: [] },
              },
            } as Spec)
          : skeletonSpec(type, props)
      const { container } = render({ spec, pending: true, state: {} })
      expect(skeletonCount(container)).toBeGreaterThan(0)
    })

    it.each([
      ['Table', { statePath: 'articles', columns: 'title' }, { articles: [{ title: 'First' }] }],
      ['Stat', { label: 'Articles ranked', statePath: 'count' }, { count: 3 }],
      ['KeyValue', { statePath: 'meta' }, { meta: { source: 'arena' } }],
      ['DataText', { statePath: 'summary' }, { summary: 'All done' }],
    ])('drops the %s skeleton once data arrives', (type, props, state) => {
      const { container } = render({ spec: skeletonSpec(type, props), pending: true, state })
      expect(skeletonCount(container)).toBe(0)
    })

    it('keeps a populated Table visible and busy while it refetches', () => {
      const { container } = render({
        spec: skeletonSpec('Table', { statePath: 'articles', columns: 'title' }),
        pending: true,
        state: { articles: [{ title: 'Kept row' }] },
      })
      expect(skeletonCount(container)).toBe(0)
      expect(container.textContent).toContain('Kept row')
      expect(container.querySelector('[aria-busy="true"]')).toBeTruthy()
      expect(container.querySelector('[data-testid="refetch-busy"]')?.textContent).toContain(
        'Updating'
      )
    })

    it('leaves an unbound Table alone while pending', () => {
      const { container } = render({
        spec: skeletonSpec('Table', { columns: 'Name', rows: 'Ada' }),
        pending: true,
      })
      expect(skeletonCount(container)).toBe(0)
      expect(container.querySelector('table')).toBeTruthy()
    })

    it('does not auto-skeleton a bound region when nothing is pending', () => {
      const { container } = render({
        spec: skeletonSpec('Table', { statePath: 'articles', columns: 'title' }),
        pending: false,
        state: {},
      })
      expect(skeletonCount(container)).toBe(0)
    })

    it('skeletons only the region the in-flight action writes', () => {
      const spec: Spec = {
        root: 'page',
        elements: {
          page: { type: 'Page', props: {}, children: ['table', 'stat'] },
          table: {
            type: 'Table',
            props: { statePath: 'articles', columns: 'title' },
            children: [],
          },
          stat: { type: 'Stat', props: { label: 'Count', statePath: 'count' }, children: [] },
        },
      }
      const actionHostKeys = {
        load_list: ['articles'],
        load_stats: ['count'],
      }
      const { container } = render({
        spec,
        pending: true,
        pendingActionIds: new Set(['load_list']),
        actionHostKeys,
        state: {},
      })
      expect(skeletonCount(container)).toBe(1)
      expect(container.textContent).toContain('Count')
    })

    it('does not disable an unrelated action button while another CTA is pending', () => {
      const spec: Spec = {
        root: 'page',
        elements: {
          page: { type: 'Page', props: {}, children: ['run', 'refresh'] },
          run: { type: 'Button', props: { label: 'Run', actionId: 'run' }, children: [] },
          refresh: {
            type: 'Button',
            props: { label: 'Refresh', actionId: 'refresh' },
            children: [],
          },
        },
      }
      const { container } = render({
        spec,
        pending: true,
        pendingActionIds: new Set(['run']),
        actionHostKeys: { run: ['content'], refresh: ['articles'] },
      })
      const run = Array.from(container.querySelectorAll('button')).find((button) =>
        button.textContent?.includes('Run')
      )
      const refresh = Array.from(container.querySelectorAll('button')).find((button) =>
        button.textContent?.includes('Refresh')
      )
      expect(run?.disabled).toBe(true)
      expect(refresh?.disabled).toBe(false)
    })

    it('skeletons a pending DataText even when it declares a fallback', () => {
      const spec = skeletonSpec('DataText', {
        statePath: 'summary',
        fallback: 'Run the report to see a summary.',
      })

      const busy = render({ spec, pending: true, state: {} })
      expect(skeletonCount(busy.container)).toBe(1)
      expect(busy.container.textContent).not.toContain('Run the report')
      unmount?.()
      unmount = undefined

      const idle = render({ spec, pending: false, state: {} })
      expect(skeletonCount(idle.container)).toBe(0)
      expect(idle.container.textContent).toContain('Run the report')
    })
  })

  describe('empty states', () => {
    it('shows No results for a bound Table whose array is empty', () => {
      const spec: Spec = {
        root: 'page',
        elements: {
          page: { type: 'Page', props: {}, children: ['table'] },
          table: {
            type: 'Table',
            props: { statePath: 'articles', columns: 'title' },
            children: [],
          },
        },
      }
      const { container } = render({ spec, pending: false, state: { articles: [] } })
      expect(container.querySelector('table')).toBeNull()
      expect(container.querySelector('[data-testid="empty-state"]')?.textContent).toBe('No results')
    })

    it('shows No details for a bound KeyValue whose object is empty', () => {
      const spec: Spec = {
        root: 'page',
        elements: {
          page: { type: 'Page', props: {}, children: ['details'] },
          details: { type: 'KeyValue', props: { statePath: 'meta' }, children: [] },
        },
      }
      const { container } = render({ spec, pending: false, state: { meta: {} } })
      expect(container.querySelector('dl')).toBeNull()
      expect(container.querySelector('[data-testid="empty-state"]')?.textContent).toBe('No details')
    })

    it('uses Table emptyText instead of the default collection copy', () => {
      const spec: Spec = {
        root: 'page',
        elements: {
          page: { type: 'Page', props: {}, children: ['table'] },
          table: {
            type: 'Table',
            props: { statePath: 'articles', columns: 'title', emptyText: 'No matching articles' },
            children: [],
          },
        },
      }
      const { container } = render({ spec, pending: false, state: { articles: [] } })
      expect(container.querySelector('[data-testid="empty-state"]')?.textContent).toBe(
        'No matching articles'
      )
    })

    it('leaves a static Table with no statePath as a table, not an empty state', () => {
      const spec: Spec = {
        root: 'page',
        elements: {
          page: { type: 'Page', props: {}, children: ['table'] },
          table: {
            type: 'Table',
            props: { columns: 'Name', rows: 'Ada' },
            children: [],
          },
        },
      }
      const { container } = render({ spec, pending: false, state: {} })
      expect(container.querySelector('table')).toBeTruthy()
      expect(container.querySelector('[data-testid="empty-state"]')).toBeNull()
    })
  })

  describe('centring', () => {
    it('centres a search row and its submit button through Stack and Form align', () => {
      const { container } = render({
        spec: {
          root: 'page',
          elements: {
            page: { type: 'Page', props: {}, children: ['form'] },
            form: {
              type: 'Form',
              props: { actionId: 'search', align: 'center' },
              children: ['row'],
            },
            row: {
              type: 'Stack',
              props: { direction: 'horizontal', justify: 'center', align: 'end' },
              children: ['query', 'submit'],
            },
            query: { type: 'TextInput', props: { name: 'query', label: 'Query' }, children: [] },
            submit: { type: 'SubmitButton', props: { label: 'Search' }, children: [] },
          },
        },
      })

      const form = container.querySelector('form') as HTMLElement
      expect(form.className).toContain('items-center')
      const row = form.firstElementChild as HTMLElement
      expect(row.className).toContain('flex-row')
      expect(row.className).toContain('justify-center')
      expect(row.className).toContain('items-end')
    })

    it('leaves a form stretched by default', () => {
      const { container } = render()
      const form = container.querySelector('form') as HTMLElement
      expect(form.className).toContain('items-stretch')
      expect(form.className).not.toContain('items-center')
    })
  })

  describe('Button emphasis', () => {
    function buttonSpec(props: Record<string, unknown>): Spec {
      return {
        root: 'page',
        elements: {
          page: { type: 'Page', props: { title: 'Home' }, children: ['action'] },
          action: { type: 'Button', props, children: [] },
        },
      }
    }

    function renderButton(props: Record<string, unknown>, pending = false) {
      const { container } = render({ spec: buttonSpec(props), pending })
      return container.querySelector('button') as HTMLButtonElement
    }

    it('defaults to the secondary variant so pages are not a wall of primaries', () => {
      const button = renderButton({ label: 'Export', navigateTo: 'report' })
      expect(button.className).toContain('border')
      expect(button.className).not.toContain('bg-(--gui-brand,#1a73e8)')
    })

    it('renders the primary variant as a filled button', () => {
      const button = renderButton({ label: 'Run', actionId: 'run', variant: 'primary' })
      expect(button.className).toContain('bg-(--gui-brand,#1a73e8)')
      expect(button.className).toContain('gui-text-on-brand')
    })

    it('renders the destructive variant as outline danger, not a filled CTA', () => {
      const button = renderButton({ label: 'Delete', actionId: 'del', variant: 'destructive' })
      expect(button.className).toContain('border-(--gui-danger,#f31a1a)')
      expect(button.className).toContain('text-(--gui-danger,#f31a1a)')
      expect(button.className).not.toContain('bg-(--gui-danger,#f31a1a)')
    })

    it('asks the host to confirm a destructive action instead of navigating first', () => {
      const { container, onNavigate, onRunAction } = render({
        spec: buttonSpec({
          label: 'Delete',
          actionId: 'del',
          navigateTo: 'home',
          variant: 'destructive',
        }),
      })
      const button = container.querySelector('button') as HTMLButtonElement
      act(() => {
        button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })
      expect(onNavigate).not.toHaveBeenCalled()
      expect(onRunAction).toHaveBeenCalledWith('del', expect.any(Object), { destructive: true })
    })

    it('asks the host to confirm when uxPlan.confirm is true even without a destructive variant', () => {
      const { container, onNavigate, onRunAction } = render({
        spec: buttonSpec({ label: 'Save', actionId: 'save', variant: 'secondary' }),
        uxPlan: {
          actions: { save: { kind: 'mutation', confirm: true, retry: true } },
          fallbackLoading: {},
        },
      })
      const button = container.querySelector('button') as HTMLButtonElement
      act(() => {
        button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })
      expect(onNavigate).not.toHaveBeenCalled()
      expect(onRunAction).toHaveBeenCalledWith('save', expect.any(Object), { destructive: true })
    })

    it('does not confirm a destructive-looking button when uxPlan.confirm is false', () => {
      const { container, onNavigate, onRunAction } = render({
        spec: buttonSpec({
          label: 'Delete',
          actionId: 'del',
          navigateTo: 'home',
          variant: 'destructive',
        }),
        uxPlan: {
          actions: { del: { kind: 'mutation', confirm: false, retry: true } },
          fallbackLoading: {},
        },
      })
      const button = container.querySelector('button') as HTMLButtonElement
      act(() => {
        button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })
      expect(onNavigate).toHaveBeenCalledWith('home')
      expect(onRunAction).toHaveBeenCalledWith('del', expect.any(Object))
      expect(onRunAction.mock.calls[0]?.[2]).toBeUndefined()
    })

    it('does not disable an action omitted from uxPlan while pending', () => {
      const { container } = render({
        spec: buttonSpec({ label: 'Run', actionId: 'run' }),
        pending: true,
        uxPlan: { actions: {}, fallbackLoading: {} },
      })
      expect((container.querySelector('button') as HTMLButtonElement).disabled).toBe(false)
    })

    it('renders the ghost variant without a border or fill', () => {
      const button = renderButton({ label: 'Back', navigateTo: 'home', variant: 'ghost' })
      expect(button.className).not.toContain('border-(--gui-border')
      expect(button.className).not.toContain('bg-(--gui-danger,#f31a1a)')
      expect(button.className).not.toContain('bg-(--gui-brand,#1a73e8)')
    })

    it('renders the outline pill variant with a brand border', () => {
      const button = renderButton({
        label: 'View analysis history',
        navigateTo: 'results',
        variant: 'outline',
        shape: 'pill',
      })
      expect(button.className).toContain('border-(--gui-brand,#1a73e8)')
      expect(button.className).toContain('rounded-(--gui-radius-pill)')
      expect(button.className).not.toContain('bg-(--gui-brand,#1a73e8)')
    })

    it('applies the small size', () => {
      const button = renderButton({ label: 'Filter', actionId: 'filter', size: 'sm' })
      expect(button.className).toContain('h-8')
    })

    it('never leaks a size token into the inline font size', () => {
      const button = renderButton({ label: 'Filter', actionId: 'filter', size: 'sm' })
      expect(button.style.fontSize).toBe('')
    })

    it('keeps a navigation-only button clickable while another action is pending', () => {
      const button = renderButton({ label: 'Back', navigateTo: 'home' }, true)
      expect(button.disabled).toBe(false)
    })

    it('disables an action button while an action is pending', () => {
      const button = renderButton({ label: 'Run', actionId: 'run' }, true)
      expect(button.disabled).toBe(true)
    })

    it('hides a Load more button when hasMore is false', () => {
      const { container } = render({
        spec: buttonSpec({ label: 'Load more', actionId: 'load_list', showWhen: 'hasMore' }),
        state: { hasMore: false },
      })
      expect(container.querySelector('button')).toBeNull()
    })

    it('shows a Load more button when hasMore is true', () => {
      const { container } = render({
        spec: buttonSpec({ label: 'Load more', actionId: 'load_list', showWhen: 'hasMore' }),
        state: { hasMore: true, nextCursor: 'page-2' },
      })
      expect(container.querySelector('button')?.textContent).toBe('Load more')
    })

    it('sends nextCursor from host state on a Load more click', () => {
      const { container, onRunAction } = render({
        spec: buttonSpec({ label: 'Load more', actionId: 'load_list' }),
        state: { nextCursor: 'page-2', articles: [{ id: '1' }] },
      })
      act(() => {
        container.querySelector('button')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })
      expect(onRunAction).toHaveBeenCalledWith(
        'load_list',
        expect.objectContaining({ nextCursor: 'page-2' })
      )
      expect(onRunAction.mock.calls[0]?.[1]).not.toHaveProperty('articles')
    })
  })

  it('ticks earlier ProgressSteps after elapsed time while pending', () => {
    vi.useFakeTimers()
    try {
      const { container } = render({ spec: progressSpec, pending: true })
      expect(container.textContent).toContain('Connecting')
      expect(container.textContent).toContain('Researching')
      const before = Array.from(container.querySelectorAll('li')).map((item) => item.textContent)
      expect(before[0]).not.toContain('✓')

      act(() => {
        vi.advanceTimersByTime(500)
      })

      const after = Array.from(container.querySelectorAll('li')).map((item) => item.textContent)
      expect(after[0]).toContain('✓')
      expect(after[1]).not.toContain('✓')
    } finally {
      vi.useRealTimers()
    }
  })

  it('shows DataText content from an aliased string field', () => {
    const spec: Spec = {
      root: 'page',
      elements: {
        page: { type: 'Page', props: {}, children: ['section'] },
        section: {
          type: 'Stack',
          props: { showWhen: 'artical_data' },
          children: ['body'],
        },
        body: {
          type: 'DataText',
          props: { statePath: 'content', fallback: '' },
          children: [],
        },
      },
    }
    const { container } = render({
      spec,
      state: { content: '# Root Canal Treatment' },
      proseAliasKeys: ['content', 'artical_data'],
    })
    expect(container.textContent).toContain('Root Canal Treatment')
  })

  it('hides WorkingCard when a different action is pending', () => {
    const spec: Spec = {
      root: 'page',
      elements: {
        page: { type: 'Page', props: { title: 'Results' }, children: ['working'] },
        working: {
          type: 'WorkingCard',
          props: {
            title: 'Working on it…',
            steps: 'Connecting…\nDrafting…',
            actionId: 'generate',
            cancelTo: 'home',
          },
          children: [],
        },
      },
    }
    const { container } = render({
      spec,
      pending: true,
      pendingActionIds: new Set(['fetch_history']),
    })
    expect(container.querySelector('[data-testid="working-card"]')).toBeNull()
  })

  it('shows WorkingCard with estimate and Cancel when steps are omitted', () => {
    const spec: Spec = {
      root: 'page',
      elements: {
        page: { type: 'Page', props: { title: 'Results' }, children: ['working'] },
        working: {
          type: 'WorkingCard',
          props: {
            title: 'Scoring…',
            estimate: 'About 20s',
            actionId: 'generate',
            cancelTo: 'home',
            skeleton: false,
          },
          children: [],
        },
      },
    }
    const { container } = render({
      spec,
      pending: true,
      pendingActionIds: new Set(['generate']),
    })
    expect(container.querySelector('[data-testid="working-card"]')?.textContent).toContain(
      'Scoring…'
    )
    expect(container.querySelector('[data-testid="working-card"]')?.textContent).toContain(
      'About 20s'
    )
    expect(container.querySelector('[data-testid="working-card-cancel"]')).toBeTruthy()
  })

  it('hides WorkingCard when idle', () => {
    const spec: Spec = {
      root: 'page',
      elements: {
        page: { type: 'Page', props: { title: 'Results' }, children: ['working'] },
        working: {
          type: 'WorkingCard',
          props: {
            title: 'Working on it…',
            steps: 'Connecting…\nDrafting…',
            cancelTo: 'home',
          },
          children: [],
        },
      },
    }
    const { container } = render({ spec, pending: false })
    expect(container.querySelector('[data-testid="working-card"]')).toBeNull()
  })

  it('ticks WorkingCard steps and bar in lockstep, interpolates copy, and Cancel returns to idle', () => {
    vi.useFakeTimers()
    try {
      const spec: Spec = {
        root: 'page',
        elements: {
          page: { type: 'Page', props: { title: 'Results' }, children: ['working'] },
          working: {
            type: 'WorkingCard',
            props: {
              title: "Working on '{targetKeyword}' for {clientBrand}...",
              steps:
                "Connecting to the recommendation agent…\nResearching the client's market & competitors…\nAnalyzing keyword demand & search intent…\nScoring topic opportunities…\nDrafting article recommendations…",
              estimate: 'Usually takes 90–150s',
              intervalMs: 2000,
              tip: "Tip: Articles targeting '{targetKeyword}' perform best when every H2 maps to one distinct search intent.",
              cancelTo: 'home',
              skeleton: true,
            },
            children: [],
          },
        },
      }
      const { container, onNavigate, onCancelPending } = render({
        spec,
        pending: true,
        state: { inputs: { targetKeyword: 'CFL Bulbs', clientBrand: 'Philips' } },
      })
      expect(container.textContent).toContain("Working on 'CFL Bulbs' for Philips...")
      expect(container.textContent).toContain('Usually takes 90–150s')
      expect(container.textContent).toContain("Articles targeting 'CFL Bulbs'")
      expect(container.querySelector('[data-testid="skeleton"]')).toBeTruthy()
      const bar = container.querySelector('[data-testid="working-card-bar"]')
      expect(bar?.getAttribute('aria-valuenow')).toBe('20')
      const first = container.querySelectorAll('li')[0]
      expect(first?.className).not.toContain('line-through')

      act(() => {
        vi.advanceTimersByTime(2000)
      })

      expect(
        container.querySelector('[data-testid="working-card-bar"]')?.getAttribute('aria-valuenow')
      ).toBe('40')
      expect(container.querySelectorAll('li')[0]?.className).toContain('line-through')

      act(() => {
        container
          .querySelector('[data-testid="working-card-cancel"]')
          ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })
      expect(onCancelPending).toHaveBeenCalled()
      expect(onNavigate).toHaveBeenCalledWith('home')
    } finally {
      vi.useRealTimers()
    }
  })

  it('skips the Page sr-only h1 when a PageHeader already provides one', () => {
    const spec: Spec = {
      root: 'page',
      elements: {
        page: { type: 'Page', props: { title: 'Home' }, children: ['header'] },
        header: {
          type: 'PageHeader',
          props: { title: 'Recommendations', subtitle: 'Ranked for you' },
          children: [],
        },
      },
    }
    const { container } = render({ spec })
    const headings = Array.from(container.querySelectorAll('h1'))
    expect(headings.map((heading) => heading.textContent)).toEqual(['Recommendations'])
    expect(container.querySelector('h1.sr-only')).toBeNull()
  })

  it('associates a Switch with its visible label', () => {
    const { container } = render({
      spec: {
        root: 'page',
        elements: {
          page: { type: 'Page', props: {}, children: ['form'] },
          form: { type: 'Form', props: { actionId: 'save' }, children: ['notify'] },
          notify: {
            type: 'Switch',
            props: { name: 'notify', label: 'Notify', defaultChecked: false },
            children: [],
          },
        },
      },
    })
    const toggle = container.querySelector('button[role="switch"]')
    const label = container.querySelector('label[for="field-notify"]')
    expect(toggle?.id).toBe('field-notify')
    expect(label?.textContent).toBe('Notify')
    expect(toggle?.getAttribute('aria-labelledby')).toBe('field-notify-label')
  })

  it('marks streamed DataText as a live region', () => {
    const { container } = render({ spec: replySpec, state: {} })
    expect(container.querySelector('[aria-live="polite"]')).not.toBeNull()
  })

  /**
   * A SubmitButton outside a Form has nothing to submit. Before this it rendered a
   * bare type="submit" with no handler, so the primary action of an already-published
   * app silently did nothing.
   */
  describe('SubmitButton outside a Form', () => {
    function formlessSpec(props: Record<string, unknown>): Spec {
      return {
        root: 'page',
        elements: {
          page: { type: 'Page', props: { title: 'Search' }, children: ['stack'] },
          stack: { type: 'Stack', props: { direction: 'horizontal' }, children: ['submit'] },
          submit: { type: 'SubmitButton', props, children: [] },
        },
      }
    }

    it('runs its own actionId on click', () => {
      const { container, onRunAction } = render({
        spec: formlessSpec({ label: 'Search', actionId: 'run_search' }),
      })
      const button = container.querySelector('button')

      expect(button?.getAttribute('type')).toBe('button')
      expect(button?.className).not.toContain('w-full')
      act(() => {
        button?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })

      expect(onRunAction).toHaveBeenCalledWith('run_search', expect.any(Object))
    })

    it('still submits normally when it is inside a Form', () => {
      const { container, onRunAction } = render()
      const button = container.querySelector('button[type="submit"]')
      expect(button).not.toBeNull()

      act(() => {
        container
          .querySelector('form')
          ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
      })
      expect(onRunAction).toHaveBeenCalledWith('submit_lead', expect.any(Object))
    })

    it('is inside a Form even when nested below other elements', () => {
      const spec: Spec = {
        root: 'page',
        elements: {
          page: { type: 'Page', props: { title: 'Deep' }, children: ['form'] },
          form: { type: 'Form', props: { actionId: 'save' }, children: ['card'] },
          card: { type: 'Card', props: { title: 'Details' }, children: ['submit'] },
          submit: { type: 'SubmitButton', props: { label: 'Save' }, children: [] },
        },
      }
      const { container } = render({ spec })

      expect(container.querySelector('button[type="submit"]')).not.toBeNull()
      expect(container.querySelector('button[type="button"]')).toBeNull()
    })

    it('sends the Repeat row values when it sits inside a Repeat', () => {
      const spec: Spec = {
        root: 'page',
        elements: {
          page: { type: 'Page', props: { title: 'Rows' }, children: ['grid'] },
          grid: { type: 'Grid', props: { columns: '2' }, children: ['repeat'] },
          repeat: { type: 'Repeat', props: { statePath: 'rows' }, children: ['submit'] },
          submit: {
            type: 'SubmitButton',
            props: { label: 'Pick', actionId: 'pick_row' },
            children: [],
          },
        },
      }
      const { container, onRunAction } = render({ spec, state: { rows: [{ id: 'r1' }] } })

      act(() => {
        container.querySelector('button')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })

      expect(onRunAction).toHaveBeenCalledWith('pick_row', expect.objectContaining({ id: 'r1' }))
    })
  })

  it('centers a PageHeader with kicker and display title', () => {
    const spec: Spec = {
      root: 'page',
      elements: {
        page: { type: 'Page', props: {}, children: ['header'] },
        header: {
          type: 'PageHeader',
          props: {
            title: 'Find any company',
            subtitle: 'Search a name or domain.',
            kicker: 'Watchtower',
            align: 'center',
          },
          children: ['history'],
        },
        history: {
          type: 'Button',
          props: { label: 'View analysis history', variant: 'outline', shape: 'pill' },
          children: [],
        },
      },
    }
    const { container } = render({ spec })
    expect(container.textContent).toContain('Watchtower')
    const kicker = Array.from(container.querySelectorAll('p')).find(
      (node) => node.textContent === 'Watchtower'
    )
    expect(kicker?.className).toContain('gui-brand')
    expect(kicker?.className).not.toContain('uppercase')
    expect(container.querySelector('h1')?.className).toContain('gui-display-size')
    expect(container.querySelector('h1')?.className).not.toContain('gui-heading-size')
    const copy = container.querySelector('h1')?.parentElement
    expect(copy?.className).toContain('text-center')
    expect(container.textContent).toContain('View analysis history')
  })

  it('renders SearchField with a nested submit and suggestion chips that fill the input', () => {
    const spec: Spec = {
      root: 'page',
      elements: {
        page: { type: 'Page', props: {}, children: ['search'] },
        search: {
          type: 'SearchField',
          props: {
            name: 'query',
            placeholder: 'Search a company',
            actionId: 'search_companies',
            suggestions: 'Stripe, Notion',
            submitLabel: 'Search',
          },
          children: [],
        },
      },
    }
    const { container, onRunAction } = render({ spec })
    const field = container.querySelector('[data-testid="search-field"]') as HTMLElement
    expect(field).toBeTruthy()
    expect(field.querySelector('button')?.textContent).toBe('Search')
    const input = container.querySelector('input[name="query"]') as HTMLInputElement
    const suggestion = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Stripe'
    )
    act(() => {
      suggestion?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(input.value).toBe('Stripe')
    act(() => {
      container
        .querySelector('form')
        ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
    })
    expect(onRunAction).toHaveBeenCalledWith(
      'search_companies',
      expect.objectContaining({ query: 'Stripe' })
    )
  })

  it('fills a SearchField when a Chip setValue is clicked', () => {
    const spec: Spec = {
      root: 'page',
      elements: {
        page: { type: 'Page', props: {}, children: ['search', 'chip'] },
        search: {
          type: 'SearchField',
          props: { name: 'query', placeholder: 'Search', actionId: 'search_companies' },
          children: [],
        },
        chip: {
          type: 'Chip',
          props: { text: 'Try Stripe', tone: 'muted', setValue: 'query=Stripe' },
          children: [],
        },
      },
    }
    const { container } = render({ spec })
    const input = container.querySelector('input[name="query"]') as HTMLInputElement
    const chip = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Try Stripe'
    )
    act(() => {
      chip?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(input.value).toBe('Stripe')
  })

  it('paints the selected Chip in a same-page view-switch group', () => {
    const spec: Spec = {
      root: 'page',
      elements: {
        page: { type: 'Page', props: {}, children: ['pills'] },
        pills: {
          type: 'Stack',
          props: { direction: 'horizontal' },
          children: ['article', 'gaps'],
        },
        article: {
          type: 'Chip',
          props: { text: 'Enhanced Article', tone: 'muted', setValue: 'resultTab=article' },
          children: [],
        },
        gaps: {
          type: 'Chip',
          props: { text: 'Gap Analysis', tone: 'brand', setValue: 'resultTab=gaps' },
          children: [],
        },
      },
    }
    const { container } = render({ spec })
    const article = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Enhanced Article'
    )
    const gaps = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Gap Analysis'
    )
    expect(article?.getAttribute('aria-pressed')).toBe('true')
    expect(gaps?.getAttribute('aria-pressed')).toBe('false')
    expect(article?.className).toContain('gui-brand')
    expect(gaps?.className).toContain('gui-canvas')

    act(() => {
      gaps?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(article?.getAttribute('aria-pressed')).toBe('false')
    expect(gaps?.getAttribute('aria-pressed')).toBe('true')
    expect(gaps?.className).toContain('gui-brand')
    expect(article?.className).toContain('gui-canvas')
  })

  it('keeps History selected detail when a result-view Chip is clicked', () => {
    const spec: Spec = {
      root: 'page',
      elements: {
        page: { type: 'Page', props: {}, children: ['list', 'detail'] },
        list: {
          type: 'Section',
          props: { showWhen: '!selectedId' },
          children: ['runs'],
        },
        runs: { type: 'Repeat', props: { statePath: 'history' }, children: ['open'] },
        open: {
          type: 'Button',
          props: { label: 'View', selectItem: true },
          children: [],
        },
        detail: {
          type: 'Section',
          props: { showWhen: 'selectedId' },
          children: ['article', 'gaps', 'articleBody', 'gapsBody'],
        },
        article: {
          type: 'Chip',
          props: { text: 'Enhanced Article', tone: 'muted', setValue: 'resultTab=article' },
          children: [],
        },
        gaps: {
          type: 'Chip',
          props: { text: 'Gap Analysis', tone: 'muted', setValue: 'resultTab=gaps' },
          children: [],
        },
        articleBody: {
          type: 'DataText',
          props: { statePath: 'content', fallback: '', showWhen: 'resultTab=article' },
          children: [],
        },
        gapsBody: {
          type: 'DataText',
          props: { statePath: 'gaps', fallback: '', showWhen: 'resultTab=gaps' },
          children: [],
        },
      },
    }
    const { container, onClearSelection } = render({
      spec,
      state: {
        selectedId: 'run_1',
        content: '# Enhanced article',
        gaps: '# Coverage gaps',
        history: [{ id: 'run_1', keyword: 'SEO' }],
      },
    })
    expect(container.textContent).toContain('Enhanced article')
    expect(container.textContent).not.toContain('Coverage gaps')
    const gapsChip = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Gap Analysis'
    )
    act(() => {
      gapsChip?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(onClearSelection).not.toHaveBeenCalled()
    expect(container.textContent).toContain('Coverage gaps')
    expect(container.textContent).not.toContain('Enhanced article')
    expect(gapsChip?.getAttribute('aria-pressed')).toBe('true')
  })

  it('keeps Card children in authored order', () => {
    const spec: Spec = {
      root: 'page',
      elements: {
        page: { type: 'Page', props: {}, children: ['card'] },
        card: {
          type: 'Card',
          props: { title: 'Enhanced results' },
          children: ['body', 'article', 'gaps', 'analyze'],
        },
        body: {
          type: 'DataText',
          props: { statePath: 'content', fallback: '' },
          children: [],
        },
        article: {
          type: 'Chip',
          props: { text: 'Enhanced Article', setValue: 'resultTab=article' },
          children: [],
        },
        gaps: {
          type: 'Chip',
          props: { text: 'Gap Analysis', setValue: 'resultTab=gaps' },
          children: [],
        },
        analyze: {
          type: 'Button',
          props: { label: 'Export', variant: 'secondary' },
          children: [],
        },
      },
    }
    const { container } = render({ spec, state: { content: '# Report body' } })
    const card = container.querySelector('[data-testid="card"]') as HTMLElement
    expect(card.querySelector('[data-testid="view-switch-chips"]')).toBeNull()
    expect(card.querySelector('[data-testid="card-footer"]')).toBeNull()
    expect(card.textContent).toContain('Export')
    expect(card.textContent?.indexOf('Report body') ?? -1).toBeLessThan(
      card.textContent?.indexOf('Enhanced Article') ?? 0
    )
    expect(card.textContent?.indexOf('Enhanced Article') ?? -1).toBeLessThan(
      card.textContent?.indexOf('Export') ?? 0
    )
  })

  it('clamps long Card titles and keeps Badge meta with the title row', () => {
    const longUrl =
      'https://www.artificialintelligence-news.com/news/nvidia-circular-financing-ai-labs/'
    const spec: Spec = {
      root: 'page',
      elements: {
        page: { type: 'Page', props: {}, children: ['card'] },
        card: {
          type: 'Card',
          props: { title: longUrl, footerText: 'Sep 9, 2026' },
          children: ['category', 'score', 'open'],
        },
        category: { type: 'Badge', props: { text: 'News', tone: 'info' }, children: [] },
        score: { type: 'Badge', props: { text: 'Score: 87', tone: 'info' }, children: [] },
        open: {
          type: 'Button',
          props: { label: 'View Results', variant: 'secondary' },
          children: [],
        },
      },
    }
    const { container } = render({ spec })
    const card = container.querySelector('[data-testid="card"]') as HTMLElement
    const title = card.querySelector('h2') as HTMLElement
    const footer = card.querySelector('[data-testid="card-footer"]') as HTMLElement
    expect(title.className).toContain('line-clamp-2')
    expect(title.className).toContain('wrap-break-word')
    expect(title.getAttribute('title')).toBe(longUrl)
    expect(title.className).toContain('min-w-0')
    expect(title.textContent).toBe(longUrl)
    expect(footer?.textContent).toContain('Sep 9, 2026')
    expect(footer?.textContent).not.toContain('View Results')
    expect(card.textContent).toContain('View Results')
    expect(card.textContent).toContain('News')
  })

  it('keeps result-view Chips in the authored horizontal Stack', () => {
    const spec: Spec = {
      root: 'page',
      elements: {
        page: { type: 'Page', props: {}, children: ['row'] },
        row: {
          type: 'Stack',
          props: { direction: 'horizontal', gap: 'md' },
          children: ['article', 'gaps', 'coverage', 'recs', 'body'],
        },
        article: {
          type: 'Chip',
          props: { text: 'Enhanced Article', setValue: 'resultTab=article' },
          children: [],
        },
        gaps: {
          type: 'Chip',
          props: { text: 'Gap Analysis', setValue: 'resultTab=gaps' },
          children: [],
        },
        coverage: {
          type: 'Chip',
          props: { text: 'Coverage Verification', setValue: 'resultTab=coverage' },
          children: [],
        },
        recs: {
          type: 'Chip',
          props: { text: 'Recommendations', setValue: 'resultTab=recs' },
          children: [],
        },
        body: {
          type: 'DataText',
          props: { statePath: 'content', fallback: '' },
          children: [],
        },
      },
    }
    const { container } = render({ spec, state: { content: '# Body' } })
    expect(container.querySelector('[data-testid="view-switch-chips"]')).toBeNull()
    const row = container.querySelector('.flex-row') as HTMLElement
    expect(row).toBeTruthy()
    expect(row.textContent).toContain('Enhanced Article')
    expect(row.textContent).toContain('Recommendations')
    expect(row.textContent).toContain('Body')
    expect(container.textContent?.indexOf('Enhanced Article') ?? -1).toBeLessThan(
      container.textContent?.indexOf('Body') ?? 0
    )
  })

  it('keeps an authored vertical Chip Stack as a left rail beside the panels', () => {
    const spec: Spec = {
      root: 'page',
      elements: {
        page: { type: 'Page', props: {}, children: ['row'] },
        row: {
          type: 'Stack',
          props: { direction: 'horizontal', gap: 'md' },
          children: ['tabs', 'body'],
        },
        tabs: {
          type: 'Stack',
          props: { direction: 'vertical', gap: 'sm' },
          children: ['article', 'gaps'],
        },
        article: {
          type: 'Chip',
          props: { text: 'Enhanced Article', setValue: 'resultTab=article' },
          children: [],
        },
        gaps: {
          type: 'Chip',
          props: { text: 'Gap Analysis', setValue: 'resultTab=gaps' },
          children: [],
        },
        body: {
          type: 'DataText',
          props: { statePath: 'content', fallback: '' },
          children: [],
        },
      },
    }
    const { container } = render({ spec, state: { content: '# Body' } })
    expect(container.querySelector('[data-testid="view-switch-chips"]')).toBeNull()
    expect(container.textContent).toContain('Enhanced Article')
    expect(container.textContent).toContain('Gap Analysis')
    expect(container.textContent).toContain('Body')
    const row = container.querySelector('.flex-row') as HTMLElement | null
    expect(row?.className).toContain('flex-row')
    expect(row?.textContent).toContain('Enhanced Article')
    expect(row?.textContent).toContain('Body')
  })

  it('keeps authored tone on a lone suggestion Chip', () => {
    const spec: Spec = {
      root: 'page',
      elements: {
        page: { type: 'Page', props: {}, children: ['chip'] },
        chip: {
          type: 'Chip',
          props: { text: 'Try Stripe', tone: 'muted', setValue: 'query=Stripe' },
          children: [],
        },
      },
    }
    const { container } = render({ spec })
    const chip = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Try Stripe'
    )
    expect(chip?.getAttribute('aria-pressed')).toBeNull()
    expect(chip?.className).toContain('gui-canvas')
    expect(chip?.className).not.toContain('gui-brand-surface')
  })

  it('expands Disclosure rows independently without selectItem', () => {
    const spec: Spec = {
      root: 'page',
      elements: {
        page: { type: 'Page', props: {}, children: ['list'] },
        list: { type: 'Repeat', props: { statePath: 'faq_suggestions' }, children: ['row'] },
        row: {
          type: 'Disclosure',
          props: { title: '{item.question}' },
          children: ['answer'],
        },
        answer: { type: 'Text', props: { text: '{item.suggested_answer}' }, children: [] },
      },
    }
    const onSelectItem = vi.fn()
    const { container } = render({
      spec,
      onSelectItem,
      state: {
        faq_suggestions: [
          { question: 'What is SEO?', suggested_answer: 'Search engine optimization.' },
          { question: 'Why citations?', suggested_answer: 'They build trust.' },
        ],
      },
    })
    const rows = Array.from(container.querySelectorAll('[data-testid="disclosure"]'))
    expect(rows).toHaveLength(2)
    const first = rows[0]?.querySelector('button')
    const second = rows[1]?.querySelector('button')
    expect(first?.getAttribute('aria-expanded')).toBe('false')
    expect(second?.getAttribute('aria-expanded')).toBe('false')
    expect(container.textContent).toContain('What is SEO?')
    expect(container.textContent).toContain('Why citations?')
    expect(container.textContent).not.toContain('Search engine optimization.')
    expect(container.textContent).not.toContain('They build trust.')

    act(() => {
      first?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(first?.getAttribute('aria-expanded')).toBe('true')
    expect(second?.getAttribute('aria-expanded')).toBe('false')
    expect(container.textContent).toContain('Search engine optimization.')
    expect(container.textContent).not.toContain('They build trust.')

    act(() => {
      second?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(first?.getAttribute('aria-expanded')).toBe('true')
    expect(second?.getAttribute('aria-expanded')).toBe('true')
    expect(container.textContent).toContain('They build trust.')

    act(() => {
      first?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(first?.getAttribute('aria-expanded')).toBe('false')
    expect(second?.getAttribute('aria-expanded')).toBe('true')
    expect(container.textContent).not.toContain('Search engine optimization.')
    expect(container.textContent).toContain('They build trust.')
    expect(onSelectItem).not.toHaveBeenCalled()
  })

  it('honours Disclosure defaultOpen without emitting a second copy', () => {
    const spec: Spec = {
      root: 'page',
      elements: {
        page: { type: 'Page', props: {}, children: ['row'] },
        row: {
          type: 'Disclosure',
          props: { title: 'Justification', defaultOpen: true },
          children: ['body'],
        },
        body: { type: 'Text', props: { text: 'Coverage is thin on pricing.' }, children: [] },
      },
    }
    const { container } = render({ spec })
    const trigger = container.querySelector('[data-testid="disclosure"] button')
    expect(trigger?.getAttribute('aria-expanded')).toBe('true')
    expect(container.textContent).toContain('Coverage is thin on pricing.')
    expect(container.querySelectorAll('[data-testid="disclosure"]')).toHaveLength(1)

    act(() => {
      trigger?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    expect(trigger?.getAttribute('aria-expanded')).toBe('false')
    expect(container.textContent).not.toContain('Coverage is thin on pricing.')
  })

  it('renders Card subtitle, media, and footer', () => {
    const spec: Spec = {
      root: 'page',
      elements: {
        page: { type: 'Page', props: {}, children: ['card'] },
        card: {
          type: 'Card',
          props: {
            title: 'Stripe',
            subtitle: 'stripe.com',
            description: 'Payments infrastructure.',
            footerText: 'Enterprise · 2010',
          },
          children: ['logo', 'analyze'],
        },
        logo: { type: 'Avatar', props: { initials: 'ST' }, children: [] },
        analyze: {
          type: 'Button',
          props: { label: 'Analyze', variant: 'secondary' },
          children: [],
        },
      },
    }
    const { container } = render({ spec })
    expect(container.querySelector('h2')?.textContent).toBe('Stripe')
    expect(container.textContent).toContain('stripe.com')
    expect(container.querySelector('[data-testid="avatar"]')?.textContent).toBe('ST')
    const footer = container.querySelector('[data-testid="card-footer"]')
    expect(footer?.textContent).toContain('Enterprise · 2010')
    expect(footer?.textContent).not.toContain('Analyze')
    expect(container.textContent).toContain('Analyze')
  })

  it('paints a default Card as a bordered surface with rest shadow', () => {
    const spec: Spec = {
      root: 'page',
      elements: {
        page: { type: 'Page', props: {}, children: ['card'] },
        card: {
          type: 'Card',
          props: { title: 'Quiet' },
          children: [],
        },
      },
    }
    const { container } = render({ spec })
    const card = container.querySelector('[data-testid="card"]') as HTMLElement
    expect(card.className).toContain('border-(--gui-border,#e2e3e5)')
    expect(card.className).toContain('shadow-(--gui-shadow-card')
  })

  it('renders Card variant muted with rest shadow and resolves padding tokens', () => {
    const spec: Spec = {
      root: 'page',
      elements: {
        page: { type: 'Page', props: {}, children: ['card'] },
        card: {
          type: 'Card',
          props: { title: 'Quiet', variant: 'muted', padding: 'lg' },
          children: [],
        },
      },
    }
    const { container } = render({ spec })
    const card = container.querySelector('[data-testid="card"]') as HTMLElement
    expect(card.getAttribute('data-variant')).toBe('muted')
    expect(card.className).toContain('border-(--gui-border,#e2e3e5)')
    expect(card.className).toContain('gui-surface-muted')
    expect(card.className).toContain('shadow-(--gui-shadow-card')
    expect(card.style.padding).toBe('var(--gui-space-lg, 24px)')
  })

  it('resolves Stack gap tokens to density-aware CSS variables', () => {
    const spec: Spec = {
      root: 'page',
      elements: {
        page: { type: 'Page', props: {}, children: ['stack'] },
        stack: { type: 'Stack', props: { gap: 'lg' }, children: [] },
      },
    }
    const { container } = render({ spec })
    const stack = container.querySelector('div.flex') as HTMLElement
    expect(stack.style.gap).toBe('var(--gui-space-lg, 24px)')
  })

  it('resolves host binding tokens on Text and Chip', () => {
    const spec: Spec = {
      root: 'page',
      elements: {
        page: { type: 'Page', props: {}, children: ['heading', 'chip'] },
        heading: {
          type: 'Heading',
          props: { text: 'Keyword: {Target Keyword}', level: 'h2' },
          children: [],
        },
        chip: {
          type: 'Chip',
          props: { text: 'Client: {clientBrand}', tone: 'muted' },
          children: [],
        },
      },
    }
    const { container } = render({
      spec,
      state: { inputs: { targetKeyword: 'Dental implants', clientBrand: '42 North Dental' } },
    })
    expect(container.textContent).toContain('Keyword: Dental implants')
    expect(container.textContent).toContain('Client: 42 North Dental')
    expect(container.textContent).not.toContain('{Target Keyword}')
  })

  it('hides an idle ProgressBar that has no real percent', () => {
    const spec: Spec = {
      root: 'page',
      elements: {
        page: { type: 'Page', props: {}, children: ['bar'] },
        bar: { type: 'ProgressBar', props: { value: null }, children: [] },
      },
    }
    const { container } = render({ spec, pending: false })
    expect(container.querySelector('[data-testid="progress-bar"]')).toBeNull()
  })

  it('shows a ProgressBar while pending even without a percent', () => {
    const spec: Spec = {
      root: 'page',
      elements: {
        page: { type: 'Page', props: {}, children: ['bar'] },
        bar: { type: 'ProgressBar', props: { value: null }, children: [] },
      },
    }
    const { container } = render({ spec, pending: true })
    expect(container.querySelector('[data-testid="progress-bar"]')).toBeTruthy()
  })

  it('renders ProgressBar percent and EntityHeader identity', () => {
    const spec: Spec = {
      root: 'page',
      elements: {
        page: { type: 'Page', props: {}, children: ['entity', 'bar'] },
        entity: {
          type: 'EntityHeader',
          props: {
            title: 'Stripe',
            description: 'Resolving company profile.',
            badge: 'Running',
            initials: 'ST',
            meta: 'Payments, San Francisco',
          },
          children: [],
        },
        bar: { type: 'ProgressBar', props: { value: 40 }, children: [] },
      },
    }
    const { container } = render({ spec })
    expect(container.querySelector('[data-testid="entity-header"]')?.textContent).toContain(
      'Stripe'
    )
    expect(container.textContent).toContain('Running')
    expect(container.textContent).toContain('Payments')
    const bar = container.querySelector('[data-testid="progress-bar"]')
    expect(bar?.getAttribute('aria-valuenow')).toBe('40')
  })

  it('indents nested ProgressSteps lines while pending', () => {
    const spec: Spec = {
      root: 'page',
      elements: {
        page: { type: 'Page', props: {}, children: ['progress'] },
        progress: {
          type: 'ProgressSteps',
          props: { steps: 'Resolving company profile\n  Registry lookup', durationMs: 1000 },
          children: [],
        },
      },
    }
    const { container } = render({ spec, pending: true })
    expect(container.textContent).toContain('Resolving company profile')
    expect(container.textContent).toContain('Registry lookup')
    const nested = Array.from(container.querySelectorAll('li')).find((item) =>
      item.textContent?.includes('Registry lookup')
    )
    expect(nested?.className).toContain('pl-6')
  })

  it('marks a required field label without changing validation copy', () => {
    const spec: Spec = {
      root: 'page',
      elements: {
        page: { type: 'Page', props: {}, children: ['form'] },
        form: { type: 'Form', props: { actionId: 'save' }, children: ['name'] },
        name: {
          type: 'TextInput',
          props: { name: 'name', label: 'Name', required: true },
          children: [],
        },
      },
    }
    const { container } = render({ spec })
    expect(container.querySelector('label')?.textContent).toBe('Name *')
  })

  it('shows busy chrome on a pending action button but not on a nav-only button', () => {
    const spec: Spec = {
      root: 'page',
      elements: {
        page: { type: 'Page', props: {}, children: ['run', 'back'] },
        run: { type: 'Button', props: { label: 'Run', actionId: 'run' }, children: [] },
        back: { type: 'Button', props: { label: 'Back', navigateTo: 'home' }, children: [] },
      },
    }
    const { container } = render({ spec, pending: true })
    const run = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Run')
    )
    const back = Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Back'
    )
    expect(run?.disabled).toBe(true)
    expect(run?.querySelector('[data-testid="action-busy"]')).toBeTruthy()
    expect(back?.disabled).toBe(false)
    expect(back?.querySelector('[data-testid="action-busy"]')).toBeNull()
  })

  it('shows busy chrome on a pending SubmitButton', () => {
    const { container } = render({ pending: true })
    const submit = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Submit')
    )
    expect(submit?.disabled).toBe(true)
    expect(submit?.getAttribute('aria-busy')).toBe('true')
    expect(submit?.querySelector('[data-testid="action-busy"]')).toBeTruthy()
  })

  it('keeps a form SubmitButton inline and tints inputs on focus', () => {
    const { container } = render()
    const submit = container.querySelector('button[type="submit"]')
    expect(submit?.className).not.toContain('w-full')
    const form = container.querySelector('form')
    expect(form?.className).toContain('w-full')
    expect(form?.className).not.toContain('max-w-(--gui-measure')
    const input = container.querySelector('input[name="name"]')
    expect(input?.className).toContain('focus-visible:bg-(--gui-brand-surface,#f3f8fe)')
  })

  it('shows busy chrome on a pending SearchField submit', () => {
    const spec: Spec = {
      root: 'page',
      elements: {
        page: { type: 'Page', props: {}, children: ['search'] },
        search: {
          type: 'SearchField',
          props: { name: 'query', actionId: 'search', submitLabel: 'Search' },
          children: [],
        },
      },
    }
    const { container } = render({ spec, pending: true })
    const submit = container.querySelector('[data-testid="search-field"] button')
    expect(submit?.getAttribute('disabled')).not.toBeNull()
    expect(submit?.querySelector('[data-testid="action-busy"]')).toBeTruthy()
  })

  it('shows busy chrome on a pending Chip with actionId', () => {
    const spec: Spec = {
      root: 'page',
      elements: {
        page: { type: 'Page', props: {}, children: ['run', 'hint'] },
        run: {
          type: 'Chip',
          props: { text: 'Analyze', actionId: 'analyze' },
          children: [],
        },
        hint: { type: 'Chip', props: { text: 'Hint', setValue: 'query=x' }, children: [] },
      },
    }
    const { container } = render({ spec, pending: true })
    const run = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Analyze')
    )
    const hint = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Hint')
    )
    expect(run?.disabled).toBe(true)
    expect(run?.getAttribute('aria-busy')).toBe('true')
    expect(run?.querySelector('[data-testid="action-busy"]')).toBeTruthy()
    expect(hint?.disabled).toBe(false)
    expect(hint?.querySelector('[data-testid="action-busy"]')).toBeNull()
  })

  it('leaves a form TextInput enabled while the submit control is pending', () => {
    const { container } = render({ pending: true })
    const input = container.querySelector('input[name="name"]') as HTMLInputElement
    expect(input.disabled).toBe(false)
    const submit = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Submit')
    )
    expect(submit?.disabled).toBe(true)
  })

  it('uses the current path for Tabs when it matches an item, otherwise activePath', () => {
    const spec: Spec = {
      root: 'page',
      elements: {
        page: { type: 'Page', props: {}, children: ['tabs'] },
        tabs: {
          type: 'Tabs',
          props: { items: 'Home|home\nReports|reports', activePath: 'home' },
          children: [],
        },
      },
    }
    const matched = render({ spec, currentPath: 'reports' })
    const matchedTabs = Array.from(matched.container.querySelectorAll('[role="tab"]'))
    expect(matchedTabs[1]?.getAttribute('aria-current')).toBe('page')
    expect(matchedTabs[0]?.getAttribute('aria-current')).toBeNull()
    unmount?.()
    const unmatched = render({ spec, currentPath: 'detail' })
    const unmatchedTabs = Array.from(unmatched.container.querySelectorAll('[role="tab"]'))
    expect(unmatchedTabs[0]?.getAttribute('aria-current')).toBe('page')
  })

  it('moves Tab focus with arrow keys without navigating', () => {
    const spec: Spec = {
      root: 'page',
      elements: {
        page: { type: 'Page', props: {}, children: ['tabs'] },
        tabs: {
          type: 'Tabs',
          props: { items: 'Home|home\nReports|reports', activePath: 'home' },
          children: [],
        },
      },
    }
    const { container, onNavigate } = render({ spec })
    const tabs = Array.from(container.querySelectorAll('[role="tab"]')) as HTMLButtonElement[]
    act(() => {
      tabs[0]?.focus()
      tabs[0]?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    })
    expect(document.activeElement).toBe(tabs[1])
    expect(onNavigate).not.toHaveBeenCalled()
  })

  it('lazy-loads images and shows a fallback when src is empty', () => {
    const spec: Spec = {
      root: 'page',
      elements: {
        page: { type: 'Page', props: {}, children: ['photo'] },
        photo: {
          type: 'Image',
          props: { src: '', alt: 'Company logo', width: null, height: null },
          children: [],
        },
      },
    }
    const { container } = render({ spec })
    expect(container.querySelector('[data-testid="image-fallback"]')?.textContent).toBe(
      'Company logo'
    )
    expect(container.querySelector('img')).toBeNull()
  })

  it('sets loading=lazy on a content image', () => {
    const spec: Spec = {
      root: 'page',
      elements: {
        page: { type: 'Page', props: {}, children: ['photo'] },
        photo: {
          type: 'Image',
          props: { src: 'https://example.com/logo.png', alt: 'Logo', width: null, height: null },
          children: [],
        },
      },
    }
    const { container } = render({ spec })
    expect(container.querySelector('img')?.getAttribute('loading')).toBe('lazy')
  })

  it('falls back when an image fails to load', () => {
    const spec: Spec = {
      root: 'page',
      elements: {
        page: { type: 'Page', props: {}, children: ['photo'] },
        photo: {
          type: 'Image',
          props: { src: 'https://example.com/broken.png', alt: 'Logo' },
          children: [],
        },
      },
    }
    const { container } = render({ spec })
    act(() => {
      container.querySelector('img')?.dispatchEvent(new Event('error'))
    })
    expect(container.querySelector('[data-testid="image-fallback"]')?.textContent).toBe('Logo')
    expect(container.querySelector('img')).toBeNull()
  })

  describe('catalog Filter, Drawer, Modal, Toast', () => {
    it('renders Filter children in a toolbar', () => {
      const spec: Spec = {
        root: 'page',
        elements: {
          page: { type: 'Page', props: { title: 'Home' }, children: ['filters'] },
          filters: {
            type: 'Filter',
            props: {},
            children: ['status'],
          },
          status: { type: 'Chip', props: { text: 'Active' }, children: [] },
        },
      }
      const { container } = render({ spec })
      const filter = container.querySelector('[data-testid="filter"]')
      expect(filter).toBeTruthy()
      expect(filter?.textContent).toContain('Active')
    })

    it('hides Drawer until showWhen matches', () => {
      const spec: Spec = {
        root: 'page',
        elements: {
          page: { type: 'Page', props: { title: 'Home' }, children: ['list', 'drawer'] },
          list: { type: 'Text', props: { text: 'Company list' }, children: [] },
          drawer: {
            type: 'Drawer',
            props: { title: 'Detail', showWhen: 'selectedId' },
            children: ['body'],
          },
          body: { type: 'Text', props: { text: 'Row detail' }, children: [] },
        },
      }
      const { container } = render({ spec, state: {} })
      expect(container.querySelector('[data-testid="drawer"]')).toBeNull()
      expect(container.textContent).toContain('Company list')
    })

    it('shows Drawer when showWhen matches, keeps the list visible, and close clears the item', () => {
      const spec: Spec = {
        root: 'page',
        elements: {
          page: { type: 'Page', props: { title: 'Home' }, children: ['list', 'drawer'] },
          list: { type: 'Text', props: { text: 'Company list' }, children: [] },
          drawer: {
            type: 'Drawer',
            props: { title: 'Detail', showWhen: 'selectedId' },
            children: ['body'],
          },
          body: { type: 'Text', props: { text: 'Row detail' }, children: [] },
        },
      }
      const { container, onClearItem } = render({ spec, state: { selectedId: 'co_1' } })
      const drawer = container.querySelector('[data-testid="drawer"]')
      expect(drawer).toBeTruthy()
      expect(container.textContent).toContain('Company list')
      expect(drawer?.textContent).toContain('Row detail')
      act(() => {
        container
          .querySelector('[data-testid="drawer-close"]')
          ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })
      expect(onClearItem).toHaveBeenCalled()
      expect(container.querySelector('[data-testid="drawer"]')).toBeNull()
    })

    it('hides Modal until showWhen matches', () => {
      const spec: Spec = {
        root: 'page',
        elements: {
          page: { type: 'Page', props: { title: 'Home' }, children: ['modal'] },
          modal: {
            type: 'Modal',
            props: { title: 'Rename', showWhen: 'selectedId' },
            children: ['copy'],
          },
          copy: { type: 'Text', props: { text: 'Rename this record' }, children: [] },
        },
      }
      const { container } = render({ spec, state: {} })
      expect(container.querySelector('[data-testid="modal"]')).toBeNull()
    })

    it('shows Modal when showWhen matches and close clears the item', () => {
      const spec: Spec = {
        root: 'page',
        elements: {
          page: { type: 'Page', props: { title: 'Home' }, children: ['modal'] },
          modal: {
            type: 'Modal',
            props: { title: 'Rename', showWhen: 'selectedId' },
            children: ['copy'],
          },
          copy: { type: 'Text', props: { text: 'Rename this record' }, children: [] },
        },
      }
      const { container, onClearItem } = render({ spec, state: { selectedId: 'rec_1' } })
      const modal = container.querySelector('[data-testid="modal"]')
      expect(modal).toBeTruthy()
      expect(modal?.textContent).toContain('Rename this record')
      act(() => {
        container
          .querySelector('[data-testid="modal-close"]')
          ?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })
      expect(onClearItem).toHaveBeenCalled()
      expect(container.querySelector('[data-testid="modal"]')).toBeNull()
    })

    it('opens a create Modal from a Button setValue CTA', () => {
      const spec: Spec = {
        root: 'page',
        elements: {
          page: { type: 'Page', props: { title: 'Tasks' }, children: ['new_task', 'modal'] },
          new_task: {
            type: 'Button',
            props: { label: 'New Task', setValue: 'creating=true', variant: 'primary' },
            children: [],
          },
          modal: {
            type: 'Modal',
            props: { title: 'New Task', showWhen: 'creating' },
            children: ['copy'],
          },
          copy: { type: 'Text', props: { text: 'Task title' }, children: [] },
        },
      }
      const { container, onRunAction, onNavigate } = render({ spec, state: {} })
      expect(container.querySelector('[data-testid="modal"]')).toBeNull()
      const cta = Array.from(container.querySelectorAll('button')).find(
        (button) => button.textContent === 'New Task'
      )
      act(() => {
        cta?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })
      expect(container.querySelector('[data-testid="modal"]')?.textContent).toContain('Task title')
      expect(onRunAction).not.toHaveBeenCalled()
      expect(onNavigate).not.toHaveBeenCalled()
    })

    it('opens a closed create Modal instead of running its actionId', () => {
      const spec: Spec = {
        root: 'page',
        elements: {
          page: { type: 'Page', props: { title: 'Projects' }, children: ['new_project', 'modal'] },
          new_project: {
            type: 'Button',
            props: { label: 'New Project', actionId: 'create_project', variant: 'primary' },
            children: [],
          },
          modal: {
            type: 'Modal',
            props: { title: 'New Project', showWhen: 'creating' },
            children: ['form'],
          },
          form: {
            type: 'Form',
            props: { actionId: 'create_project' },
            children: ['name', 'submit'],
          },
          name: {
            type: 'TextInput',
            props: { name: 'name', label: 'Name', required: true },
            children: [],
          },
          submit: { type: 'SubmitButton', props: { label: 'Create' }, children: [] },
        },
      }
      const { container, onRunAction } = render({ spec, state: {} })
      const cta = Array.from(container.querySelectorAll('button')).find(
        (button) => button.textContent === 'New Project'
      )
      act(() => {
        cta?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })
      expect(container.querySelector('[data-testid="modal"]')).toBeTruthy()
      expect(onRunAction).not.toHaveBeenCalled()
    })

    it('hides Toast until showWhen is true', () => {
      const spec: Spec = {
        root: 'page',
        elements: {
          page: { type: 'Page', props: { title: 'Home' }, children: ['toast'] },
          toast: {
            type: 'Toast',
            props: { text: 'Link copied', tone: 'success', showWhen: 'selectedId' },
            children: [],
          },
        },
      }
      const { container } = render({ spec, state: {} })
      expect(container.querySelector('[data-testid="catalog-toast"]')).toBeNull()
    })

    it('shows Toast when showWhen is true without using the host save toast', () => {
      const spec: Spec = {
        root: 'page',
        elements: {
          page: { type: 'Page', props: { title: 'Home' }, children: ['toast'] },
          toast: {
            type: 'Toast',
            props: { text: 'Link copied', tone: 'success', showWhen: 'selectedId' },
            children: [],
          },
        },
      }
      const { container } = render({ spec, state: { selectedId: 'row_1' } })
      expect(container.querySelector('[data-testid="catalog-toast"]')?.textContent).toBe(
        'Link copied'
      )
      expect(container.querySelector('[data-testid="action-success-toast"]')).toBeNull()
    })
  })

  describe('host reshape', () => {
    it('sorts bound table rows when a header is clicked', () => {
      const spec: Spec = {
        root: 'page',
        elements: {
          page: { type: 'Page', props: { title: 'Home' }, children: ['table'] },
          table: {
            type: 'Table',
            props: { columns: 'name, amount', statePath: 'items' },
            children: [],
          },
        },
      }
      const { container } = render({
        spec,
        state: {
          items: [
            { name: 'B', amount: 2 },
            { name: 'A', amount: 10 },
          ],
        },
      })
      const header = Array.from(container.querySelectorAll('th button')).find(
        (button) => button.textContent === 'name'
      )
      expect(header).toBeTruthy()
      act(() => {
        header?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })
      const cells = Array.from(container.querySelectorAll('tbody tr td:first-child')).map(
        (cell) => cell.textContent
      )
      expect(cells).toEqual(['A', 'B'])
    })

    it('renders an index column, totals row, and relative dates', () => {
      const spec: Spec = {
        root: 'page',
        elements: {
          page: { type: 'Page', props: { title: 'Home' }, children: ['table'] },
          table: {
            type: 'Table',
            props: { columns: '#,amount|sum,date|relative', statePath: 'items' },
            children: [],
          },
        },
      }
      const { container } = render({
        spec,
        state: {
          items: [
            { amount: 10, date: '2020-01-01' },
            { amount: 5, date: '2020-01-02' },
          ],
        },
      })
      expect(container.querySelector('thead')?.textContent).toContain('#')
      expect(container.querySelector('tbody tr td')?.textContent).toBe('1')
      expect(container.querySelector('tfoot')?.textContent).toContain('15')
      expect(container.textContent).not.toContain('2020-01-01')
      expect(container.textContent).toMatch(/days ago/)
    })

    it('parses a markdown table string and falls back to DataText when it is prose', () => {
      const spec: Spec = {
        root: 'page',
        elements: {
          page: { type: 'Page', props: { title: 'Home' }, children: ['table'] },
          table: {
            type: 'Table',
            props: { columns: null, statePath: 'content' },
            children: [],
          },
        },
      }
      const markdown = {
        spec,
        state: {
          content: '| Name | Score |\n| --- | --- |\n| Ada | 12 |',
        },
      }
      const parsed = render(markdown)
      expect(parsed.container.querySelector('table')?.textContent).toContain('Ada')
      parsed.container.remove()
      const prose = render({
        spec,
        state: { content: '# Hello\n\nJust an article.' },
      })
      expect(prose.container.querySelector('table')).toBeNull()
      expect(prose.container.textContent).toContain('Hello')
    })

    it('opens a DateInput month-grid popover', () => {
      const spec: Spec = {
        root: 'page',
        elements: {
          page: { type: 'Page', props: { title: 'Home' }, children: ['start'] },
          start: {
            type: 'DateInput',
            props: { name: 'start', label: 'Start', defaultValue: '2026-09-11' },
            children: [],
          },
        },
      }
      const { container } = render({ spec })
      const trigger = container.querySelector('button[aria-haspopup="dialog"]') as HTMLButtonElement
      expect(container.querySelector('[data-testid="gui-month-grid"]')).toBeNull()
      act(() => {
        trigger.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })
      expect(container.querySelector('[data-testid="gui-month-grid"]')).toBeTruthy()
      expect(container.querySelector('input[type="date"]')).toBeTruthy()
    })

    it('plots Calendar items and keeps unscheduled rows', () => {
      const spec: Spec = {
        root: 'page',
        elements: {
          page: { type: 'Page', props: { title: 'Home' }, children: ['calendar'] },
          calendar: {
            type: 'Calendar',
            props: {
              statePath: 'events',
              dateField: 'date',
              titleField: 'title',
              view: 'month',
              emptyText: 'None',
            },
            children: [],
          },
        },
      }
      const { container, onSelectItem } = render({
        spec,
        state: {
          events: [
            { id: 'e1', title: 'Kickoff', date: '2026-09-11' },
            { id: 'e2', title: 'Backlog' },
          ],
        },
      })
      expect(container.querySelector('[data-testid="gui-calendar"]')).toBeTruthy()
      expect(container.querySelector('[data-testid="unscheduled"]')?.textContent).toContain(
        'Backlog'
      )
      const chip = Array.from(container.querySelectorAll('button')).find(
        (button) => button.textContent === 'Backlog'
      )
      act(() => {
        chip?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })
      expect(onSelectItem).toHaveBeenCalled()
    })

    it('plots Timeline items oldest first and keeps undated rows', () => {
      const spec: Spec = {
        root: 'page',
        elements: {
          page: { type: 'Page', props: { title: 'Home' }, children: ['timeline'] },
          timeline: {
            type: 'Timeline',
            props: {
              statePath: 'events',
              dateField: 'date',
              titleField: 'title',
              emptyText: 'None',
            },
            children: [],
          },
        },
      }
      const { container, onSelectItem } = render({
        spec,
        state: {
          events: [
            { id: 'e1', title: 'Ship', date: '2026-09-18' },
            { id: 'e2', title: 'Kickoff', date: '2026-09-11' },
            { id: 'e3', title: 'Backlog' },
          ],
        },
      })
      expect(container.querySelector('[data-testid="gui-timeline"]')).toBeTruthy()
      const labels = Array.from(
        container.querySelectorAll('[data-testid="gui-timeline"] button')
      ).map((button) => button.textContent)
      expect(labels[0]).toContain('Kickoff')
      expect(labels[1]).toContain('Ship')
      expect(container.querySelector('[data-testid="unscheduled"]')?.textContent).toContain(
        'Backlog'
      )
      const backlog = Array.from(container.querySelectorAll('button')).find((button) =>
        button.textContent?.includes('Backlog')
      )
      act(() => {
        backlog?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })
      expect(onSelectItem).toHaveBeenCalled()
    })

    it('plots Map markers and keeps rows without coordinates', () => {
      const spec: Spec = {
        root: 'page',
        elements: {
          page: { type: 'Page', props: { title: 'Home' }, children: ['map'] },
          map: {
            type: 'Map',
            props: {
              statePath: 'places',
              latField: 'lat',
              lngField: 'lng',
              titleField: 'name',
              emptyText: 'None',
            },
            children: [],
          },
        },
      }
      const { container, onSelectItem } = render({
        spec,
        state: {
          places: [
            { id: 'p1', name: 'HQ', lat: 37.77, lng: -122.42 },
            { id: 'p2', name: 'Remote' },
          ],
        },
      })
      expect(container.querySelector('[data-testid="gui-map"]')).toBeTruthy()
      expect(container.querySelector('iframe')?.getAttribute('src')).toContain('openstreetmap.org')
      expect(container.textContent).toContain('Remote')
      const remote = Array.from(container.querySelectorAll('button')).find((button) =>
        button.textContent?.includes('Remote')
      )
      act(() => {
        remote?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })
      expect(onSelectItem).toHaveBeenCalled()
    })

    it('expands Tree children and selects a nested row', () => {
      const spec: Spec = {
        root: 'page',
        elements: {
          page: { type: 'Page', props: { title: 'Home' }, children: ['tree'] },
          tree: {
            type: 'Tree',
            props: {
              statePath: 'org',
              childrenField: 'children',
              titleField: 'name',
              emptyText: 'None',
            },
            children: [],
          },
        },
      }
      const { container, onSelectItem } = render({
        spec,
        state: {
          org: [{ name: 'Acme', children: [{ name: 'Design' }] }],
        },
      })
      expect(container.querySelector('[data-testid="gui-tree"]')).toBeTruthy()
      expect(container.textContent).toContain('Acme')
      expect(container.textContent).toContain('Design')
      const design = Array.from(container.querySelectorAll('button')).find(
        (button) => button.textContent === 'Design'
      )
      act(() => {
        design?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })
      expect(onSelectItem).toHaveBeenCalled()
    })

    it('pages Carousel slides with next', () => {
      const spec: Spec = {
        root: 'page',
        elements: {
          page: { type: 'Page', props: { title: 'Home' }, children: ['carousel'] },
          carousel: {
            type: 'Carousel',
            props: {
              statePath: 'slides',
              srcField: 'src',
              titleField: 'title',
              emptyText: 'None',
            },
            children: [],
          },
        },
      }
      const { container } = render({
        spec,
        state: {
          slides: [
            { src: 'https://cdn.example/a.png', title: 'One' },
            { src: 'https://cdn.example/b.png', title: 'Two' },
          ],
        },
      })
      expect(container.querySelector('[data-testid="gui-carousel"]')).toBeTruthy()
      expect(container.textContent).toContain('One')
      const next = container.querySelector('button[aria-label="Next slide"]') as HTMLButtonElement
      act(() => {
        next.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })
      expect(container.textContent).toContain('Two')
    })

    it('renders Kanban columns and Filmstrip chips', () => {
      const spec: Spec = {
        root: 'page',
        elements: {
          page: { type: 'Page', props: { title: 'Home' }, children: ['board', 'hours'] },
          board: {
            type: 'Kanban',
            props: {
              statePath: 'tasks',
              groupField: 'status',
              titleField: 'title',
              columns: 'Todo,Done',
            },
            children: [],
          },
          hours: {
            type: 'Filmstrip',
            props: {
              statePath: 'hourly',
              titleField: 'time',
              subtitleField: 'temperature_2m',
            },
            children: [],
          },
        },
      }
      const { container, onSelectItem } = render({
        spec,
        state: {
          tasks: [
            { id: '1', title: 'Draft', status: 'Todo' },
            { id: '2', title: 'Ship', status: 'Done' },
          ],
          hourly: [{ time: '09:00', temperature_2m: 21 }],
        },
      })
      expect(container.querySelector('[data-testid="gui-kanban"]')).toBeTruthy()
      expect(container.querySelector('[data-testid="gui-filmstrip"]')).toBeTruthy()
      expect(container.textContent).toContain('Draft')
      expect(container.textContent).toContain('09:00')
      const chip = Array.from(container.querySelectorAll('[data-testid="gui-filmstrip"] button'))[0]
      act(() => {
        chip?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })
      expect(onSelectItem).toHaveBeenCalled()
    })

    it('renders a bound List and maps weather_code onto a catalog Icon', () => {
      const spec: Spec = {
        root: 'page',
        elements: {
          page: { type: 'Page', props: { title: 'Home' }, children: ['list', 'icon'] },
          list: {
            type: 'List',
            props: { statePath: 'places', titleField: 'name', bodyField: 'region' },
            children: [],
          },
          icon: {
            type: 'Icon',
            props: { name: null, statePath: 'weather_code', well: 'none' },
            children: [],
          },
        },
      }
      const { container, onSelectItem } = render({
        spec,
        state: {
          places: [{ name: 'Austin', region: 'Texas' }],
          weather_code: 61,
        },
      })
      expect(container.querySelector('[data-testid="gui-collection-list"]')).toBeTruthy()
      expect(container.textContent).toContain('Austin')
      const row = container.querySelector('[data-testid="gui-collection-list"] button')
      act(() => {
        row?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })
      expect(onSelectItem).toHaveBeenCalled()
    })

    it('does not copy a nested History-detail List into selected', () => {
      const strengths = ['Item 1', 'Item 2', 'Item 6']
      const run = {
        id: 'run_1',
        enhanced_article: '# Article',
        competitor_strengths: strengths,
        coverage_gaps: [{ gap: 'Memory pricing' }],
      }
      const spec: Spec = {
        root: 'page',
        elements: {
          page: { type: 'Page', props: { title: 'Results' }, children: ['list'] },
          list: {
            type: 'List',
            props: {
              statePath: 'competitor_strengths',
              emptyText: 'No competitor strengths identified.',
            },
            children: [],
          },
        },
      }
      const { container, onSelectItem } = render({
        spec,
        state: {
          ...selectedItemHostState(run, 0),
          competitor_strengths: strengths,
          coverage_gaps: run.coverage_gaps,
        },
      })
      expect(container.querySelector('[data-testid="gui-collection-list"] button')).toBeNull()
      expect(container.textContent).toContain('Item 3')
      const row = container.querySelector('[data-testid="gui-collection-list"] li:last-child')
      act(() => {
        row?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })
      expect(onSelectItem).not.toHaveBeenCalled()
    })

    it('debounces a live SearchField into the declared action', () => {
      vi.useFakeTimers()
      try {
        const spec: Spec = {
          root: 'page',
          elements: {
            page: { type: 'Page', props: { title: 'Home' }, children: ['search'] },
            search: {
              type: 'SearchField',
              props: {
                name: 'query',
                placeholder: 'City',
                actionId: 'geocode',
                live: true,
                submitLabel: 'Search',
              },
              children: [],
            },
          },
        }
        const { container, onRunAction } = render({ spec })
        const input = container.querySelector('input[name="query"]') as HTMLInputElement
        const setValue = Object.getOwnPropertyDescriptor(
          window.HTMLInputElement.prototype,
          'value'
        )?.set
        act(() => {
          setValue?.call(input, 'Austin')
          input.dispatchEvent(new Event('input', { bubbles: true }))
        })
        expect(onRunAction).not.toHaveBeenCalled()
        act(() => {
          vi.advanceTimersByTime(280)
        })
        expect(onRunAction).toHaveBeenCalledWith(
          'geocode',
          expect.objectContaining({ query: 'Austin' })
        )
      } finally {
        vi.useRealTimers()
      }
    })

    it('renders Pagination, Breadcrumb, Tooltip, Popover, and CommandPalette', () => {
      const spec: Spec = {
        root: 'page',
        elements: {
          page: {
            type: 'Page',
            props: { title: 'Home' },
            children: ['trail', 'hint', 'pop', 'pager', 'palette'],
          },
          trail: {
            type: 'Breadcrumb',
            props: { items: 'Home|home\nOrders' },
            children: [],
          },
          hint: {
            type: 'Tooltip',
            props: { text: 'More info', label: 'Hint' },
            children: [],
          },
          pop: {
            type: 'Popover',
            props: { title: 'Help', label: 'Open help' },
            children: ['pop-body'],
          },
          'pop-body': {
            type: 'Text',
            props: { text: 'Popover body' },
            children: [],
          },
          pager: {
            type: 'Pagination',
            props: { statePath: 'rows', mode: 'pages' },
            children: [],
          },
          palette: {
            type: 'CommandPalette',
            props: {
              label: 'Commands',
              items: 'Home|home\nCreate|#create_task',
              placeholder: 'Search',
            },
            children: [],
          },
        },
      }
      const rows = Array.from({ length: 25 }, (_, index) => ({
        id: String(index),
        name: `R${index}`,
      }))
      const { container, onNavigate, onRunAction } = render({
        spec,
        state: { rows },
        currentPath: 'orders',
      })
      expect(container.querySelector('[data-testid="gui-breadcrumb"]')).toBeTruthy()
      expect(container.textContent).toContain('Home')
      expect(container.textContent).toContain('Orders')
      expect(container.querySelector('[data-testid="gui-tooltip"]')).toBeTruthy()
      expect(container.querySelector('[data-testid="gui-pagination"]')).toBeTruthy()
      expect(container.textContent).toContain('Showing 1–20 of 25')
      const next = container.querySelector('button[aria-label="Next page"]') as HTMLButtonElement
      act(() => {
        next.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })
      expect(container.textContent).toContain('Showing 21–25 of 25')
      const popTrigger = Array.from(container.querySelectorAll('button')).find(
        (node) => node.textContent === 'Open help'
      ) as HTMLButtonElement
      act(() => {
        popTrigger.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })
      expect(container.textContent).toContain('Popover body')
      const commandTrigger = Array.from(container.querySelectorAll('button')).find(
        (node) => node.textContent === 'Commands'
      ) as HTMLButtonElement
      act(() => {
        commandTrigger.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })
      expect(container.querySelector('[aria-label="Command palette"]')).toBeTruthy()
      const create = Array.from(container.querySelectorAll('button')).find((node) =>
        node.textContent?.includes('Create')
      ) as HTMLButtonElement
      act(() => {
        create.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })
      expect(onRunAction).toHaveBeenCalledWith('create_task', expect.any(Object))
      const homeCrumb = Array.from(
        container.querySelectorAll('[data-testid="gui-breadcrumb"] button')
      )[0] as HTMLButtonElement
      act(() => {
        homeCrumb.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })
      expect(onNavigate).toHaveBeenCalledWith('home')
    })

    it('uses authored Pagination for API load more and skips a second auto chrome', () => {
      const spec: Spec = {
        root: 'page',
        elements: {
          page: { type: 'Page', props: { title: 'Home' }, children: ['table', 'pager'] },
          table: {
            type: 'Table',
            props: { columns: 'name', statePath: 'articles' },
            children: [],
          },
          pager: {
            type: 'Pagination',
            props: { actionId: 'load_list', mode: 'more' },
            children: [],
          },
        },
      }
      const { container, onRunAction } = render({
        spec,
        state: {
          articles: Array.from({ length: 25 }, (_, index) => ({ name: `A${index}` })),
          hasMore: true,
        },
        actionHostKeys: { load_list: ['articles', 'hasMore', 'nextCursor'] },
      })
      expect(container.querySelectorAll('[data-testid="gui-pagination"]').length).toBe(1)
      expect(container.textContent).toContain('Load more')
      expect(container.textContent).not.toContain('Showing')
      const more = Array.from(container.querySelectorAll('button')).find(
        (node) => node.textContent === 'Load more'
      ) as HTMLButtonElement
      act(() => {
        more.dispatchEvent(new MouseEvent('click', { bubbles: true }))
      })
      expect(onRunAction).toHaveBeenCalledWith('load_list', expect.any(Object))
    })

    it('splices reorderable table rows with Alt+Arrow', () => {
      const spec: Spec = {
        root: 'page',
        elements: {
          page: { type: 'Page', props: { title: 'Home' }, children: ['table'] },
          table: {
            type: 'Table',
            props: { columns: 'name', statePath: 'items', reorderable: true },
            children: [],
          },
        },
      }
      const { container } = render({
        spec,
        state: {
          items: [
            { id: '1', name: 'A' },
            { id: '2', name: 'B' },
          ],
        },
      })
      const row = container.querySelector('tbody tr') as HTMLTableRowElement
      act(() => {
        row.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'ArrowDown', altKey: true, bubbles: true })
        )
      })
      const names = Array.from(container.querySelectorAll('tbody tr')).map(
        (row) => row.querySelectorAll('td')[1]?.textContent
      )
      expect(names[0]).toBe('B')
    })
  })
})
