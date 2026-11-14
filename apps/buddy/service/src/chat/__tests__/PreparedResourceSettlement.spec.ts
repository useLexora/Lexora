import { mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CommandResultUnknownError } from '../../commands/CommandAdmissionError'
import { StorageIsolatedError } from '../../storage/StorageIsolation'
import { BuddyTransactionUncertainError } from '../../storage/transaction'
import { PreparedResourceSettlement } from '../PreparedResourceSettlement'

const directories: string[] = []
afterEach(async () => {
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
})

async function fixture(onError?: (error: unknown) => void) {
  const directory = await mkdtemp(join(tmpdir(), 'lexora-prepared-settlement-'))
  directories.push(directory)
  const path = join(directory, 'prepared.txt')
  await writeFile(path, 'possibly referenced bytes')
  const outcomes: string[] = []
  const resources = {
    async commit() { outcomes.push('commit') },
    async rollback() {
      outcomes.push('rollback')
      await unlink(path)
    },
    async retain() { outcomes.push('retain') },
  }
  return { path, resources, outcomes, settlement: new PreparedResourceSettlement(resources, onError) }
}

describe('prepared resource settlement', () => {
  it.each([
    new CommandResultUnknownError(new Error('receipt unavailable')),
    new StorageIsolatedError(new Error('storage unavailable')),
    new BuddyTransactionUncertainError(new Error('commit unavailable'), { phase: 'commit', outcome: 'unknown' }),
  ])('retains bytes for $name and does not later discard the same receipt', async (error) => {
    const f = await fixture()
    await f.settlement.fail(error)
    await f.settlement.rollback()
    await f.settlement.fail(new Error('later cleanup failure'))
    expect(f.outcomes).toEqual(['retain'])
    expect(await readFile(f.path, 'utf8')).toBe('possibly referenced bytes')
  })

  it('removes definitely rejected bytes once', async () => {
    const f = await fixture()
    await f.settlement.fail(new Error('validation rejected'))
    await f.settlement.rollback()
    expect(f.outcomes).toEqual(['rollback'])
    await expect(readFile(f.path)).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('keeps accepted bytes when post-commit cleanup and its reporter fail', async () => {
    const failure = new Error('cleanup failed')
    const errors: unknown[] = []
    const f = await fixture((error) => {
      errors.push(error)
      throw new Error('reporter failed')
    })
    f.resources.commit = async () => {
      f.outcomes.push('commit')
      throw failure
    }
    const committed = f.settlement.commit()
    await f.settlement.fail(new Error('dispatch failed'))
    await f.settlement.rollback()
    await committed
    expect(f.outcomes).toEqual(['commit'])
    expect(errors).toEqual([failure])
    expect(await readFile(f.path, 'utf8')).toBe('possibly referenced bytes')
  })
})
