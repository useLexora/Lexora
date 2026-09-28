import type { ApprovalRequestResult } from '../../../approvals/ApprovalService'
import type { BrowserCapabilityHost } from '../../../browser/BrowserCapabilityService'
import type { BuddyCapabilityServices } from '../../../createBuddyCapabilityFactory'
import type { BuddyCapabilityContext } from '../BuddyCapability'
import type { BuddySessionExtensionServices } from '../createBuddySessionExtensions'
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { resolveBuddyPlatform } from '../../../../../shared/platform'
import { createBuddyCapabilityFactory } from '../../../createBuddyCapabilityFactory'
import { PetActionService } from '../../../pet/PetActionService'
import { createBuddySessionExtensions } from '../createBuddySessionExtensions'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map(path => rm(path, {
    force: true,
    recursive: true,
  })))
})

describe('browser session extensions', () => {
  it('keeps capabilities available after the creating run is cancelled and stops them before session cleanup finishes', async () => {
    const root = await createTemporaryDirectory()
    const firstRun = new AbortController()
    const release = Promise.withResolvers<void>()
    const services = createCompositionServices(createUnavailableBrowserHost())
    let capabilityContext!: BuddyCapabilityContext
    let cleaned = false
    services.createCapabilities = async (context) => {
      capabilityContext = context
      return [{
        extension: { name: 'lexora-lifetime-fixture', factory() {} },
        classify: () => null,
        dispose: async () => {
          await release.promise
          cleaned = true
        },
      }]
    }
    const extensions = await createBuddySessionExtensions({ canonicalRoot: root, conversationId: 'conversation-1', approvalPolicy: 'policy', executionProfile: 'workspace_write', grants: [], services, sessionMode: 'interactive', signal: firstRun.signal, spaceId: null })
    firstRun.abort()
    extensions.runContext.current = { runId: 'run-next', signal: new AbortController().signal, flushProjectedEvents: async () => {}, onToolExecutionAuthorized: async () => {} }
    expect(capabilityContext.signal.aborted).toBe(false)
    expect(capabilityContext.getRunId()).toBe('run-next')
    const stopping = extensions.dispose()
    expect(capabilityContext.signal.aborted).toBe(true)
    expect(cleaned).toBe(false)
    release.resolve()
    await stopping
    expect(cleaned).toBe(true)
  })

  it('cancels capability construction and disposes a late accepted capability before rejecting startup', async () => {
    const root = await createTemporaryDirectory()
    const run = new AbortController()
    const entered = Promise.withResolvers<AbortSignal>()
    const ready = Promise.withResolvers<void>()
    const services = createCompositionServices(createUnavailableBrowserHost())
    let disposed = false
    services.createCapabilities = async (context) => {
      entered.resolve(context.signal)
      await ready.promise
      return [{
        extension: { name: 'lexora-late-fixture', factory() {} },
        classify: () => null,
        dispose: () => {
          disposed = true
        },
      }]
    }
    const preparing = createBuddySessionExtensions({ canonicalRoot: root, conversationId: 'conversation-1', approvalPolicy: 'policy', executionProfile: 'workspace_write', grants: [], services, sessionMode: 'interactive', signal: run.signal, spaceId: null })
    const rejected = expect(preparing).rejects.toMatchObject({ name: 'AbortError' })
    const scope = await entered.promise
    run.abort()
    expect(scope.aborted).toBe(true)
    ready.resolve()
    await rejected
    expect(disposed).toBe(true)
  })

  it.each(['interactive', 'automation_background'] as const)('keeps automation availability tied to session mode: %s', async (sessionMode) => {
    const root = await createTemporaryDirectory()
    const extensions = await createBuddySessionExtensions({
      canonicalRoot: root,
      conversationId: 'conversation-1',
      approvalPolicy: 'policy',
      executionProfile: 'workspace_write',
      grants: [],
      services: createCompositionServices(createUnavailableBrowserHost()),
      sessionMode,
      signal: new AbortController().signal,
      spaceId: null,
    })
    const names = extensions.inProcessExtensions.map(extension => extension.name)
    expect(names.includes('lexora-automation')).toBe(sessionMode === 'interactive')
    expect(names).toEqual(expect.arrayContaining(['lexora-tool-policy', 'lexora-change-capture', 'lexora-image-generation', 'lexora-image-transform']))
  })

  it('closes admission immediately and drains every capability even if one cleanup fails', async () => {
    const root = await createTemporaryDirectory()
    const release = Promise.withResolvers<void>()
    let finalFact = false
    const services = createCompositionServices(createUnavailableBrowserHost())
    services.createCapabilities = async () => [
      { extension: { name: 'lexora-failed-cleanup', factory() {} }, classify: () => null, dispose() { throw new Error('fixture-cleanup-failed') } },
      { extension: { name: 'lexora-draining', factory() {} }, classify: () => null, async dispose() {
        await release.promise

        finalFact = true
      } },
    ]
    const extensions = await createBuddySessionExtensions({ canonicalRoot: root, conversationId: 'conversation-1', approvalPolicy: 'policy', executionProfile: 'workspace_write', grants: [], services, sessionMode: 'interactive', signal: new AbortController().signal, spaceId: null })
    let settled = false
    const stopping = extensions.dispose()
    const rejected = expect(stopping).rejects.toThrow('SESSION_CAPABILITY_CLEANUP_FAILED').then(() => {
      settled = true
    })
    expect(extensions.toolCapabilities.snapshot.status).toBe('disposed')
    expect(extensions.dispose()).toBe(stopping)
    await Promise.resolve()
    expect(settled).toBe(false)
    release.resolve()
    await rejected
    expect(finalFact).toBe(true)
  })

  it('validates local HTML against the session grant before authorization', async () => {
    const root = await createTemporaryDirectory()
    const outside = await createTemporaryDirectory()
    const insidePath = join(root, 'inside.html')
    const outsidePath = join(outside, 'outside.html')
    await Promise.all([
      writeFile(insidePath, '<!doctype html><title>Inside</title>'),
      writeFile(outsidePath, '<!doctype html><title>Outside</title>'),
    ])
    const requestApproval = vi.fn(async (): Promise<ApprovalRequestResult> => ({
      approvalId: 'approval-1',
      decision: 'approved_once',
    }))
    const extensions = await createExtensions(root, requestApproval)
    const policy = activateToolPolicy(extensions)

    await expect(policy.invoke({
      input: { entryPath: insidePath, kind: 'local-file' },
      toolCallId: 'tool-open-inside',
      toolName: 'lexora_browser_open',
      type: 'tool_call',
    })).resolves.toBeUndefined()
    expect(requestApproval).not.toHaveBeenCalled()

    // Rendering a file outside the workspace asks, and approving it authorizes
    // the directory instead of leaving the model with an unrecoverable denial.
    await expect(policy.invoke({
      input: { entryPath: outsidePath, kind: 'local-file' },
      toolCallId: 'tool-open-outside',
      toolName: 'lexora_browser_open',
      type: 'tool_call',
    })).resolves.toBeUndefined()

    expect(requestApproval).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      kind: 'render',
      paths: {
        access: 'render',
        grant: { owner: 'conversation', root: outside },
        targets: [{ path: outsidePath, zone: 'outside' }],
      },
    }))
  })
})

