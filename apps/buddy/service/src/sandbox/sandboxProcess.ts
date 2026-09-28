import process from 'node:process'
import { z } from 'zod'
import { sandboxProcessInputSchema } from '../../../shared/permissions/shellSandbox'
import { BuddyServiceRpcServer } from '../rpc/BuddyServiceRpcServer'
import { runSandboxCommand } from './runSandboxCommand'

const port = process.parentPort
if (!port)
  throw new Error('Sandbox supervisor requires its desktop parent')
const peer = new BuddyServiceRpcServer({ port })
const controller = new AbortController()
let started = false
peer.onNotification((method) => {
  if (method === 'sandbox.cancel')
    controller.abort()
})
peer.onRequest('sandbox.exec', async (params) => {
  if (started)
    return { ok: false, code: 'SANDBOX_BUSY' }
  started = true
  const input = sandboxProcessInputSchema.parse(params)
  return runSandboxCommand(input, {
    signal: controller.signal,
    onLifecycle: event => peer.notify('sandbox.lifecycle', { ...event, requestId: input.requestId }),
    onData(data) {
      for (let offset = 0; offset < data.length; offset += 64 * 1024)
        peer.notify('sandbox.output', { requestId: input.requestId, data: data.subarray(offset, offset + 64 * 1024).toString('base64') })
    },
    async approveNetwork(target) {
      const answer = z.object({ allowed: z.boolean() }).strict().parse(await peer.request('sandbox.network', { ...target, requestId: input.requestId }, 30 * 60 * 1_000))
      return answer.allowed
    },
  })
})
