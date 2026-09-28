import type { UsageService } from '../usage/UsageService'
import type { ProviderExecutionModelResolver } from './ProviderExecutionModelResolver'
import { extensionAgentHandler } from '../plugins/extensionAgentHandlers'

export function createExtensionModelCapabilities(models: Pick<ProviderExecutionModelResolver, 'resolveSession'>, usage: Pick<UsageService, 'record'>) {
  return {
    'models.generateText': extensionAgentHandler('models.generateText', async (input, context) => {
      const selection = input.model ?? context.model
      const { model, runtime } = await models.resolveSession({ ...selection, contextWindow: null, maxTokens: null })
      context.signal.throwIfAborted()
      const result = await runtime.completeSimple(model, { systemPrompt: input.system, messages: [{ role: 'user', content: input.prompt, timestamp: Date.now() }] }, { signal: context.signal, maxTokens: input.maxTokens })
      await usage.record({ createdAt: new Date().toISOString(), model: result.model, provider: result.provider, purpose: 'tool', runId: context.runId, sourceEntryId: `plugin:${context.extensionId}:${context.invocationId}:${context.callNumber}`, usage: result.usage })
      context.signal.throwIfAborted()
      if (result.stopReason === 'error' || result.stopReason === 'aborted' || result.stopReason === 'length')
        throw new Error('EXTENSION_MODEL_FAILED')
      return { text: result.content.filter(block => block.type === 'text').map(block => block.text).join(''), model: { providerId: model.provider, modelId: model.id } }
    }),
  }
}
