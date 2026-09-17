import type { NativeCommandResult } from '../native/nativeCommand'
import process from 'node:process'
import { OPERATING_SYSTEM } from '../../shared/platform/identifiers'
import { filePaths } from '../filesystem/filePaths'
import { runNativeCommand } from '../native/nativeCommand'

export type ProcessControlRequest = { protectedPids: number[] } & (
  | { operation: 'resolve', selector: { pid: number } | { name: string } }
  | { operation: 'read', pid: number }
  | { operation: 'execute', pid: number, instanceId: string, executable: string, action: 'terminate-process' | 'kill-process' }
)

export async function runNativeProcessControl(input: ProcessControlRequest, signal: AbortSignal): Promise<NativeCommandResult> {
  signal.throwIfAborted()
  const executable = process.env.LEXORA_BUDDY_PROCESS_CONTROL
  if (!executable)
    throw new Error('Native process control helper is unavailable')
  return runNativeCommand(filePaths.resolveInput(executable), [], input, {
    env: process.platform === OPERATING_SYSTEM.Windows ? { SystemRoot: process.env.SystemRoot } : {},
    maxBytes: 1024 * 1024,
    signal,
  })
}
