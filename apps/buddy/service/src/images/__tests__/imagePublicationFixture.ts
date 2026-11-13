import type { CapturedFileWriter } from '../../changes/CapturedFileWriter'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { MutationCoordinator } from '../../changes/MutationCoordinator'
import { FileResourceCoordinator } from '../../files/FileResourceCoordinator'
import { NativeFileEngine } from '../../files/NativeFileEngine'

export function createImagePublicationFixture(root: string, signal = new AbortController().signal) {
  const engine = new NativeFileEngine(join(root, 'file-journal'))
  const files = new FileResourceCoordinator(engine)
  const mutations = new MutationCoordinator({ resources: files })
  const writeFiles: CapturedFileWriter = (paths, write) => files.withStagingDirectory(async (stagingDirectory) => {
    const claims = await files.fileWriteClaims(paths)
    const lease = await mutations.acquire({ runId: 'image-publication-test', invocationId: randomUUID(), lifetime: 'runtime', claims: [...claims, { kind: 'tree', canonicalPath: stagingDirectory }], signal })
    try {
      await mutations.withInvocation(lease, () => write(input => files.writeFile(lease.invocationId, stagingDirectory, input, signal)))
    }
    finally {
      await lease.release()
    }
  })
  return { engine, files, writeFiles, async dispose() {
    await mutations.dispose()
    await engine.dispose()
  } }
}
