import type {
  AgentClientAction,
  AgentGenerationCommand,
  ChatGenerationUsageSnapshot,
  ChatMemoryOperationProjection,
} from '@haohaoxue/lexora-contracts'
import type { BaseCheckpointSaver } from '@langchain/langgraph'
import type { AgentChatApiClient } from '../clients/chat'
import type { AgentMemoryApiClient } from '../clients/memory'
import type { AgentSkillApiClient } from '../clients/skills'
import type {
  AgentChatModelFactory,
  AgentChatModelOptions,
} from '../integrations/model-providers/chat-model'
import type { AgentModelStreamPart } from '../integrations/model-providers/stream-text'
import type { WebSearchClient } from '../integrations/web-search'
import type { AgentRuntimeTryLock } from '../runtime/lock'
import type {
  AgentEventPublisher,
  AgentRunner,
  ChatGenerationEvent,
} from '../runtime/typing'
import type { RuntimeSkillActionProvider } from './skills/action-providers'
import type { AgentRuntimeWarning } from './state'
import {
  AGENT_GENERATION_COMMAND_KIND,
  AgentClientActionSchema,
  AgentGenerationCommandSchema,
  AgentProfileConfigSchema,
  AgentRuntimeSkillCredentialsSchema,
  ChatGenerationBootstrapSchema,
} from '@haohaoxue/lexora-contracts'
import { Command } from '@langchain/langgraph'
import { createMemoryAgentRuntimeTryLock } from '../runtime/lock'
import {
  readAgentCheckpointState,
  resolveAgentGraphInput,
} from './checkpoint'
import {
  createAgentClientActionRequiredEvent,
  createAgentGenerationLifecycleEvent,
  emitAgentModelStreamPart,
} from './events'
import { createAgentGraph } from './graph'
import {
  resolveContextSnapshotsForDirectInvocation,
  resolveDirectInvocationRun,
} from './skills/direct-invocations'

interface AgentRunnerLogger {
  warn: (payload: Record<string, unknown>, message?: string) => void
}

interface CompletedAgentGenerationExecution {
  status: 'completed'
  responseText: string
  usageSnapshot?: ChatGenerationUsageSnapshot | null
  memoryOperations?: ChatMemoryOperationProjection[]
}

interface InterruptedAgentGenerationExecution {
  status: 'interrupted'
  action: AgentClientAction
}

type AgentGenerationExecution = CompletedAgentGenerationExecution | InterruptedAgentGenerationExecution
type AgentGraphInvokeInput = Parameters<ReturnType<typeof createAgentGraph>['invoke']>[0]

export interface CreateAgentRunnerInput {
  chatApi: AgentChatApiClient
  memoryApi?: AgentMemoryApiClient
  skillApi?: AgentSkillApiClient
  webSearch?: WebSearchClient
  skillActionProviders?: readonly RuntimeSkillActionProvider[]
  chatModelFactory: AgentChatModelFactory
  checkpointer?: BaseCheckpointSaver
  threadRunTryLock?: AgentRuntimeTryLock
  events?: AgentEventPublisher
  logger?: AgentRunnerLogger
  now?: () => number
}

