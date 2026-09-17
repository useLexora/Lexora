import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import type {
  BrowserObservation,
  BrowserStateSnapshot,
} from '../../../../shared/browser'
import type { ContextPanelOperationRecord } from '../../../../shared/context-panel/contextPanel'
import { Check } from 'typebox/value'
import { describe, expect, it, vi } from 'vitest'
import { ContextPanelHost } from '../../../../electron/main/context-panel/ContextPanelHost'
import { createBrowserExtension } from '../browserExtension'

const SESSION_ID = '6f828cc1-6549-4245-b26e-43b2917c9281'
const PAGE_ID = 'ed312709-baf9-44b3-a292-108055838477'
const OBSERVATION_ID = 'b3a5d63b-17b7-4b5a-863a-37f135e297d4'
const POST_ACTION_OBSERVATION_ID = '2e7d9de1-fd2f-4f83-aef2-74a3b830dc48'
type BrowserToolResultHandler = (event: Record<string, unknown>) => unknown

const READY_STATE: BrowserStateSnapshot = {
  canGoBack: false,
  canGoForward: false,
  controller: 'human',
  controlEpoch: 0,
  conversationId: 'conversation-1',
  error: null,
  pageId: PAGE_ID,
  profileMode: 'default',
  security: { kind: 'secure', origin: 'https://example.com' },
  sessionId: SESSION_ID,
  status: 'ready',
  title: 'Example',
  url: 'https://example.com/docs',
  visible: true,
}

const OBSERVATION: BrowserObservation = {
  documentRevision: 3,
  elements: [{
    actions: [],
    frameId: 'main-frame',
    inputMode: 'human',
    name: 'Password',
    ref: 'e1',
    role: 'textbox',
    states: ['editable'],
    valueState: 'redacted',
  }],
  observationId: OBSERVATION_ID,
  pageId: PAGE_ID,
  sessionId: SESSION_ID,
  status: 'ready',
  title: 'Example',
  truncated: false,
  url: 'https://example.com/docs',
}

const POST_ACTION_OBSERVATION: BrowserObservation = {
  ...OBSERVATION,
  documentRevision: 4,
  observationId: POST_ACTION_OBSERVATION_ID,
}

