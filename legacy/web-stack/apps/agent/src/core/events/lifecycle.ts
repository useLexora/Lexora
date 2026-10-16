import type { AgentClientAction } from '@haohaoxue/lexora-contracts'
import type { AgentModelStreamPart } from '../../integrations/model-providers/stream-text'
import type { ChatGenerationEvent } from '../../runtime/typing'
import { ChatGenerationEventSchema } from '@haohaoxue/lexora-contracts'

export interface EmitAgentModelStreamPartOptions {
  generationId: string
  emit: (event: ChatGenerationEvent) => Promise<void> | void
}

export async function emitAgentModelStreamPart(
  part: AgentModelStreamPart,
  options: EmitAgentModelStreamPartOptions,
): Promise<void> {
  if (part.type === 'reasoning.delta') {
    await options.emit(ChatGenerationEventSchema.parse({
      type: 'model.reasoning.delta',
      generationId: options.generationId,
      payload: {
        text: part.text,
      },
    }))
    return
  }

  if (part.type === 'text.delta') {
    await options.emit(ChatGenerationEventSchema.parse({
      type: 'model.text.delta',
      generationId: options.generationId,
      payload: {
        text: part.text,
      },
    }))
    return
  }

  if (part.type === 'tool.call.started') {
    await options.emit(ChatGenerationEventSchema.parse({
      type: 'model.tool.call.started',
      generationId: options.generationId,
      payload: {
        toolCallId: part.toolCallId,
        actionName: part.actionName,
      },
    }))
    return
  }

  if (part.type === 'tool.call.args.delta') {
    await options.emit(ChatGenerationEventSchema.parse({
      type: 'model.tool.call.args.delta',
      generationId: options.generationId,
      payload: {
        toolCallId: part.toolCallId,
        text: part.text,
      },
    }))
    return
  }

  if (part.type === 'tool.call.completed') {
    await options.emit(ChatGenerationEventSchema.parse({
      type: 'model.tool.call.completed',
      generationId: options.generationId,
      payload: {
        toolCallId: part.toolCallId,
        actionName: part.actionName,
      },
    }))
    return
  }

  if (part.type === 'tool.execution.started') {
    await options.emit(ChatGenerationEventSchema.parse({
      type: 'tool.execution.started',
      generationId: options.generationId,
      payload: {
        toolCallId: part.toolCallId,
        skillKey: part.skillKey,
        actionName: part.actionName,
        connectorType: part.connectorType,
        arguments: part.args,
        argumentsText: part.argsText,
      },
    }))
    return
  }

  if (part.type === 'tool.execution.completed') {
    await options.emit(ChatGenerationEventSchema.parse({
      type: 'tool.execution.completed',
      generationId: options.generationId,
      payload: {
        toolCallId: part.toolCallId,
        skillKey: part.skillKey,
        actionName: part.actionName,
        connectorType: part.connectorType,
        status: part.status,
        output: part.output,
        outputText: part.outputText,
        durationMs: part.durationMs,
      },
    }))
    return
  }

  if (part.type === 'tool.execution.failed') {
    await options.emit(ChatGenerationEventSchema.parse({
      type: 'tool.execution.failed',
      generationId: options.generationId,
      payload: {
        toolCallId: part.toolCallId,
        skillKey: part.skillKey,
        actionName: part.actionName,
        connectorType: part.connectorType,
        message: part.message,
        durationMs: part.durationMs,
      },
    }))
  }
}

export function createAgentGenerationLifecycleEvent(input: {
  type: 'generation.started' | 'generation.completed' | 'generation.failed' | 'generation.cancelled'
  generationId: string
  payload?: unknown
}): ChatGenerationEvent {
  return ChatGenerationEventSchema.parse({
    type: input.type,
    generationId: input.generationId,
    payload: input.payload,
  })
}

export function createAgentClientActionRequiredEvent(input: {
  generationId: string
  action: AgentClientAction
}): ChatGenerationEvent {
  return ChatGenerationEventSchema.parse({
    type: 'generation.client_action.required',
    generationId: input.generationId,
    payload: {
      action: input.action,
    },
  })
}
