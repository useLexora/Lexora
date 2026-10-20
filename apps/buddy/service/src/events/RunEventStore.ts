import type { FileHandle } from 'node:fs/promises'
import type { BuddyRunEvent } from './BuddyRunEvent'
import type { RunEventFailureScope } from './RunEventFailure'
import { Buffer } from 'node:buffer'
import { randomUUID } from 'node:crypto'
import {
  mkdir,
  open,
  readdir,
  readFile,
  stat,
  unlink,
} from 'node:fs/promises'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { fileStorage } from '../../../platform/filesystem/fileStorage'
import { buddyRunEventSchema, buddyRunIdSchema } from './BuddyRunEvent'
import {
  RunEventCorruptionError,
  runEventFailureScope,
  RunEventStorageError,
} from './RunEventFailure'

const { replace: rename, syncDirectory } = fileStorage
const eventTemporaryFilePattern
  = /^\.[A-Z0-9][\w-]{0,127}\.[1-9]\d*\.[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}\.tmp$/i

export interface RunEventStoreOptions {
  conversationsDirectory: string
  resolveConversationId: (runId: string) => string | null
}

export class RunEventStore {
  readonly #conversationsDirectory: string
  readonly #resolveConversationId: (runId: string) => string | null

  constructor(options: RunEventStoreOptions) {
    this.#conversationsDirectory = options.conversationsDirectory
    this.#resolveConversationId = options.resolveConversationId
  }

  async append(events: readonly BuddyRunEvent[]): Promise<void> {
    const scope = runEventFailureScope(events[0]!.runId, events)
    const content = `${events.map(event => JSON.stringify(event)).join('\n')}\n`
    const eventDirectory = this.#eventDirectory(events[0]!.runId)
    const createdDirectory = await runStorageStage(
      scope,
      'append',
      'mkdir',
      'unknown',
      () => mkdir(eventDirectory, { mode: 0o700, recursive: true }),
    )
    const { created, file } = await this.#openEventFile(scope)
    let failure: RunEventStorageError | null = null
    let stage: RunEventStorageError['stage'] = 'write'
    let synchronized = false
    try {
      await file.writeFile(content, 'utf8')
      stage = 'sync'
      await file.sync()
      synchronized = true
    }
    catch (cause) {
      failure = new RunEventStorageError(scope, 'append', stage, 'unknown', { cause })
    }
    try {
      await file.close()
    }
    catch (cause) {
      failure ??= new RunEventStorageError(
        scope,
        'append',
        'close',
        synchronized && !created ? 'committed' : 'unknown',
        { cause },
      )
    }
    if (failure)
      throw failure
    if (created) {
      try {
        await syncDirectory(eventDirectory)
        if (createdDirectory)
          await syncDirectory(dirname(eventDirectory))
      }
      catch (cause) {
        throw new RunEventStorageError(
          scope,
          'append',
          'directory',
          'unknown',
          { cause },
        )
      }
    }
  }

