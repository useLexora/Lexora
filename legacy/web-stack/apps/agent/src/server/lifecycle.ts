import type { FastifyInstance } from 'fastify'

/** Agent 服务生命周期钩子。 */
export interface AgentServerLifecycle {
  flushBeforeClose?: () => Promise<void> | void
}

/** 注册 Agent 服务关闭流程输入。 */
export interface RegisterAgentServerCloseHookOptions {
  app: FastifyInstance
  lifecycle?: AgentServerLifecycle
}

export function registerAgentServerCloseHook(options: RegisterAgentServerCloseHookOptions): void {
  options.app.addHook('onClose', async () => {
    await options.lifecycle?.flushBeforeClose?.()
  })
}