export function createAgentRunner(inputs: CreateAgentRunnerInput): AgentRunner {
  const events = inputs.events ?? createNoopAgentEventPublisher()
  const now = inputs.now ?? (() => Date.now())
  const activeRuns = new Map<string, AbortController>()
  const graph = createAgentGraph({
    chatApi: inputs.chatApi,
    chatModelFactory: inputs.chatModelFactory,
    memoryApi: inputs.memoryApi,
    skillApi: inputs.skillApi,
    webSearch: inputs.webSearch,
    skillActionProviders: inputs.skillActionProviders,
    checkpointer: inputs.checkpointer,
  })
  const threadRunTryLock = inputs.threadRunTryLock ?? createMemoryAgentRuntimeTryLock()

  return {
    async submit(rawCommand) {
      const command = AgentGenerationCommandSchema.parse(rawCommand)
      const generationId = command.generationId

      if (activeRuns.has(generationId)) {
        throw new Error(`Agent generation is already running: ${generationId}`)
      }

      const abortController = new AbortController()
      const startedAt = now()
      activeRuns.set(generationId, abortController)
      await events.publish(createAgentGenerationLifecycleEvent({
        type: 'generation.started',
        generationId,
      }))

      try {
        const bootstrap = ChatGenerationBootstrapSchema.parse(await inputs.chatApi.getGenerationBootstrap({
          generationId,
        }))
        const result = await executeAgentGeneration({
          bootstrap,
          checkpointer: inputs.checkpointer,
          command,
          emit: async event => await events.publish(event),
          graph,
          logger: inputs.logger,
          signal: abortController.signal,
          threadRunTryLock,
        })
        const durationMs = now() - startedAt

        if (result.status === 'interrupted') {
          await events.publish(createAgentClientActionRequiredEvent({
            generationId,
            action: result.action,
          }))
          return {
            actionRequired: result.action,
          }
        }

        await events.publish(createAgentGenerationLifecycleEvent({
          type: 'generation.completed',
          generationId,
          payload: {
            durationMs,
            usage: result.usageSnapshot ?? undefined,
            memoryOperations: result.memoryOperations ?? [],
          },
        }))

        return {
          text: result.responseText,
          ...((result.memoryOperations?.length ?? 0) > 0 ? { memoryOperations: result.memoryOperations } : {}),
        }
      }
      catch (error) {
        if (abortController.signal.aborted) {
          await events.publish(createAgentGenerationLifecycleEvent({
            type: 'generation.cancelled',
            generationId,
            payload: {
              message: 'Agent generation cancelled',
            },
          }))
          return undefined
        }

        await events.publish(createAgentGenerationLifecycleEvent({
          type: 'generation.failed',
          generationId,
          payload: {
            message: getAgentGenerationErrorMessage(error),
          },
        }))
        throw error
      }
      finally {
        activeRuns.delete(generationId)
      }
    },

    cancel(generationId) {
      const abortController = activeRuns.get(generationId)

      if (!abortController) {
        return false
      }

      abortController.abort()
      return true
    },
  }
}

export async function executeAgentGeneration(input: {
  bootstrap: ReturnType<typeof ChatGenerationBootstrapSchema.parse>
  command: AgentGenerationCommand
  graph: ReturnType<typeof createAgentGraph>
  checkpointer?: BaseCheckpointSaver
  threadRunTryLock: AgentRuntimeTryLock
  signal: AbortSignal
  emit: (event: ChatGenerationEvent) => Promise<void> | void
  logger?: AgentRunnerLogger
}) {
  const profileConfig = AgentProfileConfigSchema.parse(input.bootstrap.agentProfile.currentConfig)
  const skillCredentials = AgentRuntimeSkillCredentialsSchema.parse(input.bootstrap.skillCredentials)
  const threadId = input.bootstrap.context.threadId
  const directInvocationRun = resolveDirectInvocationRun({
    messages: input.bootstrap.context.messages,
    contextSnapshots: input.bootstrap.context.contextSnapshots,
    triggerUserMessageId: input.bootstrap.context.triggerUserMessageId,
    threadId,
    generationId: input.bootstrap.generation.generationId,
    agentProfileConfig: profileConfig,
    skillContext: input.bootstrap.skills,
  })
  const directInvocation = Boolean(directInvocationRun)
  const graphThreadId = directInvocationRun?.graphThreadId ?? threadId
  const contextSnapshots = directInvocationRun
    ? resolveContextSnapshotsForDirectInvocation(directInvocationRun, input.bootstrap.context.contextSnapshots)
    : input.bootstrap.context.contextSnapshots
  const result = await input.threadRunTryLock.tryRunExclusive(graphThreadId, async () => {
    if (input.bootstrap.context.messages.length === 0) {
      throw new Error('聊天触发消息不存在')
    }

    const graphInput = input.command.kind === AGENT_GENERATION_COMMAND_KIND.RESUME
      ? createResumeGraphCommand(input.command)
      : await createStartGraphInput({
          bootstrap: input.bootstrap,
          checkpointer: input.checkpointer,
          directInvocation,
          threadId,
        })

    return await input.graph.invoke(graphInput, {
      signal: input.signal,
      configurable: {
        thread_id: graphThreadId,
      },
      context: {
        agentProfileConfig: profileConfig,
        skillContext: input.bootstrap.skills,
        skillCredentials,
        disabledSkillKeys: input.bootstrap.context.disabledSkillKeys,
        runtimeHints: input.bootstrap.context.runtimeHints,
        generationId: input.bootstrap.generation.generationId,
        actorUserId: input.bootstrap.generation.actorUserId,
        agentProfileId: input.bootstrap.agentProfile.profileId,
        contextPolicy: profileConfig.contextPolicy,
        defaultResponseLanguage: input.bootstrap.context.defaultResponseLanguage,
        modelLimits: input.bootstrap.model,
        modelOptions: toChatModelOptions(profileConfig),
        modelTarget: input.bootstrap.runtimeModelTarget,
        memoryIgnoredForRun: input.bootstrap.context.memory.ignoredForRun,
        ...directInvocationRun?.stateContext,
        triggerUserMessageId: input.bootstrap.context.triggerUserMessageId,
        contextSnapshots,
        inputAttachments: directInvocation ? [] : input.bootstrap.context.inputAttachments,
        onStreamPart: async (part: AgentModelStreamPart) => await emitAgentModelStreamPart(part, {
          emit: input.emit,
          generationId: input.bootstrap.generation.generationId,
        }),
        onRuntimeWarning: (warning: AgentRuntimeWarning) => input.logger?.warn({
          warning,
          generationId: input.bootstrap.generation.generationId,
          sessionId: input.bootstrap.context.sessionId,
          providerId: input.bootstrap.runtimeModelTarget.providerId,
          adapterKey: input.bootstrap.runtimeModelTarget.adapterKey,
          modelId: input.bootstrap.runtimeModelTarget.modelId,
          capabilities: input.bootstrap.runtimeModelTarget.capabilities,
        }, warning.message),
      },
    })
  })

  if (!result) {
    throw new Error(`聊天会话正在运行: ${input.bootstrap.context.sessionId}`)
  }

  const interruptedAction = readClientActionInterrupt(result)
  if (interruptedAction) {
    return {
      status: 'interrupted',
      action: interruptedAction,
    } satisfies AgentGenerationExecution
  }

  return createCompletedAgentGenerationExecution(result)
}

