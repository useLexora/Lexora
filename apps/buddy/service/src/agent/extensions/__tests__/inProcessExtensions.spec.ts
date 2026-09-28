import type { SystemHostPort, SystemTarget } from '../../../system/systemCapability'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ModelRuntime } from '@earendil-works/pi-coding-agent'
import { Type } from 'typebox'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ToolAuthorizationService } from '../../../permissions/ToolAuthorizationService'

import {
  SystemActionPreparationRegistry,
  SystemCapabilityService,
} from '../../../system/systemCapability'
import { createSystemExtension } from '../../../system/systemExtension'
import { classifySystemTool } from '../../../system/systemToolContract'
import { createIsolatedBuddySession as createBuddySession } from '../../sessions/__tests__/isolatedBuddySession'
import { createToolPolicyExtension } from '../toolPolicyExtension'

const directories: string[] = []

afterEach(async () => {
  await Promise.all(directories.splice(0).map(path => rm(path, { force: true, recursive: true })))
})

describe('buddy in-process Pi extensions', () => {
  it('rejects an extension tool whose parameters are not an object-root schema', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'lexora-buddy-tool-schema-')))
    directories.push(root)
    const modelRuntime = await ModelRuntime.create({
      modelsPath: null,
      refreshOnCreate: false,
    })
    const model = modelRuntime.getModels()[0]
    if (!model)
      throw new Error('Pi did not expose a built-in model for the test')

    let failure: unknown
    try {
      await createBuddySession({
        agentDir: join(root, '.lexora-buddy'),
        branchId: 'branch-1',
        canonicalRoot: root,
        conversationId: 'conversation-1',
        conversationsDirectory: join(root, 'conversations'),
        cwd: root,
        approvalPolicy: 'policy' as const,
        executionProfile: 'workspace_write',
        inProcessExtensions: [{
          name: 'lexora-invalid-tool-schema',
          factory(pi) {
            pi.registerTool({
              description: 'Uses an invalid function-calling schema',
              async execute() {
                return { content: [{ type: 'text', text: 'invalid' }], details: undefined }
              },
              label: 'Invalid schema',
              name: 'lexora_invalid_schema',
              parameters: Type.Union([
                Type.Object({ url: Type.String() }),
                Type.Object({ entryPath: Type.String() }),
              ]),
            })
          },
        }],
        model,
        modelRuntime,
        resources: {
          skillReadRoots: [],
          skillReferences: [],
          approvedSkills: [],
          context: { agentsFiles: [], diagnostics: [] },
          directoryContext: '',
          revision: 'resources-1',
        },
      })
    }
    catch (error) {
      failure = error
    }

    expect(failure).toMatchObject({ code: 'BUDDY_EXTENSION_LOAD_FAILED' })
  })

  it('rejects unapproved inline extensions that override Pi tools', async () => {
    for (const toolName of ['bash', 'powershell', 'read']) {
      const root = await realpath(await mkdtemp(join(tmpdir(), 'lexora-buddy-tool-conflict-')))
      directories.push(root)
      const agentDir = join(root, '.lexora-buddy')
      const modelRuntime = await ModelRuntime.create({
        modelsPath: null,
        refreshOnCreate: false,
      })
      const model = modelRuntime.getModels()[0]
      if (!model)
        throw new Error('Pi did not expose a built-in model for the test')

      let failure: unknown
      try {
        await createBuddySession({
          agentDir,
          branchId: 'branch-1',
          canonicalRoot: root,
          conversationId: 'conversation-1',
          conversationsDirectory: join(root, 'conversations'),
          cwd: root,
          approvalPolicy: 'policy' as const,
          executionProfile: 'workspace_write',
          inProcessExtensions: [{
            name: 'lexora-conflicting-tool',
            factory(pi) {
              pi.registerTool({
                description: 'Conflicting shell replacement',
                async execute() {
                  return { content: [{ type: 'text', text: 'replaced' }], details: undefined }
                },
                label: 'Conflicting shell',
                name: toolName,
                parameters: Type.Object({}, { additionalProperties: false }),
              })
            },
          }],
          model,
          modelRuntime,
          resources: {
            skillReadRoots: [],
            skillReferences: [],
            approvedSkills: [],
            context: { agentsFiles: [], diagnostics: [] },
            directoryContext: '',
            revision: 'resources-1',
          },
        })
      }
      catch (error) {
        failure = error
      }
      expect(failure).toMatchObject({ code: 'BUDDY_EXTENSION_LOAD_FAILED' })
    }
  })

  it('exposes only the structured system action and executes it only after product approval', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'lexora-buddy-system-action-')))
    directories.push(root)
    const agentDir = join(root, '.lexora-buddy')
    const modelRuntime = await ModelRuntime.create({
      modelsPath: null,
      refreshOnCreate: false,
    })
    const model = modelRuntime.getModels()[0]
    if (!model)
      throw new Error('Pi did not expose a built-in model for the test')

    const target: SystemTarget = {
      allowedActions: ['terminate-process'],
      displayName: 'buddy-act-test',
      executable: '/usr/bin/sleep',
      interruption: 'none',
      kind: 'process',
      pid: 432_100,
      startedAt: '2026-08-23T12:00:00.000Z',
      instanceId: '9912345',
    }
    let running = true
    const host: SystemHostPort = {
      execute: vi.fn().mockImplementation(async () => {
        running = false
      }),
      readTarget: vi.fn().mockImplementation(async () => running ? target : null),
      resolveTargets: vi.fn().mockResolvedValue([target]),
    }
    const systemCapability = new SystemCapabilityService({
      actions: new SystemActionPreparationRegistry({
        now: () => Date.parse('2026-08-23T12:00:00.000Z'),
      }),
      host,
    })
    const approvalRequest = vi.fn()
      .mockResolvedValueOnce({ approvalId: 'approval-1', decision: 'denied' })
      .mockResolvedValueOnce({ approvalId: 'approval-2', decision: 'approved_once' })
    const runController = new AbortController()
    const result = await createBuddySession({
      agentDir,
      branchId: 'branch-1',
      inProcessExtensions: [
        createSystemExtension({ service: systemCapability }),
        createToolPolicyExtension({
          authorization: new ToolAuthorizationService({
            approvalAvailable: true,
            owner: { id: 'conversation-1', kind: 'conversation' as const },
            approvalService: { request: approvalRequest },
            cwd: root,
            approvalPolicy: 'policy' as const,
            executionProfile: 'workspace_write',
            getGrants: () => [{ canonicalRoot: root, grantId: 'workspace-1', kind: 'workspace' as const, root }],
          }),
          classifyTool: (event, run) => classifySystemTool(
            systemCapability,
            event,
            run.signal,
          ) ?? {},
          getRunContext: () => ({
            ...toolLifecycle(),
            runId: 'run-1',
            signal: runController.signal,
          }),
        }),
      ],
      canonicalRoot: root,
      conversationId: 'conversation-1',
      conversationsDirectory: join(root, 'conversations'),
      cwd: root,
      approvalPolicy: 'policy' as const,
      executionProfile: 'workspace_write',
      model,
      modelRuntime,
      resources: {
        skillReadRoots: [],
        skillReferences: [],
        approvedSkills: [],
        context: { agentsFiles: [], diagnostics: [] },
        directoryContext: '',
        revision: 'resources-1',
      },
    })

    try {
      expect(result.session.getActiveToolNames()).not.toContain('lexora_system_inspect')
      expect(result.session.getToolDefinition('lexora_system_inspect')).toBeUndefined()
      const input = {
        action: 'terminate-process' as const,
        reason: 'Finish the disposable acceptance target',
        target: {
          kind: 'process' as const,
          name: 'buddy-act-test',
        },
      }
      const toolCall = {
        input,
        toolCallId: 'tool-1',
        toolName: 'lexora_system_action',
        type: 'tool_call' as const,
      }

      await expect(result.session.extensionRunner.emitToolCall(toolCall)).resolves.toEqual({
        block: true,
        reason: 'APPROVAL_DENIED',
        terminate: false,
      })
      expect(host.execute).not.toHaveBeenCalled()

      await expect(result.session.extensionRunner.emitToolCall({
        ...toolCall,
        toolCallId: 'tool-2',
      })).resolves.toBeUndefined()
      const tool = result.session.getToolDefinition('lexora_system_action')
      const receipt = await tool?.execute(
        'tool-2',
        input,
        runController.signal,
        undefined,
        {} as never,
      )

      expect(approvalRequest).toHaveBeenCalledTimes(2)
      expect(host.resolveTargets).toHaveBeenCalledTimes(2)
      expect(approvalRequest).toHaveBeenLastCalledWith(expect.objectContaining({
        kind: 'system',
        systemAction: expect.objectContaining({
          action: 'terminate-process',
          target: {
            displayName: 'buddy-act-test',
            pid: 432_100,
            startedAt: '2026-08-23T12:00:00.000Z',
          },
        }),
      }))
      expect(host.execute).toHaveBeenCalledOnce()
      expect(receipt).toMatchObject({
        details: {
          receipt: {
            status: 'completed',
            verified: true,
          },
        },
        isError: false,
      })
    }
    finally {
      await result.shutdown('quit')
    }
  })

  it('expires the internal approved target binding before execution', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'lexora-buddy-expired-system-target-')))
    directories.push(root)
    const agentDir = join(root, '.lexora-buddy')
    const modelRuntime = await ModelRuntime.create({
      modelsPath: null,
      refreshOnCreate: false,
    })
    const model = modelRuntime.getModels()[0]
    if (!model)
      throw new Error('Pi did not expose a built-in model for the test')

    const target: SystemTarget = {
      allowedActions: ['terminate-process'],
      displayName: 'buddy-expiry-test',
      executable: '/usr/bin/sleep',
      interruption: 'none',
      kind: 'process',
      pid: 432_101,
      startedAt: '2026-08-23T12:00:00.000Z',
      instanceId: '9912346',
    }
    const host: SystemHostPort = {
      execute: vi.fn(),
      readTarget: vi.fn().mockResolvedValue(target),
      resolveTargets: vi.fn().mockResolvedValue([target]),
    }
    let now = Date.parse('2026-08-23T12:00:00.000Z')
    const systemCapability = new SystemCapabilityService({
      actions: new SystemActionPreparationRegistry({
        now: () => now,
        ttlMs: 1_000,
      }),
      host,
    })
    const approvalRequest = vi.fn()
      .mockImplementationOnce(async () => {
        now += 1_001
        return { approvalId: 'approval-1', decision: 'approved_once' as const }
      })
      .mockResolvedValue({ approvalId: 'approval-2', decision: 'denied' })
    const runController = new AbortController()
    const result = await createBuddySession({
      agentDir,
      branchId: 'branch-1',
      inProcessExtensions: [
        createSystemExtension({ service: systemCapability }),
        createToolPolicyExtension({
          authorization: new ToolAuthorizationService({
            approvalAvailable: true,
            owner: { id: 'conversation-1', kind: 'conversation' as const },
            approvalService: { request: approvalRequest },
            cwd: root,
            approvalPolicy: 'policy' as const,
            executionProfile: 'workspace_write',
            getGrants: () => [{ canonicalRoot: root, grantId: 'workspace-1', kind: 'workspace' as const, root }],
          }),
          classifyTool: (event, run) => classifySystemTool(
            systemCapability,
            event,
            run.signal,
          ) ?? {},
          getRunContext: () => ({
            ...toolLifecycle(),
            runId: 'run-1',
            signal: runController.signal,
          }),
        }),
      ],
      canonicalRoot: root,
      conversationId: 'conversation-1',
      conversationsDirectory: join(root, 'conversations'),
      cwd: root,
      approvalPolicy: 'policy' as const,
      executionProfile: 'workspace_write',
      model,
      modelRuntime,
      resources: {
        skillReadRoots: [],
        skillReferences: [],
        approvedSkills: [],
        context: { agentsFiles: [], diagnostics: [] },
        directoryContext: '',
        revision: 'resources-1',
      },
    })

    try {
      const input = {
        action: 'terminate-process' as const,
        reason: 'Finish the disposable expiry target',
        target: {
          kind: 'process' as const,
          pid: 432_101,
        },
      }
      await expect(result.session.extensionRunner.emitToolCall({
        input,
        toolCallId: 'tool-refreshed',
        toolName: 'lexora_system_action',
        type: 'tool_call',
      })).resolves.toBeUndefined()
      expect(approvalRequest).toHaveBeenCalledOnce()

      const actionTool = result.session.getToolDefinition('lexora_system_action')
      const executionResult = await actionTool?.execute(
        'tool-refreshed',
        input,
        runController.signal,
        undefined,
        {} as never,
      )
      expect(executionResult).toMatchObject({
        details: {
          code: 'SYSTEM_ACTION_EXPIRED',
          recoverable: true,
        },
        isError: true,
      })
      const executionContent = executionResult?.content[0]
      expect(executionContent?.type).toBe('text')
      expect(JSON.parse(executionContent?.type === 'text' ? executionContent.text : '')).toMatchObject({
        error: {
          code: 'SYSTEM_ACTION_EXPIRED',
          recoverable: true,
          recovery: {
            instruction: 'Retry lexora_system_action so Lexora Buddy can resolve and approve the current target again.',
            toolName: 'lexora_system_action',
          },
        },
      })
      expect(host.execute).not.toHaveBeenCalled()

      await expect(result.session.extensionRunner.emitToolCall({
        input,
        toolCallId: 'tool-latest',
        toolName: 'lexora_system_action',
        type: 'tool_call',
      })).resolves.toMatchObject({
        block: true,
        reason: 'APPROVAL_DENIED',
      })
      expect(approvalRequest).toHaveBeenCalledTimes(2)
      expect(host.execute).not.toHaveBeenCalled()
    }
    finally {
      await result.shutdown('quit')
    }
  })
})

function toolLifecycle() {
  return {
    flushProjectedEvents: async () => {},
    onToolExecutionAuthorized: async () => {},
  }
}
