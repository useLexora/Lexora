import type { ExtensionTaskSession } from '../conversations/ExtensionTaskContext'
import type { UsageService } from '../usage/UsageService'
import type { ProviderExecutionModelResolver } from './ProviderExecutionModelResolver'
import { extensionAgentHandler } from '../plugins/extensionAgentHandlers'

export function createExtensionModelCapabilities(models: Pick<ProviderExecutionModelResolver, 'resolveSession'>, usage: Pick<UsageService, 'record' | 'recordInvocation'>, task: Pick<ExtensionTaskSession, 'model' | 'assertCurrent'>) {
  return {
    'models.generateText': extensionAgentHandler('models.generateText', async (input, context) => {
      task.assertCurrent()
      const selection = input.model ?? task.model
      if (!selection)
        throw new Error('EXTENSION_MODEL_UNAVAILABLE')
      const { model, runtime } = await models.resolveSession({ ...selection, contextWindow: null, maxTokens: null })
      context.signal.throwIfAborted()
      task.assertCurrent()
      const result = await runtime.completeSimple(model, { systemPrompt: input.system, messages: [{ role: 'user', content: input.prompt, timestamp: Date.now() }] }, { signal: context.signal, maxTokens: input.maxTokens })
      const record = { createdAt: new Date().toISOString(), model: result.model, provider: result.provider, sourceEntryId: `plugin:${context.extensionId}:${context.invocationId}:${context.callNumber}`, usage: result.usage }
      if (context.action)
        usage.recordInvocation({ ...record, invocationId: context.invocationId })
      else if (context.runId)
        await usage.record({ ...record, purpose: 'tool', runId: context.runId })
      context.signal.throwIfAborted()
      task.assertCurrent()
      if (result.stopReason === 'error' || result.stopReason === 'aborted' || result.stopReason === 'length')
        throw new Error('EXTENSION_MODEL_FAILED')
      return { text: result.content.filter(block => block.type === 'text').map(block => block.text).join(''), model: { providerId: model.provider, modelId: model.id } }
    }),
  }
}