async function createExtensions(
  root: string,
  requestApproval: () => Promise<ApprovalRequestResult>,
) {
  return createBuddySessionExtensions({
    canonicalRoot: root,
    conversationId: 'conversation-1',
    approvalPolicy: 'policy' as const,
    executionProfile: 'workspace_write',
    grants: [{
      canonicalRoot: root,
      grantId: 'conversation-1',
      kind: 'workspace' as const,
      root,
    }],
    services: createCompositionServices(
      createUnavailableBrowserHost(),
      requestApproval,
    ),
    sessionMode: 'interactive',
    signal: new AbortController().signal,
    spaceId: null,
  })
}

function activateToolPolicy(
  extensions: Awaited<ReturnType<typeof createBuddySessionExtensions>>,
) {
  let handler: ((event: unknown) => Promise<unknown>) | null = null
  const onAuthorized = vi.fn(async () => {})
  extensions.runContext.current = {
    flushProjectedEvents: async () => {},
    onToolExecutionAuthorized: onAuthorized,
    runId: 'run-1',
    signal: new AbortController().signal,
  }
  const extension = extensions.inProcessExtensions.find(
    candidate => candidate.name === 'lexora-tool-policy',
  )
  extension?.factory({
    on(event: string, callback: (event: unknown) => Promise<unknown>) {
      if (event === 'tool_call')
        handler = callback
    },
  } as never)
  if (!handler)
    throw new Error('Tool policy extension did not register its tool_call handler')
  return {
    invoke: handler as (event: unknown) => Promise<unknown>,
    onAuthorized,
  }
}

function createCompositionServices(
  browserHost: BrowserCapabilityHost,
  requestApproval: () => Promise<ApprovalRequestResult> = async () => ({
    approvalId: 'approval-1',
    decision: 'approved_once',
  }),
): BuddySessionExtensionServices {
  return {
    approvalService: { request: requestApproval },
    createCapabilities: createBuddyCapabilityFactory(resolveBuddyPlatform('linux'), {
      browserHost,
      connectorService: {
        getTools() {
          return { classifications: new Map(), diagnostics: [], tools: [], available: () => false }
        },
      },
    } as unknown as BuddyCapabilityServices, new PetActionService({
      peer: { request: async () => { throw new Error('No host action is expected during extensions') } },
    })),
    directoryGrants: {
      assertCurrent: () => {},
      grant: async (input: { owner: { id: string, kind: string }, root: string }) => ({
        changed: true,
        coveredGrantIds: [],
        grant: {
          canonicalRoot: input.root,
          id: `grant-${input.root}`,
          root: input.root,
        },
      }),
    },
  } as unknown as BuddySessionExtensionServices
}

async function createTemporaryDirectory(): Promise<string> {
  const path = await realpath(await mkdtemp(join(tmpdir(), 'lexora-browser-extension-')))
  directories.push(path)
  return path
}

function createUnavailableBrowserHost(): BrowserCapabilityHost {
  const unavailable = async (): Promise<never> => {
    throw new Error('Browser host should not be called while composing a session')
  }
  return {
    acquireControl: unavailable,
    act: unavailable,
    close: unavailable,
    getState: unavailable,
    observe: unavailable,
    openLocal: unavailable,
    openUrl: unavailable,
    releaseControl: unavailable,
    validateAction: unavailable,
  }
}
