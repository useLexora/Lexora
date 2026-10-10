import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { appendFile, copyFile, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { checkWindowsSandbox, resolveWindowsSandbox } from '../windowsSandbox'

const executable = process.env.BUDDY_SANDBOX_TEST_BUNDLED

it.skipIf(process.platform !== 'win32' || !executable)('keeps a real Windows sandbox available across different application binaries without reinstalling it', async () => {
  const { stdout } = await promisify(execFile)(executable!, ['status'], { windowsHide: true })
  const installed = JSON.parse(stdout).path as string
  const digest = async (path: string) => createHash('sha256').update(await readFile(path)).digest('hex')
  const before = await digest(installed)
  const directory = await mkdtemp(join(tmpdir(), 'lexora-sandbox-upgrade-'))
  try {
    const next = join(directory, 'lexora-buddy-sandbox.exe')
    await copyFile(executable!, next)
    await appendFile(next, '\napplication-build-compatibility-fixture\n')
    expect(await digest(next)).not.toBe(before)
    await expect(checkWindowsSandbox(executable)).resolves.toBe('available')
    await expect(checkWindowsSandbox(next)).resolves.toBe('available')
    await expect(resolveWindowsSandbox(next)).resolves.toBe(installed)
    expect(await digest(installed)).toBe(before)
  }
  finally {
    await rm(directory, { recursive: true, force: true })
  }
}, 120_000)
