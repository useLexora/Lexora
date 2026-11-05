import type { AssistantMessage, ImageContent, ProviderStreams, TextContent } from '@earendil-works/pi-ai'
import type { ExtensionChatCapabilities, ExtensionChatEvent, ExtensionChatRequest, ExtensionModel } from '../../../shared/extensions/extensionChat'
import type { InputModel } from './modelCapabilities'
import { Buffer } from 'node:buffer'
import { createAssistantMessageEventStream, createProvider, getCurrentTools, getSystemMessageText, normalizeContext, resolveTranscript } from '@earendil-works/pi-ai'
import { extensionChatMaxBytes, extensionChatRequestSchema, pluginChatApi, pluginProviderId } from '../../../shared/extensions/extensionChat'

const cost = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
export function createPluginProvider(models: ExtensionModel[], invoke: (target: ExtensionModel, input: ExtensionChatRequest, signal: AbortSignal, emit: (event: ExtensionChatEvent) => void, capabilities: ExtensionChatCapabilities) => Promise<void>, resolveTools = (model: ExtensionModel) => model.tools === true, resolveReasoning = (model: ExtensionModel) => model.reasoning === true) {
  const toolCalling = new Map(models.map(model => [model.id, resolveTools(model)]))
  const first = models[0]!
  const providerId = pluginProviderId(first.extensionId)
  const stream: ProviderStreams['streamSimple'] = (model, context, options) => {
    const output = createAssistantMessageEventStream()
    const message: AssistantMessage = { role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id, stopReason: 'stop', timestamp: Date.now(), usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { ...cost, total: 0 } } }
    const signal = options?.signal ?? new AbortController().signal
    const target = models.find(candidate => candidate.id === model.id)
    void (async () => {
      signal.throwIfAborted()
      if (!target)
        throw new Error('EXTENSION_INFERENCE_UNAVAILABLE')
      const transcript = resolveTranscript(normalizeContext(context), false)
      const capabilities = { toolCall: (model as InputModel).toolCall === true, image: model.input.includes('image') }
      const supportsTools = capabilities.toolCall
      const tools = supportsTools ? getCurrentTools(transcript.messages) : []
      const text = (content: string | ReadonlyArray<{ type: string, text?: string }>) => {
        if (typeof content === 'string')
          return content
        if (content.some(part => !['text', 'thinking', 'toolCall'].includes(part.type)))
          throw new Error('EXTENSION_INFERENCE_INPUT_UNSUPPORTED')
        return content.filter(part => part.type === 'text').map(part => part.text ?? '').join('\n')
      }
      const inputContent = (content: string | readonly (TextContent | ImageContent)[]) => {
        if (typeof content === 'string' || !content.some(part => part.type === 'image'))
          return { text: text(content) }
        if (!capabilities.image)
          throw new Error('EXTENSION_INFERENCE_INPUT_UNSUPPORTED')
        return { content: content.map((part) => {
          if (part.type === 'text')
            return { type: 'text' as const, text: part.text }
          if (part.type === 'image' && ['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(part.mimeType))
            return { type: 'image' as const, mimeType: part.mimeType, data: part.data }
          throw new Error('EXTENSION_INFERENCE_INPUT_UNSUPPORTED')
        }) }
      }
      const request = extensionChatRequestSchema.parse({
        model: target.id,
        messages: transcript.messages.map((entry) => {
          if (entry.role === 'system')
            return { role: 'system', text: getSystemMessageText(entry) }
          if (entry.role === 'user')
            return { role: 'user', ...inputContent(entry.content) }
          if (entry.role === 'assistant')
            return { role: 'assistant', text: text(entry.content), toolCalls: entry.content.filter(part => part.type === 'toolCall').map(({ id, name, arguments: args }) => ({ id, name, arguments: args })) }
          return { role: 'tool', ...inputContent(entry.content), toolCallId: entry.toolCallId, name: entry.toolName, isError: entry.isError }
        }),
        tools: tools.map(tool => ({ name: tool.name, description: tool.description, parameters: tool.parameters })),
        maxTokens: Math.min(options?.maxTokens ?? model.maxTokens, target.maxTokens),
        ...(options?.temperature !== undefined ? { temperature: options.temperature } : {}),
        reasoning: options?.reasoning ?? 'off',
      })
      if (Buffer.byteLength(JSON.stringify(request)) > extensionChatMaxBytes)
        throw new Error('EXTENSION_INFERENCE_CONTEXT_TOO_LARGE')
      let completed = false
      let textIndex: number | undefined
      let thinkingIndex: number | undefined
      let bytes = 0
      const toolIds = new Set<string>()
      output.push({ type: 'start', partial: message })
      const endText = () => {
        const part = textIndex === undefined ? undefined : message.content[textIndex]
        if (part?.type === 'text')
          output.push({ type: 'text_end', contentIndex: textIndex!, content: part.text, partial: message })
        textIndex = undefined
      }
      const endThinking = () => {
        const part = thinkingIndex === undefined ? undefined : message.content[thinkingIndex]
        if (part?.type === 'thinking')
          output.push({ type: 'thinking_end', contentIndex: thinkingIndex!, content: part.thinking, partial: message })
        thinkingIndex = undefined
      }
      await invoke(target, request, signal, (event) => {
        signal.throwIfAborted()
        bytes += Buffer.byteLength(JSON.stringify(event))
        if (completed || bytes > 16 * 1024 * 1024)
          throw new Error('EXTENSION_INFERENCE_OUTPUT_INVALID')
        if (event.type === 'thinking') {
          if (!model.reasoning || request.reasoning === 'off')
            throw new Error('EXTENSION_INFERENCE_OUTPUT_INVALID')
          endText()
          if (thinkingIndex === undefined) {
            thinkingIndex = message.content.length
            message.content.push({ type: 'thinking', thinking: '' })
            output.push({ type: 'thinking_start', contentIndex: thinkingIndex, partial: message })
          }
          const part = message.content[thinkingIndex]!
          if (part.type === 'thinking')
            part.thinking += event.text
          output.push({ type: 'thinking_delta', contentIndex: thinkingIndex, delta: event.text, partial: message })
        }
        else if (event.type === 'text') {
          endThinking()
          if (textIndex === undefined) {
            textIndex = message.content.length
            message.content.push({ type: 'text', text: '' })
            output.push({ type: 'text_start', contentIndex: textIndex, partial: message })
          }
          const part = message.content[textIndex]!
          if (part.type === 'text')
            part.text += event.text
          output.push({ type: 'text_delta', contentIndex: textIndex, delta: event.text, partial: message })
        }
        else if (event.type === 'tool') {
          endThinking()
          endText()
          if (!supportsTools || !tools.some(tool => tool.name === event.call.name) || toolIds.has(event.call.id) || toolIds.size >= 64)
            throw new Error('EXTENSION_INFERENCE_TOOL_INVALID')
          toolIds.add(event.call.id)
          const contentIndex = message.content.length
          const toolCall = { type: 'toolCall' as const, ...event.call }
          message.content.push(toolCall)
          output.push({ type: 'toolcall_start', contentIndex, partial: message })
          output.push({ type: 'toolcall_end', contentIndex, toolCall, partial: message })
        }
        else {
          if ((event.reason === 'toolUse') !== Boolean(toolIds.size))
            throw new Error('EXTENSION_INFERENCE_OUTPUT_INVALID')
          endThinking()
          endText()
          message.stopReason = event.reason
          message.usage = { ...event.usage, totalTokens: event.usage.input + event.usage.output + event.usage.cacheRead + event.usage.cacheWrite, cost: { ...cost, total: 0 } }
          completed = true
        }
      }, capabilities)
      signal.throwIfAborted()
      if (!completed)
        throw new Error('EXTENSION_INFERENCE_OUTPUT_INCOMPLETE')
      output.push({ type: 'done', reason: message.stopReason as 'stop' | 'length' | 'toolUse', message })
    })().catch((error: unknown) => {
      message.stopReason = signal.aborted ? 'aborted' : 'error'
      message.errorMessage = error instanceof Error && /^EXTENSION_INFERENCE_[A-Z_]+$/.test(error.message) ? error.message : signal.aborted ? 'EXTENSION_INFERENCE_CANCELLED' : 'EXTENSION_INFERENCE_BACKEND_FAILED'
      output.push({ type: 'error', reason: message.stopReason, error: message })
    })
    return output
  }
  return createProvider({
    id: providerId,
    name: first.providerName ?? first.extensionName,
    auth: { apiKey: { name: first.providerName ?? first.extensionName, resolve: async () => ({ auth: {}, source: 'plugin runtime' }) } },
    models: models.map(model => ({ id: model.id, name: model.title, provider: providerId, api: pluginChatApi, baseUrl: '', input: model.input ?? ['text'], reasoning: resolveReasoning(model), thinkingLevelMap: { minimal: null, low: null, high: null, xhigh: null, max: null }, contextWindow: model.contextWindow, maxTokens: model.maxTokens, toolCall: toolCalling.get(model.id) === true, cost })),
    api: { stream, streamSimple: stream },
  })
}
