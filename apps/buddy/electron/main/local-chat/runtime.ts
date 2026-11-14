import type { LocalChatIpcContext } from './registrar'
import { productRecoveryListSchema, productRecoveryTargetSchema } from '../../../shared/runtime/productRecovery'
import { runtimeResponseSchemas } from '../../../shared/runtime/serviceState'
import { LOCAL_CHAT_IPC_CHANNELS } from '../../shared/localChatApi'

export function registerRuntimeIpc(context: LocalChatIpcContext): void {
  const { handle, options } = context

  handle(LOCAL_CHAT_IPC_CHANNELS.runtimeRecoveryList, async () => productRecoveryListSchema.parse(await options.runtime.recover?.() ?? []))
  handle(LOCAL_CHAT_IPC_CHANNELS.runtimeRecoveryAcknowledge, async (_event, input) => {
    await options.runtime.acknowledgeRecovery?.(productRecoveryTargetSchema.parse(input).id)
  })
  handle(LOCAL_CHAT_IPC_CHANNELS.runtimeRecoveryRestore, async (_event, input) => {
    if (!options.runtime.restoreRecovery)
      throw new Error('Recovery unavailable')
    return options.runtime.restoreRecovery(productRecoveryTargetSchema.parse(input).id)
  })

  handle(LOCAL_CHAT_IPC_CHANNELS.runtimeStatus, () => (
    runtimeResponseSchemas.runtimeState.parse(options.runtime.state)
  ))

  handle(LOCAL_CHAT_IPC_CHANNELS.runtimeRestart, async () => {
    await options.runtime.restart()
    return runtimeResponseSchemas.runtimeState.parse(options.runtime.state)
  })
}
