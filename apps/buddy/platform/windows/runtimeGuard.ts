import type { Buffer } from 'node:buffer'
import { spawn } from 'node:child_process'
import process from 'node:process'
import { createChildProcessEnvironment } from '../process/childProcessEnvironment'

export async function establishWindowsRuntimeGuard(): Promise<void> {
  const executable = process.env.LEXORA_BUDDY_RUNTIME_GUARD
  if (!executable)
    throw new Error('Windows Runtime guard is unavailable')
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, [], {
      env: createChildProcessEnvironment({ source: process.env }),
      stdio: ['pipe', 'pipe', 'ignore'],
      windowsHide: true,
    })
    let settled = false
    let output = ''
    let timeout: ReturnType<typeof setTimeout> | undefined
    const fail = () => {
      if (settled)
        return
      settled = true
      clearTimeout(timeout)
      child.kill('SIGKILL')
      reject(new Error('Windows Runtime guard could not be established'))
    }
    timeout = setTimeout(fail, 10_000)
    child.once('error', fail)
    child.once('exit', fail)
    child.stdin.once('error', fail)
    child.stdout.on('data', (chunk: Buffer) => {
      if (settled)
        return
      output += chunk.toString('utf8')
      if (output === 'ready\n') {
        settled = true
        clearTimeout(timeout)
        child.stdout.destroy()
        child.unref()
        resolve()
      }
      else if (!'ready\n'.startsWith(output)) {
        fail()
      }
    })
    child.stdin.end(JSON.stringify({ pid: process.pid }))
  })
}
