import type { RuntimeToolLoopInput } from './session'
import type { AgentModelCallResult } from './types'
import { runNativeToolProtocol } from './native'
import { resolveAgentToolProtocol } from './protocol'
import { RuntimeToolLoopSession } from './session'
import { runStructuredJsonToolProtocol } from './structured-json'

export async function callModelWithRuntimeTools(input: RuntimeToolLoopInput): Promise<AgentModelCallResult> {
  const session = new RuntimeToolLoopSession(input)
  const toolProtocol = resolveAgentToolProtocol({
    model: input.model,
    modelTarget: input.context?.modelTarget,
    visibleToolCount: session.visibleTools.length,
  })

  if (toolProtocol.kind === 'structured-json') {
    return runStructuredJsonToolProtocol(session)
  }

  if (toolProtocol.kind !== 'native') {
    await session.warnToolProtocolUnavailable(toolProtocol.reason)
    return session.streamWithoutTools()
  }

  if (!input.model.bindTools) {
    await session.warnToolProtocolUnavailable('native-tool-binding-unavailable')
    return session.streamWithoutTools()
  }

  return runNativeToolProtocol(session)
}
