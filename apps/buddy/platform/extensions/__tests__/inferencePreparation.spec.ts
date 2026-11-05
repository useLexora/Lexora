import type { InferencePrepare } from '../../../shared/extensions/extensionInference'
import type { InferencePreparationRunner } from '../inferencePreparation'
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { FileAssetStore } from '../../filesystem/FileAssetStore'
import { collectInferencePreparation } from '../inferencePreparation'

const roots: string[] = []
const bytes = Buffer.from('verified model resource')
const sha256 = createHash('sha256').update(bytes).digest('hex')
const input: InferencePrepare = {
  id: 'model',
  kind: 'model',
  files: [],
  preparation: {
    inputs: [{ id: 'bundle', sha256, size: bytes.length, source: { url: 'https://models.example.test/bundle' } }],
    options: {},
    maxBytes: 1024,
    maxFiles: 4,
  },
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'lexora-inference-preparation-'))
  roots.push(root)
  const assets = new FileAssetStore(join(root, 'assets'))
  const collect = (run: InferencePreparationRunner) => collectInferencePreparation(input, [], run, assets, new AbortController().signal, () => {}, () => {})
  return { root, collect }
}

it.each(['chunk', 'end'] as const)('rejects storage startup failure instead of hanging on %s backpressure', async (operation) => {
  const { root, collect } = await fixture()
  const blocker = join(root, 'not-a-directory')
  await writeFile(blocker, 'existing user data')
  const brokenAssets = new FileAssetStore(join(blocker, 'assets'))
  const run: InferencePreparationRunner = async (_inputs, _options, signal, event) => {
    await event({ type: 'file', path: 'model.bin', size: operation === 'chunk' ? bytes.length : 0 }, new Uint8Array(), signal)
    await event(operation === 'chunk' ? { type: 'chunk' } : { type: 'end', sha256 }, operation === 'chunk' ? bytes : new Uint8Array(), signal)
  }
  await expect(collectInferencePreparation(input, [], run, brokenAssets, new AbortController().signal, () => {}, () => {})).rejects.toMatchObject({ code: 'ENOTDIR' })
  expect(await readFile(blocker, 'utf8')).toBe('existing user data')
  await expect(collect(async (_inputs, _options, signal, event) => {
    await event({ type: 'file', path: 'model.bin', size: bytes.length }, new Uint8Array(), signal)
    await event({ type: 'chunk' }, bytes, signal)
    await event({ type: 'end', sha256 }, new Uint8Array(), signal)
  })).resolves.toEqual([{ path: 'model.bin', sha256, size: bytes.length }])
})
