import type { Buffer } from 'node:buffer'
import { execFile } from 'node:child_process'
import process from 'node:process'
import { OPERATING_SYSTEM } from '../../shared/platform/identifiers'
import { BoundedFileReadError } from './boundedFileError'
import { filePaths } from './filePaths'

export async function readNativeBoundedFile(root: string, path: string, maxBytes: number, signal?: AbortSignal, executable = process.env.LEXORA_BUDDY_FILE_READER): Promise<Buffer> {
  if (!executable)
    throw new BoundedFileReadError('BOUNDED_FILE_READER_UNAVAILABLE')
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > 64 * 1024 * 1024)
    throw new BoundedFileReadError('BOUNDED_FILE_OUTPUT_LIMIT')
  const request = JSON.stringify({
    root: filePaths.resolveInput(root),
    path: filePaths.resolveInput(path),
    maxBytes,
  })
  return new Promise((resolve, reject) => {
    const child = execFile(filePaths.resolveInput(executable), [], {
      encoding: 'buffer',
      env: process.platform === OPERATING_SYSTEM.Windows ? { SystemRoot: process.env.SystemRoot } : {},
      maxBuffer: maxBytes + 4096,
      timeout: 30_000,
      killSignal: 'SIGKILL',
      signal,
      windowsHide: true,
    }, (error, stdout, stderr) => {
      if (error) {
        const code = stderr.toString('utf8').trim()
        reject(new BoundedFileReadError(
          code === 'BOUNDED_FILE_OUTPUT_LIMIT' || error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
            ? 'BOUNDED_FILE_OUTPUT_LIMIT'
            : error.code === 'ENOENT' || code === 'BOUNDED_FILE_READER_UNAVAILABLE'
              ? 'BOUNDED_FILE_READER_UNAVAILABLE'
              : 'BOUNDED_FILE_READ_FAILED',
          { cause: error },
        ))
      }
      else if (stdout.length > maxBytes || stderr.length > 0) {
        reject(new BoundedFileReadError('BOUNDED_FILE_READ_FAILED'))
      }
      else {
        resolve(stdout)
      }
    })
    child.stdin?.on('error', () => {})
    child.stdin?.end(request)
  })
}