  async fingerprint(runId: string, conversationId?: string): Promise<string | null> {
    try {
      const metadata = await stat(this.#eventPath(runId, conversationId), { bigint: true })
      if (!metadata.isFile())
        throw new Error('Lexora Buddy event path is not a regular file')
      return [metadata.dev, metadata.ino, metadata.size, metadata.mtimeNs, metadata.ctimeNs, metadata.birthtimeNs].join(':')
    }
    catch (cause) {
      if (isFileNotFound(cause))
        return null
      throw new RunEventStorageError(runEventFailureScope(runId), 'read', 'stat', 'not_applicable', { cause })
    }
  }

  async readAndRepair(runId: string, conversationId?: string): Promise<BuddyRunEvent[]> {
    const path = this.#eventPath(runId, conversationId)
    const readScope = runEventFailureScope(runId)
    let content: string
    try {
      content = await readFile(path, 'utf8')
    }
    catch (error) {
      if (isFileNotFound(error))
        return []
      throw new RunEventStorageError(
        readScope,
        'read',
        'read',
        'not_applicable',
        { cause: error },
      )
    }
    let events: BuddyRunEvent[]
    try {
      events = parseEventLines(content, runId)
    }
    catch (cause) {
      throw new RunEventCorruptionError(runId, { cause })
    }
    const scope = runEventFailureScope(runId, events)
    if (content.length > 0 && !content.endsWith('\n')) {
      const appendPosition = Buffer.byteLength(content, 'utf8')
      await this.#repairEventFile(scope, 'write', file => (
        file.write('\n', appendPosition, 'utf8').then(() => undefined)
      ))
    }
    return events
  }

  async replace(
    runId: string,
    events: readonly BuddyRunEvent[],
    replacedEvents: readonly BuddyRunEvent[],
  ): Promise<void> {
    const scope = runEventFailureScope(runId, replacedEvents)
    const eventDirectory = this.#eventDirectory(runId)
    await runStorageStage(
      scope,
      'compact',
      'mkdir',
      'unknown',
      () => mkdir(eventDirectory, { mode: 0o700, recursive: true }),
    )
    const path = this.#eventPath(runId)
    const temporaryPath = join(
      eventDirectory,
      `.${runId}.${process.pid}.${randomUUID()}.tmp`,
    )
    try {
      await writeDurableFile(
        temporaryPath,
        `${events.map(event => JSON.stringify(event)).join('\n')}\n`,
        scope,
      )
    }
    catch (error) {
      await removeFileIfExists(temporaryPath).catch(() => {})
      throw error
    }
    try {
      await rename(temporaryPath, path)
    }
    catch (cause) {
      await removeFileIfExists(temporaryPath).catch(() => {})
      throw new RunEventStorageError(
        scope,
        'compact',
        'rename',
        'unknown',
        { cause },
      )
    }
    try {
      await syncDirectory(eventDirectory)
    }
    catch (cause) {
      throw new RunEventStorageError(
        scope,
        'compact',
        'directory',
        'unknown',
        { cause },
      )
    }
  }

  async listPersistedRunIds(runIds: readonly string[], conversations?: ReadonlyMap<string, string>): Promise<string[]> {
    const entriesByDirectory = new Map<string, Set<string>>()
    const persistedRunIds: string[] = []
    for (const runId of runIds) {
      const scope = runEventFailureScope(runId)
      const directory = this.#eventDirectory(runId, conversations?.get(runId))
      let entries = entriesByDirectory.get(directory)
      if (!entries) {
        let names: string[]
        try {
          names = await readdir(directory)
        }
        catch (error) {
          if (isFileNotFound(error))
            continue
          throw new RunEventStorageError(
            scope,
            'scan',
            'readdir',
            'not_applicable',
            { cause: error },
          )
        }
        const staleTemporaryFiles = names.filter(entry => eventTemporaryFilePattern.test(entry))
        for (const entry of staleTemporaryFiles) {
          await runStorageStage(
            scope,
            'scan',
            'unlink',
            'not_applicable',
            () => removeFileIfExists(join(directory, entry)),
          )
        }
        if (staleTemporaryFiles.length > 0) {
          await runStorageStage(
            scope,
            'scan',
            'directory',
            'not_applicable',
            () => syncDirectory(directory),
          )
        }
        entries = new Set(names)
        entriesByDirectory.set(directory, entries)
      }
      if (entries.has(`${runId}.jsonl`))
        persistedRunIds.push(runId)
    }
    return persistedRunIds
  }

  #eventPath(runId: string, conversationId?: string): string {
    return join(this.#eventDirectory(runId, conversationId), `${buddyRunIdSchema.parse(runId)}.jsonl`)
  }

  #eventDirectory(runId: string, knownConversationId?: string): string {
    const conversationId = knownConversationId ?? this.#resolveConversationId(runId)
    if (conversationId === null)
      throw new Error(`Lexora Buddy run was not found: ${runId}`)
    return join(
      this.#conversationsDirectory,
      buddyRunIdSchema.parse(conversationId),
      'events',
    )
  }

  async #openEventFile(scope: RunEventFailureScope): Promise<{ created: boolean, file: FileHandle }> {
    const path = this.#eventPath(scope.runId)
    try {
      return { created: true, file: await open(path, 'ax', 0o600) }
    }
    catch (cause) {
      if (!isFileExists(cause)) {
        throw new RunEventStorageError(
          scope,
          'append',
          'open',
          'unknown',
          { cause },
        )
      }
      return {
        created: false,
        file: await runStorageStage(
          scope,
          'append',
          'open',
          'unknown',
          () => open(path, 'a', 0o600),
        ),
      }
    }
  }

  async #repairEventFile(
    scope: RunEventFailureScope,
    mutationStage: Extract<RunEventStorageError['stage'], 'truncate' | 'write'>,
    mutate: (file: FileHandle) => Promise<void>,
  ): Promise<void> {
    const file = await runStorageStage(
      scope,
      'repair',
      'open',
      'unknown',
      () => open(this.#eventPath(scope.runId), 'r+'),
    )
    let failure: RunEventStorageError | null = null
    let synchronized = false
    try {
      await mutate(file)
    }
    catch (cause) {
      failure = new RunEventStorageError(
        scope,
        'repair',
        mutationStage,
        'unknown',
        { cause },
      )
    }
    if (!failure) {
      try {
        await file.sync()
        synchronized = true
      }
      catch (cause) {
        failure = new RunEventStorageError(
          scope,
          'repair',
          'sync',
          'unknown',
          { cause },
        )
      }
    }
    try {
      await file.close()
    }
    catch (cause) {
      failure ??= new RunEventStorageError(
        scope,
        'repair',
        'close',
        synchronized ? 'committed' : 'unknown',
        { cause },
      )
    }
    if (failure)
      throw failure
  }
}

