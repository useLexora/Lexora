import type { BuddyServiceRpcServer } from './BuddyServiceRpcServer'
import process from 'node:process'
import { captureNodeCpuProfile } from '../../../platform/diagnostics/cpuProfile'
import { cpuProfileRequestSchema } from '../../../shared/diagnostics/performanceDiagnostic'
import { BUDDY_SERVICE_PROTOCOL_VERSION, runtimeShutdownRequestSchema } from '../../../shared/runtime/runtimeProtocol'

export const SERVICE_NAME = 'lexora-buddy-service'

export function registerServiceManagementRpc(server: Pick<BuddyServiceRpcServer, 'onRequest' | 'ready' | 'stopAcceptingRequests'>, scheduleShutdown: () => void, prepareIdleShutdown?: () => boolean): void {
  let profiling = false
  server.onRequest('diagnostics.profile', async (input, signal) => {
    const request = cpuProfileRequestSchema.parse(input)
    if (request.target !== 'runtime' || request.pid !== process.pid)
      throw new Error('CPU_PROFILE_PROCESS_CHANGED')
    if (profiling)
      throw new Error('CPU_PROFILE_BUSY')
    profiling = true
    try {
      return await captureNodeCpuProfile('runtime', signal)
    }
    finally { profiling = false }
  })
  server.onRequest('runtime.status', () => ({
    name: SERVICE_NAME,
    protocolVersion: BUDDY_SERVICE_PROTOCOL_VERSION,
    ready: server.ready,
  }))
  server.onRequest('runtime.localState', () => ({
    status: server.ready ? 'ready' : 'starting',
  }))
  server.onRequest('runtime.shutdown', (params) => {
    const { onlyIfIdle } = runtimeShutdownRequestSchema.parse(params)
    if (onlyIfIdle && (!server.ready || !prepareIdleShutdown?.()))
      return { accepted: false }
    server.stopAcceptingRequests()
    setImmediate(scheduleShutdown)
    return { accepted: true }
  })
}
