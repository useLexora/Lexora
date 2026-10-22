import type { RuntimeRequestRegistrar } from '../rpc/runtimeRequest'
import type { ArtifactService } from './ArtifactService'
import { z } from 'zod'
import { artifactsRpc } from '../../../shared/artifacts/artifactApi'
import { parse, registerRuntimeRequest } from '../rpc/runtimeRequest'

const idSchema = z.string().trim().min(1).max(256)

export interface RegisterArtifactRpcOptions {
  rpc: RuntimeRequestRegistrar
  service: Pick<ArtifactService, 'readText' | 'resolveBrowserEntry' | 'resolvePreview' | 'resolveMedia' | 'locate'>
}

export function registerArtifactRpc(options: RegisterArtifactRpcOptions): () => void {
  const disposers = [
    registerRuntimeRequest(options.rpc, artifactsRpc.resolveMedia, input => options.service.resolveMedia(input.artifactId)),
    registerRuntimeRequest(options.rpc, artifactsRpc.locate, input => options.service.locate(input.artifactId)),
    options.rpc.onRequest('artifacts.resolveBrowserEntry', (params) => {
      const input = parse(z.object({
        artifactId: idSchema,
        conversationId: z.string().trim().min(1).max(128),
      }).strict(), params)
      return options.service.resolveBrowserEntry(input.conversationId, input.artifactId)
    }),
    options.rpc.onRequest('artifacts.resolvePreview', (params) => {
      const input = parse(z.object({ artifactId: idSchema }).strict(), params)
      return options.service.resolvePreview(input.artifactId)
    }),
    registerRuntimeRequest(options.rpc, artifactsRpc.readText, (input) => {
      return options.service.readText(input.artifactId)
    }),
  ]
  return () => disposers.splice(0).forEach(dispose => dispose())
}