describe('browserExtension', () => {
  it('presents a successful browser through the desktop without changing the model result', async () => {
    const operations: ContextPanelOperationRecord[] = []
    const host = new ContextPanelHost(async (operation) => {
      operations.push(operation)
    })
    const source = { conversationId: 'conversation-1', runId: 'run-1' }
    const fixture = createFixture(async () => {
      await host.execute({ action: 'open', target: { kind: 'browser', source } }, 'harness')
    })
    fixture.service.open.mockResolvedValue({ ok: true, state: READY_STATE })
    fixture.service.observe.mockResolvedValue({ observation: OBSERVATION, ok: true })
    const open = requireTool(fixture.tools, 'lexora_browser_open')
    const first = await execute(open, { kind: 'url', url: READY_STATE.url })
    expect(host.getState()).toMatchObject({ open: true, target: { kind: 'browser', source } })
    expect(readContent(first)).toEqual(OBSERVATION)
    const second = await execute(open, { kind: 'url', url: READY_STATE.url })
    expect(second).toEqual(first)
    expect(operations.map(({ action, actor }) => ({ action, actor }))).toEqual([{ action: 'open', actor: 'harness' }])
    await host.execute({ action: 'close', source })
    await execute(requireTool(fixture.tools, 'lexora_browser_snapshot'), {})
    expect(host.getState().open).toBe(false)
    fixture.service.open.mockResolvedValue({ ok: false, error: { code: 'BROWSER_SESSION_NOT_FOUND', reason: null, recovery: 'open_again' } })
    expect((await execute(open, { kind: 'url', url: READY_STATE.url })).isError).toBe(true)
    expect(host.getState().open).toBe(false)
    expect(operations.map(operation => operation.action)).toEqual(['open', 'close'])
  })

  it('registers strict open, snapshot, and act tools', () => {
    const { tools } = createFixture()
    const act = requireTool(tools, 'lexora_browser_act')
    const open = requireTool(tools, 'lexora_browser_open')
    const snapshot = requireTool(tools, 'lexora_browser_snapshot')
    for (const tool of [open, snapshot, act])
      expect(tool.parameters).toMatchObject({ type: 'object' })

    expect([...tools.keys()]).toEqual([
      'lexora_browser_open',
      'lexora_browser_snapshot',
      'lexora_browser_act',
    ])
    expect(Check(open.parameters, {
      kind: 'url',
      url: 'https://example.com/docs',
    })).toBe(true)
    expect(Check(open.parameters, {
      kind: 'url',
      until: {
        condition: 'text-visible',
        text: 'Ready',
        timeoutMs: 8_000,
      },
      url: 'https://example.com/docs',
    })).toBe(true)
    expect(Check(open.parameters, {
      kind: 'url',
      until: {
        condition: 'ref-visible',
        ref: 'e1',
        timeoutMs: 8_000,
      },
      url: 'https://example.com/docs',
    })).toBe(false)
    expect(Check(open.parameters, {
      kind: 'url',
      until: {
        condition: 'text-visible',
        text: '   ',
        timeoutMs: 8_000,
      },
      url: 'https://example.com/docs',
    })).toBe(false)
    expect(Check(open.parameters, {
      javascript: 'document.body.innerHTML',
      kind: 'url',
      url: 'https://example.com/docs',
    })).toBe(false)
    expect(Check(open.parameters, {
      kind: 'url',
      selector: '#submit',
      url: 'https://example.com/docs',
    })).toBe(false)
    expect(Check(open.parameters, {
      cdp: 'Runtime.evaluate',
      entryPath: '/workspace/report.html',
      kind: 'local-file',
    })).toBe(false)
    expect(Check(open.parameters, {
      kind: 'url',
      url: 'javascript:alert(1)',
    })).toBe(false)
    expect(Check(snapshot.parameters, { maxElements: 400 })).toBe(true)
    expect(Check(snapshot.parameters, { maxElements: 401 })).toBe(false)
    expect(Check(snapshot.parameters, { selector: 'body' })).toBe(false)
    expect(Check(act.parameters, {
      action: { kind: 'fill', ref: 'e1', text: 'query' },
      documentRevision: 3,
      frameId: 'main-frame',
      observationId: OBSERVATION_ID,
      pageId: PAGE_ID,
    })).toBe(true)
    expect(Check(act.parameters, {
      action: {
        condition: 'url-matches',
        kind: 'wait',
        pattern: '/reports',
        timeoutMs: 8_000,
      },
      documentRevision: 3,
      observationId: OBSERVATION_ID,
      pageId: PAGE_ID,
    })).toBe(true)
    expect(Check(act.parameters, {
      action: {
        condition: 'ref-hidden',
        kind: 'wait',
        ref: 'e1',
        timeoutMs: 8_000,
      },
      documentRevision: 3,
      frameId: 'main-frame',
      observationId: OBSERVATION_ID,
      pageId: PAGE_ID,
    })).toBe(true)
    expect(Check(act.parameters, {
      action: { kind: 'fill', ref: 'e1', selector: '#search', text: 'query' },
      documentRevision: 3,
      frameId: 'main-frame',
      observationId: OBSERVATION_ID,
      pageId: PAGE_ID,
    })).toBe(false)
    expect(Check(act.parameters, {
      action: { kind: 'evaluate', script: 'document.body.innerHTML' },
      documentRevision: 3,
      observationId: OBSERVATION_ID,
      pageId: PAGE_ID,
    })).toBe(false)
  })

  it('opens URL and granted-local targets with an immediate semantic read', async () => {
    const fixture = createFixture()
    const until = {
      condition: 'text-visible' as const,
      elapsedMs: 320,
      satisfied: true,
    }
    fixture.service.open
      .mockResolvedValueOnce({ ok: true, state: READY_STATE, until })
      .mockResolvedValueOnce({ ok: true, state: READY_STATE })
    fixture.service.observe.mockResolvedValue({ observation: OBSERVATION, ok: true })
    const open = requireTool(fixture.tools, 'lexora_browser_open')
    const urlInput = {
      kind: 'url' as const,
      until: {
        condition: 'text-visible' as const,
        text: 'Example',
        timeoutMs: 8_000,
      },
      url: READY_STATE.url,
    }
    const localInput = {
      entryPath: '/workspace/report.html',
      kind: 'local-file' as const,
    }

    const urlResult = await execute(open, urlInput)
    const localResult = await execute(open, localInput)

    expect(fixture.service.open.mock.calls).toEqual([[urlInput, undefined], [localInput, undefined]])
    expect(fixture.service.observe.mock.calls).toEqual([[], []])
    expect(urlResult).toMatchObject({
      details: {
        operation: 'open',
        pageId: PAGE_ID,
        sessionId: SESSION_ID,
        status: 'ready',
        url: READY_STATE.url,
      },
      isError: false,
    })
    expect(readContent(urlResult)).toEqual({ observation: OBSERVATION, until })
    expect(readContent(localResult)).toEqual(OBSERVATION)
  })

  it('keeps a successful navigation successful when the immediate observation is unavailable', async () => {
    const fixture = createFixture()
    fixture.service.open.mockResolvedValue({ ok: true, state: READY_STATE })
    fixture.service.observe.mockResolvedValue({
      error: {
        code: 'BROWSER_PAGE_FAILED',
        reason: null,
        recovery: 'read_again',
      },
      ok: false,
    })
    const open = requireTool(fixture.tools, 'lexora_browser_open')

    const result = await execute(open, {
      kind: 'url',
      url: READY_STATE.url,
    })

    expect(result).toMatchObject({
      details: {
        observationStatus: 'unavailable',
        operation: 'open',
        pageId: PAGE_ID,
        sessionId: SESSION_ID,
        status: 'ready',
        url: READY_STATE.url,
        warningCode: 'BROWSER_PAGE_FAILED',
      },
      isError: false,
    })
    expect(readContent(result)).toEqual({
      observation: null,
      observationIssue: {
        code: 'BROWSER_PAGE_FAILED',
        reason: null,
        recovery: 'read_again',
      },
      opened: true,
      page: {
        pageId: PAGE_ID,
        status: 'ready',
        title: READY_STATE.title,
        url: READY_STATE.url,
      },
    })
  })

  it('returns the bounded semantic observation without duplicating it in details', async () => {
    const fixture = createFixture()
    fixture.service.observe.mockResolvedValue({ observation: OBSERVATION, ok: true })
    const snapshot = requireTool(fixture.tools, 'lexora_browser_snapshot')

    const result = await execute(snapshot, { maxElements: 120 })

    expect(fixture.service.observe).toHaveBeenCalledExactlyOnceWith({ maxElements: 120 })
    expect(result).toMatchObject({
      details: {
        documentRevision: 3,
        elementCount: 1,
        observationId: OBSERVATION_ID,
        operation: 'snapshot',
        pageId: PAGE_ID,
        sessionId: SESSION_ID,
        status: 'ready',
        truncated: false,
        url: OBSERVATION.url,
      },
      isError: false,
    })
    expect(result.details).not.toHaveProperty('elements')
    expect(result.details).not.toHaveProperty('screenshot')
    expect(readContent(result)).toEqual(OBSERVATION)
  })

  it('executes an action without copying its input into tool content or details', async () => {
    const fixture = createFixture()
    fixture.service.act.mockResolvedValue({
      actionKind: 'fill',
      ok: true,
      observation: POST_ACTION_OBSERVATION,
      state: READY_STATE,
    })
    const act = requireTool(fixture.tools, 'lexora_browser_act')
    const input = {
      action: { kind: 'fill' as const, ref: 'e1', text: 'private search phrase' },
      documentRevision: 3,
      frameId: 'main-frame',
      observationId: OBSERVATION_ID,
      pageId: PAGE_ID,
    }

    const result = await execute(act, input)

    expect(fixture.service.act).toHaveBeenCalledOnce()
    expect(fixture.service.act.mock.calls[0]?.[0]).toEqual(input)
    expect(result).toMatchObject({
      details: {
        actionKind: 'fill',
        operation: 'act',
        pageId: PAGE_ID,
        sessionId: SESSION_ID,
        status: 'ready',
        url: READY_STATE.url,
      },
      isError: false,
    })
    expect(JSON.stringify(result)).not.toContain('private search phrase')
    expect(readContent(result)).toEqual({
      actionKind: 'fill',
      observation: POST_ACTION_OBSERVATION,
    })
  })

  it('returns stable validation and Host failures without leaking exceptions', async () => {
    const fixture = createFixture()
    fixture.service.observe.mockResolvedValue({
      error: {
        code: 'BROWSER_SESSION_NOT_FOUND',
        reason: null,
        recovery: 'open_again',
      },
      ok: false,
    })
    const open = requireTool(fixture.tools, 'lexora_browser_open')
    const snapshot = requireTool(fixture.tools, 'lexora_browser_snapshot')
    const act = requireTool(fixture.tools, 'lexora_browser_act')

    const invalid = await execute(open, {
      kind: 'url',
      url: 'javascript:alert(1)',
    })
    const unavailable = await execute(snapshot, {})
    const invalidAction = await execute(act, {
      action: { kind: 'fill', ref: 'e1', text: 'must not execute' },
      documentRevision: 3,
      observationId: OBSERVATION_ID,
      pageId: PAGE_ID,
    })

    expect(invalid).toMatchObject({
      details: { code: 'VALIDATION_FAILED', operation: 'open', recovery: null },
      isError: true,
    })
    expect(readContent(invalid)).toEqual({
      code: 'VALIDATION_FAILED',
      reason: null,
      recovery: null,
    })
    expect(fixture.service.open).not.toHaveBeenCalled()
    expect(unavailable).toMatchObject({
      details: {
        code: 'BROWSER_SESSION_NOT_FOUND',
        operation: 'snapshot',
        recovery: 'open_again',
      },
      isError: true,
    })
    expect(readContent(unavailable)).toEqual({
      code: 'BROWSER_SESSION_NOT_FOUND',
      reason: null,
      recovery: 'open_again',
    })
    expect(invalidAction).toMatchObject({
      details: { code: 'VALIDATION_FAILED', operation: 'act', recovery: null },
      isError: true,
    })
    expect(fixture.service.act).not.toHaveBeenCalled()
  })

  it('preserves bounded Host failure reasons for model recovery', async () => {
    const fixture = createFixture()
    fixture.service.open.mockResolvedValue({
      error: {
        code: 'BROWSER_NAVIGATION_BLOCKED',
        reason: 'NON_PUBLIC_RESOLUTION',
        recovery: 'diagnose_network',
      },
      ok: false,
    })

    const result = await execute(requireTool(fixture.tools, 'lexora_browser_open'), {
      kind: 'url',
      url: 'https://example.com/',
    })

    expect(readContent(result)).toEqual({
      code: 'BROWSER_NAVIGATION_BLOCKED',
      reason: 'NON_PUBLIC_RESOLUTION',
      recovery: 'diagnose_network',
    })
    expect(result.details).toMatchObject({
      code: 'BROWSER_NAVIGATION_BLOCKED',
      operation: 'open',
      reason: 'NON_PUBLIC_RESOLUTION',
      recovery: 'diagnose_network',
    })
  })
})

