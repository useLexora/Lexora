import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createTemporaryDirectory } from '@buddy-tests/temporaryDirectories'
import { expect, it } from 'vitest'
import { runProfileWrite, withProfileWritesStopped } from '../profileWrites'

it('drains accepted writes before snapshot and rejects concurrent writes only for that profile', async () => {
  const root = await createTemporaryDirectory('lexora-write-freeze-')
  const admitted = Promise.withResolvers<void>()
  const frozen = Promise.withResolvers<void>()
  const resume = Promise.withResolvers<void>()
  const value = join(root, 'value')
  const write = runProfileWrite(root, async () => {
    await admitted.promise
    await writeFile(value, 'committed')
  })
  const snapshot = withProfileWritesStopped(root, async () => {
    expect(await readFile(value, 'utf8')).toBe('committed')
    frozen.resolve()
    await resume.promise
  })
  await expect(runProfileWrite(root, () => writeFile(value, 'late'))).rejects.toThrow('PROFILE_STORAGE_MAINTENANCE')
  admitted.resolve()
  await frozen.promise
  await expect(withProfileWritesStopped(root, async () => {})).rejects.toThrow('PROFILE_STORAGE_MAINTENANCE')
  await runProfileWrite(join(root, 'other-profile'), () => writeFile(join(root, 'other'), 'independent'))
  resume.resolve()
  await Promise.all([write, snapshot])
  await runProfileWrite(root, () => writeFile(value, 'resumed'))
  expect(await readFile(value, 'utf8')).toBe('resumed')
})

it('releases the host write barrier when snapshot creation fails', async () => {
  const root = await createTemporaryDirectory('lexora-write-failure-')
  await expect(withProfileWritesStopped(root, async () => {
    throw new Error('SNAPSHOT_FAILED')
  })).rejects.toThrow('SNAPSHOT_FAILED')
  await runProfileWrite(root, () => writeFile(join(root, 'value'), 'retained'))
  expect(await readFile(join(root, 'value'), 'utf8')).toBe('retained')
})
