import type { SpaceFileMutationError } from '../../shared/spaces/spaceFileApi'
import { execFile } from 'node:child_process'
import process from 'node:process'
import { spaceFileMutationErrorSchema } from '../../shared/spaces/spaceFileApi'

export interface BoundedEntryMutation {
  root: string
  path: string
  operation: 'create-file' | 'create-directory' | 'rename' | 'trash'
  name?: string
}
export type BoundedEntryMutationResult = { status: 'completed', kind: 'file' | 'directory' } | { status: 'failed', reason: SpaceFileMutationError }

// Shared Windows/macOS/Linux transport; the native backend decides whether an operation
// can safely run on the target filesystem. Never fall back to unbounded Node/Shell writes.
// The callback is deliberately trusted-side only, never a renderer-supplied authorization.
export function mutateBoundedEntry(input: BoundedEntryMutation, beforeCommit: () => void): Promise<BoundedEntryMutationResult> {
  const executable = process.env.LEXORA_BUDDY_FILE_READER
  if (!['win32', 'darwin', 'linux'].includes(process.platform) || !executable)
    return Promise.resolve({ status: 'failed', reason: 'unsupported' })
  return new Promise((resolve, reject) => {
    let ready = false
    let committed = false
    let authorizationError: unknown
    let prefix = ''
    const child = execFile(executable, ['--mutate-entry'], {
      // Forward only platform context, not the complete service environment. These
      // values locate user facilities; native code must still verify ownership/bounds.
      env: process.platform === 'win32'
        ? { SystemRoot: process.env.SystemRoot, USERPROFILE: process.env.USERPROFILE, LOCALAPPDATA: process.env.LOCALAPPDATA }
        : { HOME: process.env.HOME, ...(process.platform === 'linux' ? { XDG_DATA_HOME: process.env.XDG_DATA_HOME } : {}) },
      maxBuffer: 4096,
      timeout: 120_000,
      windowsHide: true,
    }, (error, stdout, stderr) => {
      if (authorizationError) {
        reject(authorizationError)
        return
      }
      if (error || stderr) {
        const parsed = spaceFileMutationErrorSchema.safeParse(stderr.trim())
        const reason = parsed.success ? parsed.data : committed ? 'result-unknown' : 'unsupported'
        resolve({ status: 'failed', reason: input.operation === 'trash' && committed ? 'result-unknown' : reason })
        return
      }
      const kind = stdout.replace(/^ready\r?\n/u, '').trim()
      if (ready && committed && (kind === '"file"' || kind === '"directory"'))
        resolve({ status: 'completed', kind: kind === '"file"' ? 'file' : 'directory' })
      else
        resolve({ status: 'failed', reason: committed ? 'result-unknown' : 'failed' })
    })
    child.stdout?.on('data', (chunk: string | Uint8Array) => {
      if (ready)
        return
      prefix += chunk.toString()
      if (prefix === 'ready\n' || prefix === 'ready\r\n') {
        ready = true
        try {
          beforeCommit()
          committed = true
          child.stdin?.end('commit\n')
        }
        catch (error) {
          authorizationError = error
          child.stdin?.end('cancel\n')
        }
      }
    })
    child.stdin?.on('error', () => {})
    child.stdin?.write(`${JSON.stringify(input)}\n`)
  })
}
