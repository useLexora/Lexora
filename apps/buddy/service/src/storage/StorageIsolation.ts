import type { DatabaseSync } from 'node:sqlite'
import { Emitter } from '../../../shared/events/Emitter'

export class StorageIsolatedError extends Error {
  readonly code = 'STORAGE_ISOLATED'

  constructor(cause: unknown) {
    super('Storage is isolated; verify committed facts on a new connection', { cause })
    this.name = 'StorageIsolatedError'
  }
}

export class StorageIsolation {
  readonly #isolated = new Emitter<StorageIsolatedError>(() => {})
  readonly onDidIsolate = this.#isolated.event
  #failure: StorageIsolatedError | null = null

  get failure(): StorageIsolatedError | null {
    return this.#failure
  }

  readonly assertAvailable = (): void => {
    if (this.#failure)
      throw this.#failure
  }

  isolate(cause: unknown): void {
    if (this.#failure)
      return
    this.#failure = new StorageIsolatedError(cause)
    this.#isolated.fire(this.#failure)
  }
}

const isolations = new WeakMap<DatabaseSync, StorageIsolation>()
const guarded = new WeakSet<DatabaseSync>()

export function getStorageIsolation(database: DatabaseSync): StorageIsolation {
  let isolation = isolations.get(database)
  if (!isolation) {
    isolation = new StorageIsolation()
    isolations.set(database, isolation)
  }
  return isolation
}

export function guardStorageDatabase(database: DatabaseSync): StorageIsolation {
  const isolation = getStorageIsolation(database)
  isolation.assertAvailable()
  if (guarded.has(database))
    return isolation
  const execute = <T>(operation: () => T, rollback = false): T => {
    if (!rollback)
      isolation.assertAvailable()
    try {
      return operation()
    }
    catch (error) {
      if (!database.isOpen || isStorageFailure(error))
        isolation.isolate(error)
      throw error
    }
  }
  const prepare = database.prepare.bind(database)
  database.prepare = (sql) => {
    const statement = execute(() => prepare(sql))
    const all = statement.all.bind(statement)
    const get = statement.get.bind(statement)
    const run = statement.run.bind(statement)
    const iterate = statement.iterate.bind(statement)
    statement.all = (...parameters) => execute(() => Reflect.apply(all, statement, parameters) as ReturnType<typeof all>)
    statement.get = (...parameters) => execute(() => Reflect.apply(get, statement, parameters) as ReturnType<typeof get>)
    statement.run = (...parameters) => execute(() => Reflect.apply(run, statement, parameters) as ReturnType<typeof run>)
    statement.iterate = function* (...parameters) {
      const iterator = execute(() => Reflect.apply(iterate, statement, parameters) as ReturnType<typeof iterate>)
      try {
        while (true) {
          const next = execute(() => iterator.next())
          if (next.done)
            return undefined
          yield next.value
        }
      }
      finally {
        iterator.return?.()
      }
    }
    return statement
  }
  const exec = database.exec.bind(database)
  database.exec = sql => execute(() => exec(sql), sql.trim().toUpperCase() === 'ROLLBACK')
  guarded.add(database)
  return isolation
}

function isStorageFailure(error: unknown): boolean {
  if (!error || typeof error !== 'object' || !('errcode' in error) || typeof error.errcode !== 'number')
    return false
  return [7, 8, 10, 11, 13, 14, 15, 26].includes(error.errcode & 0xFF)
}
