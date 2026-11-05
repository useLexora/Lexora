import type { InferenceBinding, InferenceRuntime } from '../../shared/extensions/extensionInference'
import type { InferenceResourceLease } from './ExtensionInferenceResources'
import type { ExtensionPackage, ExtensionPackageStore } from './ExtensionPackageStore'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { mkdir, mkdtemp, open, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { extensionPathSchema } from '../../shared/extensions/extensionPath'
import { verifyInferenceResourcePath } from './ExtensionInferenceResources'
import { writeInferenceInitialization } from './inferenceInitialization'

export async function prepareSupervisedInferenceLaunch(bootstrap: string, store: ExtensionPackageStore, pkg: ExtensionPackage, runtime: InferenceRuntime, binding: InferenceBinding, leases: InferenceResourceLease[], signal: AbortSignal) {
  if (!/^native\/.+\.mjs$/.test(runtime.entry) || !Object.hasOwn(pkg.hashes, runtime.entry))
    throw new Error('EXTENSION_INFERENCE_ENTRY_INVALID')
  extensionPathSchema.parse(runtime.entry)
  if (runtime.gpu && !pkg.manifest.permissions.inferenceGpu)
    throw new Error('EXTENSION_INFERENCE_GPU_DENIED')
  const directory = await mkdtemp(join(tmpdir(), 'lexora-inference-'))
  const dispose = () => rm(directory, { recursive: true, force: true })
  try {
    await writeFile(join(directory, 'runtime.mjs'), bootstrap, { mode: 0o600 })
    for (const [path, hash] of Object.entries(pkg.hashes)) {
      signal.throwIfAborted()
      extensionPathSchema.parse(path)
      const handle = await open(join(store.packageRoot(pkg), path), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      try {
        if (!(await handle.stat()).isFile())
          throw new Error('EXTENSION_PACKAGE_CHANGED')
        const bytes = await handle.readFile()
        if (createHash('sha256').update(bytes).digest('hex') !== hash)
          throw new Error('EXTENSION_PACKAGE_CHANGED')
        const target = join(directory, 'plugin', path)
        await mkdir(dirname(target), { recursive: true })
        await writeFile(target, bytes, { flag: 'wx', mode: 0o600 })
      }
      finally { await handle.close() }
    }
    if (leases.length !== binding.resources.length)
      throw new Error('EXTENSION_INFERENCE_RESOURCE_UNAVAILABLE')
    const resources: Record<string, string> = {}
    const resourceFiles: Record<string, Record<string, string>> = {}
    for (const [index, lease] of leases.entries()) {
      const mount = binding.resources[index]!.mount
      const root = lease.directory ?? join(directory, 'resources', mount)
      await mkdir(root, { recursive: true })
      resources[mount] = root
      const files: Record<string, string> = {}
      for (const file of lease.files) {
        signal.throwIfAborted()
        files[file.path] = await verifyInferenceResourcePath(file)
      }
      resourceFiles[mount] = files
    }
    const libraryPaths = await Promise.all(binding.libraryPaths.map(async (item) => {
      const files = Object.entries(resourceFiles[item.mount]!).filter(([path]) => path.startsWith(`${item.path}/`))
      let directory: string | undefined
      for (const [path, hostPath] of files) {
        const suffix = path.slice(item.path.length + 1)
        let root = hostPath
        for (const _part of suffix.split('/'))
          root = dirname(root)
        if (relative(join(root, suffix), hostPath) || (directory && relative(directory, root)))
          throw new Error('EXTENSION_INFERENCE_LIBRARY_PATH_INVALID')
        directory = root
      }
      if (!directory || !(await stat(directory)).isDirectory())
        throw new Error('EXTENSION_INFERENCE_LIBRARY_PATH_INVALID')
      return directory
    }))
    signal.throwIfAborted()
    await writeInferenceInitialization(directory, { configuration: binding.configuration, resources, resourceFiles })
    signal.throwIfAborted()
    return { directory, resources, resourceFiles, libraryPaths, dispose }
  }
  catch (error) {
    await dispose()
    throw error
  }
}
