import type { ImageGenerationRetainedOutput } from '../../../shared/images/imageGeneration'
import type { CapturedFileWriter } from '../changes/CapturedFileWriter'
import type { DirectoryGrant } from '../directories/resolveGrantedPath'
import { createHash, randomUUID } from 'node:crypto'
import { lstat, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { resolveGrantedPath } from '../directories/resolveGrantedPath'

export type ImageGenerationMaterialWriter = (
  image: { bytes: Uint8Array, mimeType: 'image/png' },
  grants: readonly DirectoryGrant[],
  writeFiles: CapturedFileWriter,
  signal?: AbortSignal,
) => Promise<ImageGenerationRetainedOutput>

export class ImageGenerationMaterialError extends Error {
  readonly retainedOutput: ImageGenerationRetainedOutput

  constructor(cause: unknown, retainedOutput: ImageGenerationRetainedOutput) {
    super('Image generation material publication cleanup failed', { cause })
    this.name = 'ImageGenerationMaterialError'
    this.retainedOutput = retainedOutput
  }
}

export class ImageGenerationMaterialStore {
  readonly #scratchRoot: string
  readonly #conversationId: string

  constructor(scratchRoot: string, conversationId: string) {
    if (!/^[A-Z0-9][\w-]{0,127}$/i.test(conversationId))
      throw new Error('Invalid image generation material owner')
    this.#scratchRoot = scratchRoot
    this.#conversationId = conversationId
  }

  async write(image: Parameters<ImageGenerationMaterialWriter>[0], grants: readonly DirectoryGrant[], writeFiles: CapturedFileWriter, signal?: AbortSignal): Promise<ImageGenerationRetainedOutput> {
    const root = join(this.#scratchRoot, '.image-generation')
    const directory = join(root, this.#conversationId)
    const path = join(directory, `${randomUUID()}.png`)
    const assertCurrent = async () => {
      signal?.throwIfAborted()
      await resolveGrantedPath(grants, this.#scratchRoot, 'existing')
      for (const candidate of [this.#scratchRoot, root, directory]) {
        const metadata = await lstat(candidate).catch((error: NodeJS.ErrnoException) => {
          if (error.code === 'ENOENT' && candidate !== this.#scratchRoot)
            return null
          throw error
        })
        if (metadata && (!metadata.isDirectory() || await realpath(candidate) !== candidate))
          throw identityChanged()
      }
      if ((await resolveGrantedPath(grants, path, 'create')).canonicalPath !== path)
        throw identityChanged()
      signal?.throwIfAborted()
    }
    await assertCurrent()
    const output: ImageGenerationRetainedOutput = { path, mimeType: 'image/png', sizeBytes: image.bytes.byteLength, sha256: createHash('sha256').update(image.bytes).digest('hex') }
    let retained = false
    try {
      await writeFiles([path], async (publish) => {
        await publish({ path, bytes: image.bytes, size: image.bytes.byteLength, overwrite: false, assertCurrent })
        retained = true
      })
    }
    catch (error) {
      if (retained)
        throw new ImageGenerationMaterialError(error, output)
      throw error
    }
    return output
  }
}

function identityChanged(): Error {
  return Object.assign(new Error('Image generation material identity changed'), { code: 'IMAGE_MATERIAL_IDENTITY_CHANGED' })
}
