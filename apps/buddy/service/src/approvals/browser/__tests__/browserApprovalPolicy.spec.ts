import type { BuddyInProcessExtension } from '../../../agent/extensions/BuddyInProcessExtension'
import type { BuddyToolClassificationResult } from '../../toolClassification'
import { describe, expect, it, vi } from 'vitest'
import { createToolPolicyExtension } from '../../../agent/extensions/toolPolicyExtension'
import {
  BROWSER_ACT_TOOL_NAME,
  classifyBrowserTool,
} from '../../../browser/browserToolContract'
import { ToolAuthorizationService } from '../../../permissions/ToolAuthorizationService'
import { ApprovalExpiredError } from '../../ApprovalService'

const ACTION_INPUT = {
  action: { kind: 'click', ref: 'e1' } as const,
  documentRevision: 2,
  frameId: 'main-frame',
  observationId: 'b3a5d63b-17b7-4b5a-863a-37f135e297d4',
  pageId: 'ed312709-baf9-44b3-a292-108055838477',
}

const BROWSER_REVIEW = {
  action: 'click' as const,
  actionDigest: 'a'.repeat(64),
  documentRevision: 2,
  effect: null,
  key: null,
  observationId: 'b3a5d63b-17b7-4b5a-863a-37f135e297d4',
  origin: 'https://example.com',
  pageId: 'ed312709-baf9-44b3-a292-108055838477',
  risk: 'interaction' as const,
  sessionId: '6f828cc1-6549-4245-b26e-43b2917c9281',
  targetName: 'Publish now',
  targetRole: 'button',
}

