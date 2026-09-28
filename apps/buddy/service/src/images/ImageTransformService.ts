import type { ArtifactService } from '../artifacts/ArtifactService'
import type { DirectoryGrant } from '../directories/resolveGrantedPath'
import type { ArtifactRecord } from '../storage/artifactRepository'
import type { ChromaOptions } from './runChromaTransform'
import { copyEventSnapshot } from '../../../shared/events/eventSnapshot'
import { ImageOperationLifecycle } from './ImageOperationLifecycle'
import { ImageTransformError } from './ImageTransformError'
import { runChromaTransform } from './runChromaTransform'

export interface RemoveChromaInput extends ChromaOptions {
  conversationId: string
  cwd: string
  grants: readonly DirectoryGrant[]
  outputPath: string
  sourceArtifactId: string
}

export class ImageTransformService {
  readonly #operations = new ImageOperationLifecycle()
  readonly onDidChange = this.#operations.onDidChange
  readonly #artifacts: Pick<ArtifactService, 'materializeConversationArtifact' | 'registerGeneratedImages'>

  constructor(options: {
    artifacts: Pick<ArtifactService, 'materializeConversationArtifact' | 'registerGeneratedImages'>
  }) {
    this.#artifacts = options.artifacts
  }

  removeChroma(input: RemoveChromaInput, signal?: AbortSignal): Promise<ArtifactRecord> {
    const request = copyEventSnapshot({ conversationId: input.conversationId, cwd: input.cwd, grants: input.grants, outputPath: input.outputPath, sourceArtifactId: input.sourceArtifactId, color: input.color, despill: input.despill, softness: input.softness, tolerance: input.tolerance })
    return this.#operations.run({ conversationId: request.conversationId, kind: 'transform', signal }, async (progress) => {
      signal?.throwIfAborted()
      if (!request.outputPath.trim())
        throw new ImageTransformError('VALIDATION_FAILED')
      const source = await this.#artifacts.materializeConversationArtifact(request.conversationId, request.sourceArtifactId)
      signal?.throwIfAborted()
      if (source.resource.mimeType !== 'image/png')
        throw new ImageTransformError('IMAGE_TRANSFORM_UNSUPPORTED_FORMAT')
      progress('processing')
      const bytes = await runChromaTransform(source.bytes, {
        color: request.color,
        despill: request.despill,
        softness: request.softness,
        tolerance: request.tolerance,
      }, signal)
      progress('result-received')
      signal?.throwIfAborted()
      progress('publishing')
      signal?.throwIfAborted()
      const [artifact] = await this.#artifacts.registerGeneratedImages({
        conversationId: request.conversationId,
        cwd: request.cwd,
        grants: request.grants,
        images: [{ bytes, mimeType: 'image/png' }],
        outputPath: request.outputPath,
        sourceArtifactId: request.sourceArtifactId,
      })
      if (!artifact)
        throw new ImageTransformError('IMAGE_TRANSFORM_FAILED')
      return { value: artifact, artifactIds: [artifact.id] }
    })
  }

  dispose(): Promise<void> {
    return this.#operations.dispose()
  }
}
