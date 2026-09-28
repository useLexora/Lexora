import type { CapturedDiagnosticOutput } from '../../diagnostics/diagnosticOutput'
import { EventEmitter, once } from 'node:events'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'
import { createTemporaryDirectory } from '@buddy-tests/temporaryDirectories'
import { describe, expect, it } from 'vitest'
import { DesktopDiagnosticLogger } from '../../desktopDiagnostics'
import { captureDiagnosticOutput } from '../../diagnostics/diagnosticOutput'

import {
  forkBuddyServiceProcess,
} from '../buddyServiceProcess'

class FakeUtilityProcess extends EventEmitter {
  readonly stderr = new PassThrough()
  readonly pid = 42
  readonly sent: unknown[] = []

  kill(): boolean {
    return true
  }

  postMessage(message: unknown): void {
    this.sent.push(message)
  }

  exit(code: number): void {
    try {
      this.emit('exit', code)
    }
    finally {
      this.stderr.removeAllListeners()
    }
  }
}

describe('buddyServiceProcess', () => {
  it('records stderr across chunks when the utility stream reaches EOF', async () => {
    const directory = await createTemporaryDirectory('lexora-service-stderr-')
    const logger = new DesktopDiagnosticLogger({ directory, userHome: '/home/alice', appVersion: '0.3.0' })
    const process = new FakeUtilityProcess()
    forkBuddyServiceProcess({
      captureStderr: output => logger.captureOutput('local-service', output),
      forkProcess: () => process,
      mainModuleUrl: 'file:///workspace/buddy/index.js',
    })
    process.stderr.write('Authorization: Bea')
    const ended = once(process.stderr, 'end')
    process.stderr.end('rer fixture-secret')
    await ended
    process.exit(7)
    expect(await logger.close()).toMatchObject({ written: 1, closeTimedOut: false })
    const record = JSON.parse(await readFile(join(directory, 'application.jsonl'), 'utf8'))
    expect(record).toMatchObject({ scope: 'local-service', message: 'Authorization: <redacted>' })
  })

  it('finishes the capture and persists the terminal records when Electron removes stderr listeners at exit', async () => {
    const directory = await createTemporaryDirectory('lexora-service-stderr-exit-')
    const logger = new DesktopDiagnosticLogger({ directory, userHome: '/home/alice', appVersion: '0.3.0' })
    const process = new FakeUtilityProcess()
    let capture: CapturedDiagnosticOutput | undefined
    forkBuddyServiceProcess({
      captureStderr: (output) => {
        capture = captureDiagnosticOutput(output, logger.createWritable('local-service'), error => logger.record({ scope: 'local-service', level: 'warn', event: 'process.stderr_failed', error }))
      },
      forkProcess: () => process,
      mainModuleUrl: 'file:///workspace/buddy/index.js',
    })
    process.stderr.write('runtime cleanup ')
    process.stderr.write('completed')
    process.exit(0)
    await capture!.done
    logger.record({ scope: 'desktop', level: 'info', event: 'app.stopped' })
    expect(await logger.close()).toMatchObject({ written: 2, failed: 0, unconfirmed: 0, closeTimedOut: false })
    const records = (await readFile(join(directory, 'application.jsonl'), 'utf8')).trimEnd().split('\n').map(line => JSON.parse(line))
    expect(records).toMatchObject([
      { scope: 'local-service', event: 'process.stderr', message: 'runtime cleanup completed' },
      { scope: 'desktop', event: 'app.stopped' },
    ])
  })

  it('propagates a stderr read error and closes the capture before utility exit', async () => {
    const directory = await createTemporaryDirectory('lexora-service-stderr-error-')
    const logger = new DesktopDiagnosticLogger({ directory, userHome: '/home/alice', appVersion: '0.3.0' })
    const process = new FakeUtilityProcess()
    forkBuddyServiceProcess({
      captureStderr: output => logger.captureOutput('local-service', output),
      forkProcess: () => process,
      mainModuleUrl: 'file:///workspace/buddy/index.js',
    })
    process.stderr.destroy(new Error('stderr read failed'))
    expect(await logger.close()).toMatchObject({ written: 1, closeTimedOut: false })
    const record = JSON.parse(await readFile(join(directory, 'application.jsonl'), 'utf8'))
    expect(record).toMatchObject({ event: 'process.stderr_failed', error: { message: 'stderr read failed' } })
    process.exit(1)
  })

  it('closes pending RPC when the utility process exits', async () => {
    const process = new FakeUtilityProcess()
    const handle = forkBuddyServiceProcess({
      forkProcess: () => process,
      mainModuleUrl: 'file:///workspace/apps/buddy/.output/build/electron/main/index.js',
    })
    const response = handle.peer.request('runtime.status', {})

    process.exit(7)

    await expect(response).rejects.toThrow('exited with code 7')
  })
})
