import type { DatabaseSync } from 'node:sqlite'
import { isAsyncFunction } from 'node:util/types'
import { Emitter } from '../../../shared/events/Emitter'
import { getStorageIsolation } from './StorageIsolation'

type TransactionPhase = 'begin' | 'operation' | 'commit'
export type SynchronousOperation<T> = () => T & (T extends PromiseLike<unknown> ? never : unknown)

export interface TransactionFailure {
  phase: TransactionPhase
  outcome: 'not_started' | 'rolled_back' | 'unknown'
  cleanupError?: unknown
}

interface TransactionContext {
  failure: { error: unknown } | null
  ended: TransactionFailure | null
  notifications: Array<() => unknown>
}

interface ConnectionTransactions {
  active: TransactionContext | null
  uncertain: BuddyTransactionUncertainError | null
  notifications: Emitter<() => unknown>
}

const connections = new WeakMap<DatabaseSync, ConnectionTransactions>()
const failures = new WeakMap<object, TransactionFailure>()

export class BuddyTransactionUncertainError extends Error {
  readonly code = 'STORAGE_TRANSACTION_UNCERTAIN'
  readonly failure: TransactionFailure

  constructor(cause: unknown, failure: TransactionFailure) {
    super('Storage transaction outcome requires verification on a new connection', { cause })
    this.name = 'BuddyTransactionUncertainError'
    this.failure = failure
  }
}

export function readTransactionFailure(error: unknown): TransactionFailure | null {
  return error instanceof BuddyTransactionUncertainError
    ? error.failure
    : isObject(error) ? failures.get(error) ?? null : null
}

export function assertCommittedRead(database: DatabaseSync): void {
  const connection = getConnection(database)
  if (connection.uncertain)
    throw connection.uncertain
  getStorageIsolation(database).assertAvailable()
  if (connection.active || database.isTransaction)
    throw new Error('Committed state cannot be queried from an active transaction')
}

export function withTransaction<T>(database: DatabaseSync, operation: SynchronousOperation<T>): T {
  const connection = getConnection(database)
  if (connection.uncertain)
    throw connection.uncertain
  getStorageIsolation(database).assertAvailable()
  if (connection.active) {
    try {
      return participate(connection.active, operation)
    }
    catch (error) {
      closeAutoRolledBackConnection(database, connection.active)
      throw error
    }
  }
  if (database.isTransaction)
    throw new Error('Storage transaction must be owned by withTransaction')

  const context: TransactionContext = { failure: null, ended: null, notifications: [] }
  let phase: TransactionPhase = 'begin'
  let result: T
  try {
    database.exec('BEGIN IMMEDIATE')
    connection.active = context
    phase = 'operation'
    result = participate(context, operation)
    if (context.failure)
      throw context.failure.error
    phase = 'commit'
    database.exec('COMMIT')
  }
  catch (cause) {
    const original = context.failure ? context.failure.error : cause
    const error = isObject(original) ? original : new Error('Storage transaction failed', { cause: original })
    const failure = context.ended ?? rollback(database, phase)
    failures.set(error, failure)
    if (failure.outcome === 'unknown') {
      connection.uncertain = new BuddyTransactionUncertainError(error, failure)
      getStorageIsolation(database).isolate(connection.uncertain)
      throw connection.uncertain
    }
    throw error
  }
  finally {
    connection.active = null
  }
  connection.notifications.fireBatch(context.notifications)
  return result
}

export function afterTransactionCommit(database: DatabaseSync, notify: () => unknown, onError: (error: unknown) => void): void {
  const connection = getConnection(database)
  if (connection.uncertain)
    throw connection.uncertain
  const notification = new Emitter<void>(onError)
  notification.event(notify, { once: true })
  const publish = () => notification.fire()
  if (connection.active) {
    if (connection.active.failure)
      throw connection.active.failure.error
    connection.active.notifications.push(publish)
  }
  else {
    if (database.isTransaction)
      throw new Error('Storage transaction must be owned by withTransaction')
    connection.notifications.fire(publish)
  }
}

function getConnection(database: DatabaseSync): ConnectionTransactions {
  let connection = connections.get(database)
  if (!connection) {
    const notifications = new Emitter<() => unknown>(() => {})
    notifications.event(notify => notify())
    connection = { active: null, uncertain: null, notifications }
    connections.set(database, connection)
  }
  return connection
}

function participate<T>(context: TransactionContext, operation: () => T): T {
  if (context.failure)
    throw context.failure.error
  try {
    if (isAsyncFunction(operation))
      throw new TypeError('Storage transactions require synchronous operations')
    const result = operation()
    if (isObject(result) && 'then' in result && typeof result.then === 'function') {
      void Promise.resolve(result).catch(() => {})
      throw new TypeError('Storage transactions cannot return a promise')
    }
    return result
  }
  catch (error) {
    context.failure ??= { error }
    throw error
  }
}

function rollback(database: DatabaseSync, phase: TransactionPhase): TransactionFailure {
  try {
    if (database.isTransaction) {
      database.exec('ROLLBACK')
      if (database.isTransaction)
        throw new Error('Storage transaction remains active after rollback')
      return { phase, outcome: 'rolled_back' }
    }
    return { phase, outcome: phase === 'begin' ? 'not_started' : phase === 'operation' ? 'rolled_back' : 'unknown' }
  }
  catch (cleanupError) {
    return { phase, outcome: 'unknown', cleanupError }
  }
}

function closeAutoRolledBackConnection(database: DatabaseSync, context: TransactionContext): void {
  if (context.ended)
    return
  try {
    if (!database.isTransaction) {
      context.ended = { phase: 'operation', outcome: 'rolled_back' }
      database.close()
    }
  }
  catch (cleanupError) {
    context.ended = { phase: 'operation', outcome: 'unknown', cleanupError }
  }
}

function isObject(value: unknown): value is object {
  return value !== null && (typeof value === 'object' || typeof value === 'function')
}
