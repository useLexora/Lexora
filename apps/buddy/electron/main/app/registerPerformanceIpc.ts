import type { BrowserWindow } from 'electron'
import type { ApplicationDiagnosticReporter } from '../../../shared/diagnostics/applicationDiagnostic'
import type { DesktopRuntimeHost } from './DesktopRuntimeHost'
import process from 'node:process'
import { ipcMain } from 'electron'
import { captureCpuProfile, captureNodeCpuProfile } from '../../../platform/diagnostics/cpuProfile'
import { safeDiagnosticReporter } from '../../../shared/diagnostics/applicationDiagnostic'
import { cpuProfileRequestSchema, cpuProfileSummarySchema } from '../../../shared/diagnostics/performanceDiagnostic'
import { DESKTOP_IPC_CHANNELS } from '../../shared/desktopApi'
import { assertTrustedSender } from '../ipc'

export function registerPerformanceIpc(runtime: DesktopRuntimeHost, getWindow: () => BrowserWindow | null, reporter: ApplicationDiagnosticReporter): () => void {
  const record = safeDiagnosticReporter(reporter)
  const shutdown = new AbortController()
  let busy = false
  ipcMain.handle(DESKTOP_IPC_CHANNELS.appPerformanceSnapshot, (event) => {
    const window = getWindow()
    assertTrustedSender(event, window)
    if (!window)
      throw new Error('CPU_PROFILE_UNAVAILABLE')
    return { ...runtime.performance.snapshot(), rendererPid: window.webContents.getOSProcessId() }
  })
  ipcMain.handle(DESKTOP_IPC_CHANNELS.appPerformanceCapture, async (event, input: unknown) => {
    const window = getWindow()
    assertTrustedSender(event, window)
    const request = cpuProfileRequestSchema.parse(input)
    const { target, pid } = request
    if (busy || !window || shutdown.signal.aborted)
      throw new Error('CPU_PROFILE_UNAVAILABLE')
    const currentPid = target === 'main' ? process.pid : target === 'runtime' ? runtime.service.state.pid : window.webContents.getOSProcessId()
    if (pid !== currentPid)
      throw new Error('CPU_PROFILE_PROCESS_CHANGED')
    busy = true
    const operationId = crypto.randomUUID()
    try {
      const snapshot = runtime.performance.snapshot()
      for (const performanceSample of snapshot.samples)
        record({ event: 'performance.sample', level: 'info', operationId, performanceSample })
      const cpuProfile = target === 'runtime'
        ? cpuProfileSummarySchema.parse(await runtime.service.request('diagnostics.profile', request, { signal: shutdown.signal, timeoutMs: 10_000 }))
        : target === 'main'
          ? await captureNodeCpuProfile('main', shutdown.signal)
          : await captureRenderer(window, shutdown.signal)
      record({ event: 'performance.cpu_profile', level: 'info', operationId, cpuProfile })
      return cpuProfile
    }
    catch {
      record({ event: 'performance.profile_failed', level: 'warn', operationId, errorCode: 'CPU_PROFILE_FAILED' })
      throw new Error('CPU_PROFILE_FAILED')
    }
    finally {
      busy = false
    }
  })
  return () => {
    shutdown.abort()
    ipcMain.removeHandler(DESKTOP_IPC_CHANNELS.appPerformanceSnapshot)
    ipcMain.removeHandler(DESKTOP_IPC_CHANNELS.appPerformanceCapture)
  }
}

async function captureRenderer(window: BrowserWindow, signal: AbortSignal) {
  const contents = window.webContents
  if (contents.debugger.isAttached())
    throw new Error('CPU_PROFILE_BUSY')
  const pid = contents.getOSProcessId()
  contents.debugger.attach('1.3')
  let attached = true
  const detached = () => {
    attached = false
  }
  contents.debugger.once('detach', detached)
  return captureCpuProfile({
    send: (method, params) => contents.debugger.sendCommand(method, params),
    close: () => {
      contents.debugger.removeListener('detach', detached)
      if (attached && !contents.isDestroyed() && contents.debugger.isAttached())
        contents.debugger.detach()
    },
  }, 'renderer', pid, (url) => {
    const match = /^lexora-app:\/\/renderer\/assets\/([\w-]+(?:\.[\w-]+)*\.js)$/.exec(url)
    return match?.[1] ?? null
  }, signal)
}
