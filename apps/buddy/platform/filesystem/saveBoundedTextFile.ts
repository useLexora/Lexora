import { Buffer } from 'node:buffer'
import { execFile } from 'node:child_process'
import process from 'node:process'

export function saveBoundedTextFile(input: { root: string, path: string, expected: string, content: string }): Promise<'saved' | 'conflict'> {
  const executable = process.env.LEXORA_BUDDY_FILE_READER
  if (!executable || Buffer.byteLength(input.expected) > 1024 * 1024 || Buffer.byteLength(input.content) > 1024 * 1024)
    return Promise.reject(new Error('BOUNDED_FILE_WRITE_FAILED'))
  return new Promise((resolve, reject) => {
    const child = execFile(executable, ['--save-text'], {
      env: process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot } : {},
      maxBuffer: 4096,
      timeout: 30_000,
      windowsHide: true,
    }, (error, stdout, stderr) => {
      if (error && stderr.trim() === 'BOUNDED_FILE_CONFLICT')
        resolve('conflict')
      else if (error || stdout || stderr)
        reject(new Error('BOUNDED_FILE_WRITE_FAILED', { cause: error }))
      else
        resolve('saved')
    })
    child.stdin?.on('error', () => {})
    child.stdin?.end(JSON.stringify(input))
  })
}
