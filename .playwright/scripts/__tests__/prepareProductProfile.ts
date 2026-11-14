import { join } from 'node:path'
import { openBuddySqliteDatabase } from '../../../apps/buddy/service/src/storage/database'

export function prepareProductProfile(profileRoot: string) {
  openBuddySqliteDatabase({ databasePath: join(profileRoot, 'buddy/buddy.sqlite3') }).close()
}

export { resolveBuddyProcessControl } from '../../../apps/buddy/platform/native/nativeHost'
export { SessionServiceRegistration } from '../../../apps/buddy/platform/service/SessionServiceRegistration'

export { openBuddySqliteDatabase } from '../../../apps/buddy/service/src/storage/database'

export { activatePersistenceCandidate } from '../../../apps/buddy/service/src/storage/persistenceMigration/activatePersistenceCandidate'

export { importPersistenceCandidate } from '../../../apps/buddy/service/src/storage/persistenceMigration/importPersistenceCandidate'