async function createStartGraphInput(input: {
  bootstrap: ReturnType<typeof ChatGenerationBootstrapSchema.parse>
  checkpointer?: BaseCheckpointSaver
  threadId: string
  directInvocation: boolean
}) {
  const checkpointState = input.directInvocation
    ? null
    : await readAgentCheckpointState(input.checkpointer, input.threadId)
  const graphInputDecision = resolveAgentGraphInput(
    input.bootstrap.context,
    checkpointState,
    { directInvocation: input.directInvocation },
  )

  if (graphInputDecision.shouldResetCheckpoint) {
    await input.checkpointer?.deleteThread(input.threadId)
  }

  return graphInputDecision.graphInput
}

function createResumeGraphCommand(command: AgentGenerationCommand): AgentGraphInvokeInput {
  if (!command.resume) {
    throw new Error('Resume generation command is missing resume payload')
  }

  return new Command({
    resume: command.resume,
  }) as AgentGraphInvokeInput
}

function readClientActionInterrupt(result: unknown): AgentClientAction | null {
  if (!isRecord(result) || !Array.isArray(result.__interrupt__)) {
    return null
  }

  for (const item of result.__interrupt__) {
    if (!isRecord(item)) {
      continue
    }

    const parsed = AgentClientActionSchema.safeParse(item.value)
    if (parsed.success) {
      return parsed.data
    }
  }

  return null
}

function createCompletedAgentGenerationExecution(result: unknown): CompletedAgentGenerationExecution {
  if (!isRecord(result) || typeof result.responseText !== 'string') {
    throw new Error('Agent graph completed without response text')
  }

  return {
    status: 'completed',
    responseText: result.responseText,
    usageSnapshot: isNullableRecord(result.usageSnapshot)
      ? result.usageSnapshot as ChatGenerationUsageSnapshot | null
      : null,
    memoryOperations: Array.isArray(result.memoryOperations)
      ? result.memoryOperations as ChatMemoryOperationProjection[]
      : [],
  }
}

function toChatModelOptions(profileConfig: ReturnType<typeof AgentProfileConfigSchema.parse>): AgentChatModelOptions {
  return removeUndefined({
    maxOutputTokens: profileConfig.modelPolicy.maxOutputTokens,
    reasoningEffort: profileConfig.modelPolicy.reasoningEffort,
    temperature: profileConfig.modelPolicy.temperature,
    topP: profileConfig.modelPolicy.topP,
  })
}

function createNoopAgentEventPublisher(): AgentEventPublisher {
  return {
    async publish() {},
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isNullableRecord(value: unknown): value is Record<string, unknown> | null {
  return value === null || isRecord(value)
}

function getAgentGenerationErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message.trim()
  }

  return 'Agent generation failed'
}

function removeUndefined<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  ) as T
}
