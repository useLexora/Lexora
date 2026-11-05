import type { JsonValue } from '../../shared/workbench/workbenchState'
import { Buffer } from 'node:buffer'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { readExtensionFile } from './extensionPackageFiles'

export const inferenceInitializationBytes = 16 * 1024 * 1024
const filename = 'initialize.json'

export async function writeInferenceInitialization(directory: string, data: JsonValue): Promise<void> {
  const bytes = Buffer.from(JSON.stringify(data))
  if (bytes.length > inferenceInitializationBytes)
    throw new Error('EXTENSION_INFERENCE_INITIALIZATION_LIMIT')
  await writeFile(join(directory, filename), bytes, { flag: 'wx', mode: 0o600 })
}

export async function readInferenceInitialization(directory: string): Promise<JsonValue> {
  try {
    return JSON.parse((await readExtensionFile(join(directory, filename), inferenceInitializationBytes)).toString('utf8')) as JsonValue
  }
  catch (error) {
    throw new Error(error instanceof Error && error.message === 'EXTENSION_FILE_LIMIT' ? 'EXTENSION_INFERENCE_INITIALIZATION_LIMIT' : 'EXTENSION_INFERENCE_INITIALIZATION_INVALID', { cause: error })
  }
}
