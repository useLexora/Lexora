import type { DatabaseSync } from 'node:sqlite'
import type { RuntimePlatform } from '../../platform/RuntimePlatform'
import { afterEach, expect, it } from 'vitest'
import { openBuddyMigrationCandidate } from '../../storage/database'
import { CommandAdmissionService, createLocalCommandPrincipal } from '../CommandAdmissionService'
import { DesktopOpenCommandService } from '../DesktopOpenCommandService'

const databases: DatabaseSync[] = []
afterEach(() => {
  for (const database of databases.splice(0))
    database.close()
})
function fixture(openDesktop: RuntimePlatform['openDesktop']) {
  const database = openBuddyMigrationCandidate({ databasePath: ':memory:' })
  databases.push(database)
  database.exec('UPDATE storage_profile SET authority = \'sqlite\', migration_state = \'ready\'')
  const dataGeneration = String(database.prepare('SELECT data_generation FROM storage_profile').get()!.data_generation)
  const principal = createLocalCommandPrincipal(database)
  const create = (instance = 'instance') => new DesktopOpenCommandService({ database, admission: new CommandAdmissionService({ database, principal, sourceInstanceId: instance }), openDesktop })
  return { create, input: { dataGeneration, commandId: 'open', expectedServiceInstanceId: 'instance', intent: { kind: 'settings' } } }
}
const opened = { accepted: true, uiReady: true, targetVisible: true, visible: true, focused: false }
it('preserves the actual target acknowledgement across retries and service generations', async () => {
  let opens = 0
  const f = fixture(async () => {
    opens++
    return opened
  })
  const first = await f.create().execute(f.input)
  const replay = await f.create('next-instance').execute(f.input)
  expect(replay).toEqual({ created: false, receipt: first.receipt })
  expect(replay.receipt.result).toEqual({ desktop: opened })
  expect(opens).toBe(1)
  await expect(f.create('next-instance').execute({ ...f.input, commandId: 'another' })).rejects.toMatchObject({ code: 'SERVICE_INSTANCE_CHANGED' })
  expect(opens).toBe(1)
})
