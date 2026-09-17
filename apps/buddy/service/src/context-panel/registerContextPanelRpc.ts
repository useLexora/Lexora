import type { RunEventWriter } from '../events/RunEventPorts'
import type { RuntimeRequestRegistrar } from '../rpc/runtimeRequest'
import type { RunRepository } from '../storage/runRepository'
import { contextPanelOperationRecordSchema, contextPanelRpc } from '../../../shared/context-panel/contextPanel'
import { parse } from '../rpc/runtimeRequest'

export function registerContextPanelRpc(options: {
  rpc: RuntimeRequestRegistrar
  runs: Pick<RunRepository, 'findById'>
  events: Pick<RunEventWriter, 'append'>
}): () => void {
  return options.rpc.onRequest(contextPanelRpc.recordOperation, async (params) => {
    const { source, createdAt, ...operation } = parse(contextPanelOperationRecordSchema, params)
    const run = options.runs.findById(source.runId)
    if (!run || run.conversationId !== source.conversationId)
      return { recorded: false }
    await options.events.append({ runId: run.id, type: 'desktop.panel.changed', payload: operation, createdAt })
    return { recorded: true }
  })
}
