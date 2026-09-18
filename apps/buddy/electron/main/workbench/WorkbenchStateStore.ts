import type { WorkbenchState } from '../../../shared/workbench/workbenchState'
import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { fileStorage } from '../../../platform/filesystem/fileStorage'
import { workbenchStateSchema } from '../../../shared/workbench/workbenchState'

const maximumBytes = 32 * 1024 * 1024

export class WorkbenchStateStore {
  readonly #directory: string
  #tail: Promise<void> = Promise.resolve()
  #read = false

  constructor(directory: string) {
    this.#directory = directory
  }

  async read(): Promise<WorkbenchState | null> {
    await this.#tail.catch(() => {})
    await mkdir(this.#directory, { recursive: true, mode: 0o700 })
    const path = join(this.#directory, 'workbench.json')
    try {
      const result = await this.#readState(path)
      this.#read = true
      return result
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        // Preserve the original before allowing a recovered layout to be persisted.
        await rename(path, join(this.#directory, `workbench.recovery-${randomUUID()}.json`))
      }
      try {
        const previous = await this.#readState(join(this.#directory, 'workbench.previous.json'))
        this.#read = true
        return previous
      }
      catch (previousError) {
        if ((previousError as NodeJS.ErrnoException).code === 'ENOENT') {
          this.#read = true
          return null
        }
        this.#read = false
        throw new Error('WORKBENCH_RECOVERY_FAILED', { cause: previousError })
      }
    }
  }

  write(state: WorkbenchState): Promise<void> {
    const parsed = workbenchStateSchema.parse(state)
    const data = JSON.stringify(parsed)
    if (Buffer.byteLength(data) > maximumBytes)
      return Promise.reject(new Error('WORKBENCH_BACKUP_LIMIT'))
    const write = this.#tail.catch(() => {}).then(async () => {
      if (!this.#read)
        throw new Error('WORKBENCH_NOT_RESTORED')
      const path = join(this.#directory, 'workbench.json')
      const temporary = join(this.#directory, `workbench-${randomUUID()}.tmp`)
      const handle = await open(temporary, 'wx', 0o600)
      try {
        try {
          await handle.writeFile(data)
          await handle.sync()
        }
        finally {
          await handle.close()
        }
        try {
          // The previous snapshot remains independently readable after a failed replace.
          const previous = await readFile(path)
          const previousPath = join(this.#directory, `workbench-previous-${randomUUID()}.tmp`)
          const backup = await open(previousPath, 'wx', 0o600)
          try {
            await backup.writeFile(previous)
            await backup.sync()
            await backup.close()
            await fileStorage.replace(previousPath, join(this.#directory, 'workbench.previous.json'))
          }
          finally {
            await backup.close()
            await rm(previousPath, { force: true })
          }
        }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
            throw error
        }
        await fileStorage.replace(temporary, path)
        await fileStorage.syncDirectory(this.#directory)
      }
      finally {
        await rm(temporary, { force: true })
      }
    })
    this.#tail = write
    return write
  }

  async #readState(path: string): Promise<WorkbenchState> {
    if ((await stat(path)).size > maximumBytes)
      throw new Error('WORKBENCH_BACKUP_LIMIT')
    return workbenchStateSchema.parse(JSON.parse(await readFile(path, 'utf8')))
  }
}
