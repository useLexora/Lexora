import type { Api, Model } from '@earendil-works/pi-ai'
import type {
  AgentSession,
  CreateAgentSessionOptions,
  LoadExtensionsResult,
  ModelRuntime,
} from '@earendil-works/pi-coding-agent'
import type { BuddyServiceTier } from '../../../../shared/conversation/modelSelection'
import type { BuddyApprovalPolicy } from '../../../../shared/permissions/approvalPolicy'
import type { BuddyExecutionProfile } from '../../../../shared/permissions/executionProfile'
import type { BuddyInputReferenceV1 } from '../context/BuddyInputReference'
import type { BuddyInProcessExtension } from '../extensions/BuddyInProcessExtension'
import type { BuddySessionResources } from '../resources/BuddySessionResources'
import type { BoundedContextDiagnostic } from '../resources/loadBoundedContextFiles'
import type { BuddySessionShutdownReason } from './ReusableBuddySession'
import { realpath } from 'node:fs/promises'

import { join, resolve } from 'node:path'
import process from 'node:process'
import {
  calculateContextTokens,
  convertToLlm,
  createAgentSession,
  getLatestCompactionEntry,
  SessionManager,
} from '@earendil-works/pi-coding-agent'
import { containsCanonicalPath } from '../../../../platform/filesystem/filePaths'
import { buildBuddyRequestContext } from '../context/buildBuddyRequestContext'
import { createEstimatedContextUsage } from '../context/contextUsageBreakdown'
import { prepareBuddyInputHistory } from '../context/prepareBuddyInputHistory'
import {
  getActivePiBuiltinToolNames,
  isPiShellToolName,
} from '../extensions/piBuiltinTools'
import {
  createBuddyResourceLoader,
  createBuddySettingsManager,
} from '../resources/createBuddyResourceLoader'
import {
  BuddySessionCreationError,
} from './BuddySessionErrors'
import { installBuddySystemSections } from './installBuddySystemSections'

const sessionIdentityPattern = /^[A-Z0-9][\w-]{0,127}$/i

export interface CreateBuddySessionOptions {
  getInputMessages?: () => AgentSession['messages']
  getPendingInput?: () => BuddyInputReferenceV1 | null
  sessionManager: SessionManager
  agentDir: string
  approvalPolicy: BuddyApprovalPolicy
  branchId: string
  canonicalRoot: string
  conversationsDirectory: string
  conversationId: string
  cwd: string
  executionProfile: BuddyExecutionProfile
  getServiceTier?: () => BuddyServiceTier | null
  model?: Model<Api>
  modelRuntime: ModelRuntime
  platform?: NodeJS.Platform
  inProcessExtensions: readonly BuddyInProcessExtension[]
  resources: BuddySessionResources
  thinkingLevel?: CreateAgentSessionOptions['thinkingLevel']
}

export interface CreatedBuddySession {
  extensionsResult: LoadExtensionsResult
  piSessionFile: string
  resourceDiagnostics: readonly BoundedContextDiagnostic[]
  session: AgentSession
  shutdown: (reason: BuddySessionShutdownReason) => Promise<void>
}

export type BuddyContextSnapshot = ReturnType<typeof createEstimatedContextUsage> | null

export async function createBuddySession(
  options: CreateBuddySessionOptions,
): Promise<CreatedBuddySession> {
  validateSessionIdentity(options.conversationId)
  validateSessionIdentity(options.branchId)

  const [canonicalRoot, cwd] = await Promise.all([
    realpath(options.canonicalRoot),
    realpath(options.cwd),
  ])
  if (!containsCanonicalPath(canonicalRoot, cwd))
    throw new BuddySessionCreationError()

  const agentDir = resolve(options.agentDir)
  const canonicalSessionDir = await realpath(join(resolve(options.conversationsDirectory), options.conversationId, 'session'))
  const { sessionManager } = options
  const piSessionFile = sessionManager.getSessionFile()
  if (!piSessionFile || !containsCanonicalPath(canonicalSessionDir, resolve(piSessionFile)))
    throw new BuddySessionCreationError()
  const resumed = sessionManager.getEntries().some(entry => entry.type === 'message')

  const result = await createConfiguredBuddySession(options, {
    agentDir,
    cwd,
    sessionManager,
    sessionStartEvent: {
      type: 'session_start',
      reason: resumed ? 'resume' : 'startup',
      previousSessionFile: resumed ? piSessionFile : undefined,
    },
  })
  const shutdown = createSessionShutdown(result.session)

  return {
    extensionsResult: result.extensionsResult,
    piSessionFile,
    resourceDiagnostics: options.resources.context.diagnostics,
    session: result.session,
    shutdown,
  }
}

