import type { RuntimeRpcPeerContract } from '../../../shared/runtime/rpcPeer'
import type { ArtifactService } from '../artifacts/ArtifactService'
import type { ExtensionTaskSession } from '../conversations/ExtensionTaskContext'
import type { ExtensionInvocationScope } from './extensionAgentHandlers'
import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { resizeImage } from '@earendil-works/pi-coding-agent'
import { z } from 'zod'
import { extensionAgentRpc } from '../../../shared/extensions/extensionAgent'
import { EXTENSION_ARTIFACT_BYTES_LIMIT, EXTENSION_IMAGE_BYTES_LIMIT, extensionAgentResourceResponseSchema, extensionArtifactNameSchema } from '../../../shared/extensions/extensionAgentResources'
import { runNativeImage } from '../images/runNativeImage'
import { extensionAgentHandler } from './extensionAgentHandlers'

export function createExtensionResourceCapabilities(options: { rpc: RuntimeRpcPeerContract, artifacts: Pick<ArtifactService, 'registerGeneratedFile'> }, task: ExtensionTaskSession, scope: ExtensionInvocationScope) {
  const current = (write = false) => {
    task.assertCurrent()
    if (scope.action || !scope.runId || !scope.output || (write && scope.output.access !== 'write'))
      throw new Error('EXTENSION_PERMISSION_DENIED')
    return scope.output
  }
  const open = async (id: string, limit: number) => {
    current()
    const chunk = async (offset: number, length: number) => {
      current()
      const result = extensionAgentResourceResponseSchema.parse(await options.rpc.request(extensionAgentRpc.resource, { invocationId: scope.invocationId, extensionId: scope.extensionId, resourceId: id, offset, length }, null, scope.signal))
      current()
      if (result.resource.id !== id || result.resource.size !== result.size || result.size > limit)
        throw new Error('EXTENSION_RESOURCE_LIMIT')
      return result
    }
    const first = await chunk(0, 64 * 1024)
    const resource = first.resource
    const stream = async function* () {
      let part = first
      let offset = 0
      while (true) {
        const data = Buffer.from(part.base64, 'base64')
        if (JSON.stringify(part.resource) !== JSON.stringify(resource) || data.length > 64 * 1024 || offset + data.length > resource.size || (!data.length && !part.eof))
          throw new Error('EXTENSION_RESOURCE_CHANGED')
        offset += data.length
        yield data
        if (part.eof)
          break
        part = await chunk(offset, 64 * 1024)
      }
      if (offset !== resource.size)
        throw new Error('EXTENSION_RESOURCE_CHANGED')
    }
    const verify = async () => {
      const latest = await chunk(resource.size, 1)
      if (JSON.stringify(latest.resource) !== JSON.stringify(resource))
        throw new Error('EXTENSION_RESOURCE_CHANGED')
    }
    return { resource, stream, verify }
  }

  return {
    'task.scope': extensionAgentHandler('task.scope', () => {
      current()
      return { taskId: task.conversationId, branchId: task.branchId, runId: scope.runId! }
    }),
    'artifacts.publish': extensionAgentHandler('artifacts.publish', async (input) => {
      const output = current(true)
      const source = await open(input.resource.id, EXTENSION_ARTIFACT_BYTES_LIMIT)
      const name = extensionArtifactNameSchema.parse(input.name ?? source.resource.name)
      const artifact = await options.artifacts.registerGeneratedFile({ conversationId: task.conversationId, cwd: output.cwd, grants: output.grants, outputPath: join(output.cwd, 'outputs', randomUUID(), name), bytes: source.stream(), size: source.resource.size, assertCurrent: async () => {
        current(true)
        await source.verify()
      } }, output.writeFiles)
      output.artifactIds.push(artifact.id)
      current(true)
      return { id: artifact.id, name: artifact.name, mimeType: artifact.mimeType, size: artifact.sizeBytes }
    }),
    'results.addImage': extensionAgentHandler('results.addImage', async (input) => {
      const output = current()
      if (output.images.length >= 4)
        throw new Error('EXTENSION_IMAGE_LIMIT')
      const source = await open(input.resource.id, EXTENSION_IMAGE_BYTES_LIMIT)
      const bytes = Buffer.alloc(source.resource.size)
      let offset = 0
      for await (const chunk of source.stream()) {
        bytes.set(chunk, offset)
        offset += chunk.length
      }
      if (!['image/png', 'image/jpeg', 'image/webp'].includes(source.resource.mimeType) || output.imageBytes + bytes.length > 16 * 1024 * 1024)
        throw new Error('EXTENSION_IMAGE_LIMIT')
      const metadata = z.object({ width: z.number().positive().max(25000000), height: z.number().positive().max(25000000), mimeType: z.string() }).parse(JSON.parse((await runNativeImage(bytes, { operation: 'validate', options: { mimeType: source.resource.mimeType } }, scope.signal)).toString('utf8')))
      if (metadata.mimeType !== source.resource.mimeType || metadata.width * metadata.height > 25_000_000)
        throw new Error('EXTENSION_IMAGE_LIMIT')
      const image = await resizeImage(bytes, source.resource.mimeType, { maxWidth: 2000, maxHeight: 2000, maxBytes: 2 * 1024 * 1024 })
      if (!image)
        throw new Error('EXTENSION_IMAGE_INVALID')
      await source.verify()
      current()
      output.imageBytes += bytes.length
      output.images.push({ type: 'image', data: image.data, mimeType: image.mimeType })
      return null
    }),
  }
}
