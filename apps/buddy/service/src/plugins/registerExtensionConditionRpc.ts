import type { ExtensionConditionRuntime } from '../../../shared/extensions/extensionConditionContext'
import type { ProviderService } from '../providers/ProviderService'
import type { RuntimeRequestRegistrar } from '../rpc/runtimeRequest'
import type { ConversationRepository } from '../storage/conversationRepository'
import type { ExtensionTaskContextRepository } from '../storage/extensionTaskContextRepository'
import type { RunInputRepository } from '../storage/runInputRepository'
import type { RunRepository } from '../storage/runRepository'
import { createHash } from 'node:crypto'
import { extensionConditionSnapshotRpc } from '../../../shared/extensions/extensionConditionContext'
import { registerRuntimeRequest } from '../rpc/runtimeRequest'

export function registerExtensionConditionRpc(options: {
  rpc: RuntimeRequestRegistrar
  tasks: Pick<ConversationRepository, 'findById' | 'getTitleState'>
  history: ExtensionTaskContextRepository
  runs: Pick<RunRepository, 'findById'>
  inputs: Pick<RunInputRepository, 'findByMessageId'>
  providers: Pick<ProviderService, 'listModels' | 'listProviders' | 'getDefaultModel'>
}): () => void {
  return registerRuntimeRequest(options.rpc, extensionConditionSnapshotRpc, async (input, signal) => {
    const result: ExtensionConditionRuntime = { models: { status: 'not_requested' }, task: { status: 'not_requested' } }
    const catalog = input.models ? await Promise.all([options.providers.listModels(), options.providers.listProviders(), options.providers.getDefaultModel()]) : null
    signal?.throwIfAborted()
    const task = input.taskId ? options.tasks.findById(input.taskId) : null
    const available = task && task.deletedAt === null && task.activeBranchId
    const latestInput = available ? options.history.latestInput(task.id, task.activeBranchId!) : null
    const runId = input.runId ?? (latestInput ? options.inputs.findByMessageId(latestInput)?.runId : null)
    const run = runId ? options.runs.findById(runId) : null
    const validRun = available && run?.conversationId === task.id && run.branchId === task.activeBranchId ? run : null
    const runSelection = validRun ? { providerId: validRun.provider, modelId: validRun.model } : null
    const taskSelection = available ? task.modelSelection ?? runSelection : null
    const selection = input.runId ? runSelection : taskSelection
    if (input.task) {
      if (available) {
        const state = options.tasks.getTitleState(task.id)!
        const value = { id: task.id, spaceId: task.spaceId, branchId: task.activeBranchId!, title: task.title, titleSource: state.source, activity: options.history.activity(task.id), modelSelection: taskSelection ? { providerId: taskSelection.providerId, modelId: taskSelection.modelId } : null }
        result.task = { status: 'available', revision: revision(value), ...value }
      }
      else {
        result.task = { status: input.taskId ? 'invalid' : 'no_context' }
      }
    }
    if (catalog) {
      const [models, providers, fallback] = catalog
      const chosen = input.taskId ? selection : fallback
      const value = {
        selection: chosen ? { providerId: chosen.providerId, modelId: chosen.modelId } : null,
        models: models.map(model => ({ providerId: model.providerId, modelId: model.id, name: model.displayName, available: model.available && model.enabled && providers.some(provider => provider.id === model.providerId && provider.enabled && provider.status === 'available'), capabilities: model.capabilities })),
      }
      result.models = { status: 'available', revision: revision(value), ...value }
    }
    return result
  })
}

function revision(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}