export async function createBuddyContextSnapshot(
  options: CreateBuddySessionOptions,
): Promise<BuddyContextSnapshot> {
  validateSessionIdentity(options.conversationId)
  validateSessionIdentity(options.branchId)

  const [canonicalRoot, cwd] = await Promise.all([
    realpath(options.canonicalRoot),
    realpath(options.cwd),
  ])
  if (!containsCanonicalPath(canonicalRoot, cwd))
    throw new BuddySessionCreationError()

  const agentDir = resolve(options.agentDir)
  const persistedSession = options.sessionManager
  const persistedContextUsageUnknown = hasUnknownPostCompactionUsage(persistedSession)
  const recoveryMessages = convertToLlm(prepareBuddyInputHistory(persistedSession.buildSessionContext().messages))
  const sessionManager = SessionManager.inMemory(cwd)
  for (const message of recoveryMessages)
    sessionManager.appendMessage(message)

  const result = await createConfiguredBuddySession(options, {
    agentDir,
    cwd,
    sessionManager,
    sessionStartEvent: {
      type: 'session_start',
      reason: persistedSession.getEntries().some(entry => entry.type === 'message') ? 'resume' : 'startup',
      previousSessionFile: persistedSession.getSessionFile(),
    },
  })
  try {
    if (persistedContextUsageUnknown)
      return null

    const tools = result.session.getActiveToolNames().flatMap((name) => {
      const tool = result.session.getToolDefinition(name)
      return tool
        ? [{ description: tool.description, name: tool.name, parameters: tool.parameters }]
        : []
    })
    return createEstimatedContextUsage(buildBuddyRequestContext({
      messages: convertToLlm(prepareBuddyInputHistory(result.session.messages)).filter(message => message.role !== 'system'),
      systemPrompt: result.session.systemPrompt,
      tools,
    }, result.session.getAllTools()))
  }
  finally {
    await createSessionShutdown(result.session)('quit')
  }
}

function hasUnknownPostCompactionUsage(sessionManager: SessionManager): boolean {
  const branch = sessionManager.getBranch()
  const latestCompaction = getLatestCompactionEntry(branch)
  if (!latestCompaction)
    return false

  const compactionIndex = branch.lastIndexOf(latestCompaction)
  return !branch.slice(compactionIndex + 1).some((entry) => {
    if (entry.type !== 'message' || entry.message.role !== 'assistant')
      return false
    const message = entry.message
    return message.stopReason !== 'aborted'
      && message.stopReason !== 'error'
      && calculateContextTokens(message.usage) > 0
  })
}

function createSessionShutdown(
  session: AgentSession,
): (reason: BuddySessionShutdownReason) => Promise<void> {
  let shutdown: Promise<void> | null = null
  return (reason) => {
    shutdown ??= (async () => {
      try {
        await session.extensionRunner.emit({
          reason: reason === 'resource-change' || reason === 'invalidate' ? 'reload' : 'quit',
          type: 'session_shutdown',
        })
      }
      finally {
        session.dispose()
      }
    })()
    return shutdown
  }
}

interface ConfiguredBuddySessionRuntime {
  agentDir: string
  cwd: string
  sessionManager: SessionManager
  sessionStartEvent: NonNullable<CreateAgentSessionOptions['sessionStartEvent']>
}

async function createConfiguredBuddySession(
  options: CreateBuddySessionOptions,
  runtime: ConfiguredBuddySessionRuntime,
) {
  const context = options.resources.context
  const settingsManager = createBuddySettingsManager()
  const resourceLoader = await createBuddyResourceLoader({
    getPendingInput: options.getPendingInput,
    approvedSkillPaths: [...options.resources.approvedSkillPaths],
    agentDir: runtime.agentDir,
    approvalPolicy: options.approvalPolicy,
    boundedContextFiles: context.agentsFiles,
    cwd: runtime.cwd,
    directoryContext: options.resources.directoryContext,
    inProcessExtensions: options.inProcessExtensions,
    executionProfile: options.executionProfile,
    platform: options.platform,
    settingsManager,
  })
  const result = await createAgentSession({
    agentDir: runtime.agentDir,
    cwd: runtime.cwd,
    model: options.model,
    modelRuntime: options.modelRuntime,
    resourceLoader,
    sessionManager: runtime.sessionManager,
    sessionStartEvent: runtime.sessionStartEvent,
    settingsManager,
    thinkingLevel: options.thinkingLevel,
  })
  const platform = options.platform ?? process.platform
  result.session.setActiveToolsByName([...new Set([
    ...result.session.getActiveToolNames().filter(toolName => !isPiShellToolName(toolName)),
    ...getActivePiBuiltinToolNames(platform),
  ])])
  try {
    await result.session.bindExtensions({ mode: 'rpc' })
  }
  catch (error) {
    await createSessionShutdown(result.session)('quit')
    throw error
  }
  const previousPayloadTransform = result.session.agent.onPayload
  installBuddySystemSections(result.session, options.getInputMessages)
  result.session.agent.onPayload = async (payload, model) => {
    const previousPayload = await previousPayloadTransform?.(payload, model)
    return applyBuddyOpenAiRequestOptions(
      previousPayload ?? payload,
      model,
      options.getServiceTier?.() ?? null,
    ) ?? previousPayload
  }
  return result
}

function validateSessionIdentity(value: string): void {
  if (!sessionIdentityPattern.test(value))
    throw new BuddySessionCreationError()
}

function applyBuddyOpenAiRequestOptions(
  payload: unknown,
  model: Model<Api>,
  serviceTier: BuddyServiceTier | null,
): unknown | undefined {
  if (!isRecord(payload))
    return undefined

  const supportsServiceTier = model.api === 'openai-responses'
    || model.api === 'openai-codex-responses'
  const requestsDetailedSummary = model.api === 'openai-codex-responses'
    && isRecord(payload.reasoning)
  if (!requestsDetailedSummary && (!serviceTier || !supportsServiceTier))
    return undefined

  const nextPayload = { ...payload }
  if (requestsDetailedSummary) {
    nextPayload.reasoning = {
      ...(payload.reasoning as Record<string, unknown>),
      summary: 'detailed',
    }
  }
  if (serviceTier && supportsServiceTier)
    nextPayload.service_tier = serviceTier
  return nextPayload
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
