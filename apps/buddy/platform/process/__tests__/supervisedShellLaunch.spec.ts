import type { OwnedProcessSettlement } from '../supervisedShellProcess'
import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { deferred } from '@buddy-tests/deferred'
import { describe, expect, it } from 'vitest'
import { verifyOwnedProcessRelease } from '../ownedProcessRecovery'
import { runSupervisedShellProcess } from '../supervisedShellProcess'

describe.skipIf(process.platform !== 'linux')('durable native launch gate', () => {
  async function fixture() {
    const root = await mkdtemp(join(tmpdir(), 'lexora-launch-'))
    const receiptDirectory = join(root, 'receipts')
    const records: OwnedProcessSettlement[] = []
    return {
      root,
      records,
      receiptDirectory,
      run(onSettlement: (record: OwnedProcessSettlement) => void | Promise<void>, signal?: AbortSignal) {
        return runSupervisedShellProcess({
          shell: '/bin/bash',
          args: ['--noprofile', '--norc', '-c'],
          command: 'printf executed > marker',
          cwd: root,
          environment: { PATH: '/usr/bin:/bin' },
        }, {
          receiptDirectory,
          signal,
          onData() {},
          async onSettlement(record) {
            records.push(record)
            await onSettlement(record)
          },
        })
      },
      dispose: () => rm(root, { recursive: true, force: true }),
    }
  }

  it('does not start until asynchronous identity persistence has completed', async () => {
    const f = await fixture()
    const ready = deferred<void>()
    const persisted = deferred<void>()
    try {
      const result = f.run(async (record) => {
        if (record.launchState === 'authorized') {
          ready.resolve()
          await persisted.promise
        }
      })
      await ready.promise
      await expect(access(join(f.root, 'marker'))).rejects.toThrow()
      persisted.resolve()
      await expect(result).resolves.toEqual({ exitCode: 0 })
      expect(await readFile(join(f.root, 'marker'), 'utf8')).toBe('executed')
      const identity = f.records.find(record => record.launchState === 'authorized')!.processId
      await expect(verifyOwnedProcessRelease(identity, { receiptDirectory: f.receiptDirectory }))
        .resolves
        .toEqual({ status: 'released', reason: 'supervisor_receipt' })
    }
    finally {
      persisted.resolve()
      await f.dispose()
    }
  })

  it('ignores late persistence ACK after cancellation and retains a verifiable sealed gate', async () => {
    const f = await fixture()
    const ready = deferred<void>()
    const persisted = deferred<void>()
    const controller = new AbortController()
    try {
      const result = f.run(async (record) => {
        if (record.launchState === 'authorized') {
          ready.resolve()
          await persisted.promise
        }
      }, controller.signal)
      const rejected = expect(result).rejects.toThrow()
      await ready.promise
      controller.abort()
      persisted.resolve()
      await rejected
      await expect(access(join(f.root, 'marker'))).rejects.toThrow()
      const dispatch = f.records[0]!.processId
      await expect(verifyOwnedProcessRelease(dispatch, { receiptDirectory: f.receiptDirectory }))
        .resolves
        .toEqual({ status: 'released', reason: 'supervisor_receipt' })
    }
    finally {
      persisted.resolve()
      await f.dispose()
    }
  })

  it('can import the native receipt after final persistence fails', async () => {
    const f = await fixture()
    try {
      await expect(f.run((record) => {
        if (record.launchState === 'settled')
          throw new Error('persistence unavailable')
      })).rejects.toThrow('persistence unavailable')
      const dispatch = f.records[0]!.processId
      await expect(verifyOwnedProcessRelease(dispatch, { receiptDirectory: f.receiptDirectory }))
        .resolves
        .toEqual({ status: 'released', reason: 'supervisor_receipt' })
    }
    finally { await f.dispose() }
  })
})