describe('browser approval policy', () => {
  it('provides a neutral review for permission modes that require approval', () => {
    const validateActionApproval = vi.fn(async () => null)
    const classification = classifyBrowserTool({
      input: ACTION_INPUT,
      toolName: BROWSER_ACT_TOOL_NAME,
    }, {
      classifyAction: () => ({
        approvalReview: BROWSER_REVIEW,
        access: 'interaction',
      }),
      validateActionApproval,
    })

    expect(classification).toMatchObject({
      access: 'interaction',
      approval: {
        browser: BROWSER_REVIEW,
        kind: 'browser',
        summary: 'Interact with a browser page',
      },
    })
    expect(classification).toHaveProperty('validateBeforeExecution')
  })

  it('keeps the browser capability instance bound during approval revalidation', async () => {
    const actionClassifier = new class {
      validated = false

      classifyAction() {
        return {
          approvalReview: BROWSER_REVIEW,
          access: 'interaction' as const,
        }
      }

      async validateActionApproval() {
        this.validated = true
        return null
      }
    }()
    const classification = classifyBrowserTool({
      input: ACTION_INPUT,
      toolName: BROWSER_ACT_TOOL_NAME,
    }, actionClassifier)

    if (
      !classification
      || 'blocked' in classification
      || !classification.validateBeforeExecution
    ) {
      throw new Error('Expected browser approval revalidation')
    }
    await expect(classification.validateBeforeExecution()).resolves.toBeNull()

    expect(actionClassifier.validated).toBe(true)
  })

  it.each(['full_access', 'workspace_write'] as const)('allows interactions under %s policy without approval', async (executionProfile) => {
    const validateActionApproval = vi.fn(async () => null)
    const classification = classifyBrowserTool({
      input: ACTION_INPUT,
      toolName: BROWSER_ACT_TOOL_NAME,
    }, {
      classifyAction: () => ({
        approvalReview: BROWSER_REVIEW,
        access: 'interaction',
      }),
      validateActionApproval,
    })
    const requestApproval = vi.fn(async () => ({
      approvalId: 'approval-1',
      decision: 'approved_once' as const,
    }))
    const onAuthorized = vi.fn(async () => {})
    const extension = createToolPolicyExtension({
      authorization: new ToolAuthorizationService({
        approvalAvailable: true,
        owner: { id: 'conversation-1', kind: 'conversation' as const },
        approvalService: { request: requestApproval },
        cwd: '/workspace',
        approvalPolicy: 'policy' as const,
        executionProfile,
        getGrants: () => [],
      }),
      classifyTool: () => classification as BuddyToolClassificationResult,
      getRunContext: () => ({
        flushProjectedEvents: async () => {},
        onToolExecutionAuthorized: onAuthorized,
        runId: 'run-1',
        signal: new AbortController().signal,
      }),
    })
    const invoke = activate(extension)

    await expect(invoke({
      input: ACTION_INPUT,
      toolCallId: 'tool-act',
      toolName: BROWSER_ACT_TOOL_NAME,
      type: 'tool_call',
    })).resolves.toBeUndefined()

    expect(requestApproval).not.toHaveBeenCalled()
    expect(onAuthorized).toHaveBeenCalledExactlyOnceWith({
      arguments: ACTION_INPUT,
      toolCallId: 'tool-act',
      toolName: BROWSER_ACT_TOOL_NAME,
    })
    expect(validateActionApproval).toHaveBeenCalledExactlyOnceWith(
      ACTION_INPUT,
      BROWSER_REVIEW,
    )
  })

  it.each([
    { executionProfile: 'workspace_write', approvalPolicy: 'manual', approvalAvailable: true, asks: true, allowed: true },
    { executionProfile: 'read_only', approvalPolicy: 'policy', approvalAvailable: true, asks: true, allowed: true },
    { executionProfile: 'workspace_write', approvalPolicy: 'manual', approvalAvailable: false, asks: false, allowed: false },
    { executionProfile: 'read_only', approvalPolicy: 'policy', approvalAvailable: false, asks: false, allowed: false },
    { executionProfile: 'workspace_write', approvalPolicy: 'policy', approvalAvailable: false, asks: false, allowed: true },
    { executionProfile: 'full_access', approvalPolicy: 'policy', approvalAvailable: false, asks: false, allowed: true },
  ] as const)('honors $executionProfile / $approvalPolicy with approvalAvailable=$approvalAvailable', async ({ executionProfile, approvalPolicy, approvalAvailable, asks, allowed }) => {
    const requestApproval = vi.fn(async () => ({ approvalId: 'approval-1', decision: 'approved_once' as const }))
    const onAuthorized = vi.fn(async () => {})
    const classification = classifyBrowserTool({ input: ACTION_INPUT, toolName: BROWSER_ACT_TOOL_NAME }, {
      classifyAction: () => ({ access: 'interaction', approvalReview: BROWSER_REVIEW }),
      validateActionApproval: async () => null,
    })
    const invoke = activate(createToolPolicyExtension({
      authorization: new ToolAuthorizationService({
        approvalAvailable,
        approvalPolicy,
        executionProfile,
        owner: { id: 'conversation-1', kind: 'conversation' },
        approvalService: { request: requestApproval },
        cwd: '/workspace',
        getGrants: () => [],
      }),
      classifyTool: () => classification as BuddyToolClassificationResult,
      getRunContext: () => ({
        flushProjectedEvents: async () => {},
        onToolExecutionAuthorized: onAuthorized,
        runId: 'run-1',
        signal: new AbortController().signal,
      }),
    }))
    const result = await invoke({ input: ACTION_INPUT, toolCallId: 'tool-act', toolName: BROWSER_ACT_TOOL_NAME, type: 'tool_call' })
    expect(result).toEqual(allowed ? undefined : { block: true, reason: 'APPROVAL_UNAVAILABLE_IN_BACKGROUND', terminate: false })
    expect(requestApproval).toHaveBeenCalledTimes(asks ? 1 : 0)
    expect(onAuthorized).toHaveBeenCalledTimes(allowed ? 1 : 0)
    if (asks)
      expect(requestApproval).toHaveBeenCalledWith(expect.objectContaining({ browser: BROWSER_REVIEW, kind: 'browser' }))
  })

  it.each(['policy', 'manual'] as const)('blocks stale targets before execution under %s approval policy', async (approvalPolicy) => {
    const validateActionApproval = vi.fn(async () => ({
      blocked: true as const,
      reason: 'BROWSER_TARGET_STALE' as const,
    }))
    const classification = classifyBrowserTool({
      input: ACTION_INPUT,
      toolName: BROWSER_ACT_TOOL_NAME,
    }, {
      classifyAction: () => ({
        approvalReview: BROWSER_REVIEW,
        access: 'interaction',
      }),
      validateActionApproval,
    })
    const requestApproval = vi.fn(async () => ({
      approvalId: 'approval-1',
      decision: 'approved_once' as const,
    }))
    const onAuthorized = vi.fn(async () => {})
    const extension = createToolPolicyExtension({
      authorization: new ToolAuthorizationService({
        approvalAvailable: true,
        owner: { id: 'conversation-1', kind: 'conversation' as const },
        approvalService: { request: requestApproval },
        cwd: '/workspace',
        approvalPolicy,
        executionProfile: 'workspace_write',
        getGrants: () => [],
      }),
      classifyTool: () => classification as BuddyToolClassificationResult,
      getRunContext: () => ({
        flushProjectedEvents: async () => {},
        onToolExecutionAuthorized: onAuthorized,
        runId: 'run-1',
        signal: new AbortController().signal,
      }),
    })

    await expect(activate(extension)({
      input: ACTION_INPUT,
      toolCallId: 'tool-act-stale',
      toolName: BROWSER_ACT_TOOL_NAME,
      type: 'tool_call',
    })).resolves.toEqual({
      block: true,
      reason: 'BROWSER_TARGET_STALE',
      terminate: false,
    })

    expect(requestApproval).toHaveBeenCalledTimes(approvalPolicy === 'manual' ? 1 : 0)
    expect(validateActionApproval).toHaveBeenCalledOnce()
    expect(onAuthorized).not.toHaveBeenCalled()
  })

  it('does not validate or authorize a browser action after the user denies it', async () => {
    const validateActionApproval = vi.fn(async () => null)
    const classification = classifyBrowserTool({
      input: ACTION_INPUT,
      toolName: BROWSER_ACT_TOOL_NAME,
    }, {
      classifyAction: () => ({
        approvalReview: BROWSER_REVIEW,
        access: 'interaction',
      }),
      validateActionApproval,
    })
    const requestApproval = vi.fn(async () => ({
      approvalId: 'approval-1',
      decision: 'denied' as const,
    }))
    const onAuthorized = vi.fn(async () => {})
    const invoke = activate(createToolPolicyExtension({
      authorization: new ToolAuthorizationService({
        approvalAvailable: true,
        owner: { id: 'conversation-1', kind: 'conversation' as const },
        approvalService: { request: requestApproval },
        cwd: '/workspace',
        approvalPolicy: 'manual' as const,
        executionProfile: 'workspace_write',
        getGrants: () => [],
      }),
      classifyTool: () => classification as BuddyToolClassificationResult,
      getRunContext: () => ({
        flushProjectedEvents: async () => {},
        onToolExecutionAuthorized: onAuthorized,
        runId: 'run-denied',
        signal: new AbortController().signal,
      }),
    }))

    await expect(invoke({
      input: ACTION_INPUT,
      toolCallId: 'tool-act-denied',
      toolName: BROWSER_ACT_TOOL_NAME,
      type: 'tool_call',
    })).resolves.toEqual({
      block: true,
      reason: 'APPROVAL_DENIED',
      terminate: false,
    })

    expect(requestApproval).toHaveBeenCalledOnce()
    expect(validateActionApproval).not.toHaveBeenCalled()
    expect(onAuthorized).not.toHaveBeenCalled()
  })

  it('does not retry or authorize a browser action after approval expiry', async () => {
    const validateActionApproval = vi.fn(async () => null)
    const classification = classifyBrowserTool({
      input: ACTION_INPUT,
      toolName: BROWSER_ACT_TOOL_NAME,
    }, {
      classifyAction: () => ({
        approvalReview: BROWSER_REVIEW,
        access: 'interaction',
      }),
      validateActionApproval,
    })
    const requestApproval = vi.fn(async () => {
      throw new ApprovalExpiredError()
    })
    const onAuthorized = vi.fn(async () => {})
    const invoke = activate(createToolPolicyExtension({
      authorization: new ToolAuthorizationService({
        approvalAvailable: true,
        owner: { id: 'conversation-1', kind: 'conversation' as const },
        approvalService: { request: requestApproval },
        cwd: '/workspace',
        approvalPolicy: 'manual' as const,
        executionProfile: 'workspace_write',
        getGrants: () => [],
      }),
      classifyTool: () => classification as BuddyToolClassificationResult,
      getRunContext: () => ({
        flushProjectedEvents: async () => {},
        onToolExecutionAuthorized: onAuthorized,
        runId: 'run-expired',
        signal: new AbortController().signal,
      }),
    }))

    await expect(invoke({
      input: ACTION_INPUT,
      toolCallId: 'tool-act-expired',
      toolName: BROWSER_ACT_TOOL_NAME,
      type: 'tool_call',
    })).resolves.toEqual({
      block: true,
      reason: 'AUTOMATION_APPROVAL_EXPIRED',
      terminate: false,
    })

    expect(requestApproval).toHaveBeenCalledOnce()
    expect(validateActionApproval).not.toHaveBeenCalled()
    expect(onAuthorized).not.toHaveBeenCalled()
  })
})

function activate(extension: BuddyInProcessExtension) {
  let handler: ((event: unknown) => Promise<unknown>) | null = null
  extension.factory({
    on(event: string, callback: (event: unknown) => Promise<unknown>) {
      if (event === 'tool_call')
        handler = callback
    },
  } as never)
  if (!handler)
    throw new Error('Tool policy extension did not register its tool_call handler')
  return handler as unknown as (event: {
    input: unknown
    toolCallId: string
    toolName: string
    type: 'tool_call'
  }) => Promise<unknown>
}
