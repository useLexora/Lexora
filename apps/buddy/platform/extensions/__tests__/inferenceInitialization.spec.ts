import { Buffer } from 'node:buffer'
import { open, rm, stat, writeFile } from 'node:fs/promises'
import { join, win32 } from 'node:path'
import { createTemporaryDirectory } from '@buddy-tests/temporaryDirectories'
import { expect, it } from 'vitest'
import { inferenceLimits } from '../../../shared/extensions/extensionInference'
import { inferenceInitializationBytes, readInferenceInitialization, writeInferenceInitialization } from '../inferenceInitialization'
import { inferenceFrame } from '../inferenceWire'

it('preserves a multi-file initialization above the control-frame budget including cross-volume mappings and directory layouts', async () => {
  const directory = await createTemporaryDirectory('lexora-inference-initialization-')
  const root = String.raw`C:\Users\fixture\.lexora-vm\worktrees\current\isolated-inference-profile\extensions\inference\local-models\view-abcdef`
  const files = Object.fromEntries(Array.from({ length: 360 }, (_, index) => {
    const path = `espeak-ng-data/lang/family-${index}/voice-${index}.dict`
    return [path, win32.join(root, path)]
  }))
  const data = {
    configuration: { language: 'zh' },
    resources: { model: root, external: String.raw`C:\fixture\external-view`, engine: String.raw`C:\fixture\engine-view` },
    resourceFiles: {
      model: files,
      external: { 'model.gguf': String.raw`D:\authorized models\original.gguf`, 'voices.bin': String.raw`E:\authorized voices\original.bin` },
      engine: { 'bin/runtime.exe': String.raw`C:\fixture\engine-view\bin\runtime.exe`, 'bin/helper.dll': String.raw`C:\fixture\engine-view\bin\helper.dll` },
    },
  }
  expect(Buffer.byteLength(JSON.stringify(data))).toBeGreaterThan(inferenceLimits.controlBytes)
  expect(() => inferenceFrame({ type: 'initialize', data })).toThrow('EXTENSION_INFERENCE_FRAME_LIMIT')
  await writeInferenceInitialization(directory, data)
  expect(await readInferenceInitialization(directory)).toEqual(data)
  expect(inferenceFrame({ type: 'initialize' }).length).toBeLessThan(inferenceLimits.controlBytes)
})

it('rejects oversized or malformed startup metadata without increasing the wire limit', async () => {
  const directory = await createTemporaryDirectory('lexora-inference-initialization-limit-')
  const path = join(directory, 'initialize.json')
  await expect(writeInferenceInitialization(directory, { configuration: 'x'.repeat(inferenceInitializationBytes) })).rejects.toThrow('EXTENSION_INFERENCE_INITIALIZATION_LIMIT')
  await expect(stat(path)).rejects.toMatchObject({ code: 'ENOENT' })
  const file = await open(path, 'wx')
  try {
    await file.truncate(inferenceInitializationBytes + 1)
  }
  finally { await file.close() }
  await expect(readInferenceInitialization(directory)).rejects.toThrow('EXTENSION_INFERENCE_INITIALIZATION_LIMIT')
  await rm(path)
  await writeFile(path, '{invalid JSON')
  await expect(readInferenceInitialization(directory)).rejects.toThrow('EXTENSION_INFERENCE_INITIALIZATION_INVALID')
  expect(inferenceLimits.controlBytes).toBe(64 * 1024)
})