function createFixture(onOpened?: () => Promise<void>) {
  const service = {
    act: vi.fn(),
    observe: vi.fn(),
    open: vi.fn(),
  }
  const tools = new Map<string, ToolDefinition>()
  let toolResultHandler: BrowserToolResultHandler | null = null
  createBrowserExtension({ service: service as never, onOpened }).factory({
    on(event: string, handler: (event: Record<string, unknown>) => unknown) {
      if (event === 'tool_result')
        toolResultHandler = handler
    },
    registerTool(tool: ToolDefinition) {
      tools.set(tool.name, tool)
    },
  } as never)
  return {
    service,
    toolResultHandler: toolResultHandler as BrowserToolResultHandler | null,
    tools,
  }
}

function requireTool(tools: Map<string, ToolDefinition>, name: string): ToolDefinition {
  const tool = tools.get(name)
  if (!tool)
    throw new Error(`Browser extension did not register ${name}`)
  return tool
}

async function execute(tool: ToolDefinition, input: unknown) {
  const invoke = tool.execute as unknown as (
    toolCallId: string,
    input: unknown,
    signal: AbortSignal,
  ) => Promise<{
    content: Array<{ text: string, type: 'text' }>
    details: Record<string, unknown>
    isError?: boolean
  }>
  return invoke('tool-call-1', input, new AbortController().signal)
}

function readContent(result: Awaited<ReturnType<typeof execute>>): unknown {
  const text = result.content[0]?.text
  if (!text)
    throw new Error('Browser tool result did not include text content')
  return JSON.parse(text)
}