function parseEventLines(
  content: string,
  runId: string,
): BuddyRunEvent[] {
  const lines = content.split('\n')
  if (lines.at(-1) === '')
    lines.pop()
  const events: BuddyRunEvent[] = []
  for (const line of lines) {
    if (!line.trim())
      continue
    const event = buddyRunEventSchema.parse(JSON.parse(line))
    if (event.runId !== runId || event.sequence <= (events.at(-1)?.sequence ?? 0))
      throw new Error(`Lexora Buddy run event sequence is invalid: ${runId}`)
    events.push(event)
  }
  return events
}

async function writeDurableFile(
  path: string,
  content: string,
  scope: RunEventFailureScope,
): Promise<void> {
  const file = await runStorageStage(
    scope,
    'compact',
    'open',
    'unknown',
    () => open(path, 'wx', 0o600),
  )
  let failure: RunEventStorageError | null = null
  let stage: RunEventStorageError['stage'] = 'write'
  try {
    await file.writeFile(content, 'utf8')
    stage = 'sync'
    await file.sync()
  }
  catch (cause) {
    failure = new RunEventStorageError(
      scope,
      'compact',
      stage,
      'unknown',
      { cause },
    )
  }
  try {
    await file.close()
  }
  catch (cause) {
    failure ??= new RunEventStorageError(
      scope,
      'compact',
      'close',
      'unknown',
      { cause },
    )
  }
  if (failure)
    throw failure
}

async function runStorageStage<T>(
  scope: RunEventFailureScope,
  operation: RunEventStorageError['operation'],
  stage: RunEventStorageError['stage'],
  commitState: RunEventStorageError['commitState'],
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run()
  }
  catch (cause) {
    throw new RunEventStorageError(
      scope,
      operation,
      stage,
      commitState,
      { cause },
    )
  }
}

async function removeFileIfExists(path: string): Promise<void> {
  try {
    await unlink(path)
  }
  catch (error) {
    if (!isFileNotFound(error))
      throw error
  }
}

function isFileNotFound(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

function isFileExists(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'EEXIST'
}
