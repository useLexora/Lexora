import { Buffer } from 'node:buffer'
import { writeSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { fileStorage } from '../../../apps/buddy/platform/filesystem/fileStorage'
import { AttachmentService } from '../../../apps/buddy/service/src/attachments/AttachmentService'
import { createAttachmentRepository } from '../../../apps/buddy/service/src/storage/attachmentRepository'
import { BuddyDataPaths } from '../../../apps/buddy/service/src/storage/BuddyDataPaths'
import { openBuddyMigrationCandidate } from '../../../apps/buddy/service/src/storage/database'

const [mode, directory, point] = process.argv.slice(2)
if (!directory || !['publish', 'recover'].includes(mode!))
  throw new Error('Invalid attachment crash fixture arguments')
const database = openBuddyMigrationCandidate({ databasePath: join(directory, 'data.sqlite3') })
database.exec('UPDATE storage_profile SET authority = \'sqlite\', migration_state = \'ready\'')
const repository = createAttachmentRepository(database)
const service = new AttachmentService({ paths: new BuddyDataPaths(join(directory, 'profile')), repository })
function checkpoint(name: string) {
  if (name !== point)
    return
  writeSync(1, `${JSON.stringify({ checkpoint: name })}\n`)
  process.kill(process.pid, 'SIGKILL')
}
if (mode === 'publish') {
  const persistence = repository.persistence!
  const prepare = persistence.prepare.bind(persistence)
  persistence.prepare = (input) => {
    const result = prepare(input)
    checkpoint('prepared')
    return result
  }
  const replace = fileStorage.replace
  fileStorage.replace = async (...args) => {
    checkpoint('file-synced')
    await replace(...args)
    checkpoint('renamed')
  }
  const syncDirectory = fileStorage.syncDirectory
  fileStorage.syncDirectory = async (...args) => {
    await syncDirectory(...args)
    checkpoint('directory-synced')
  }
  const create = repository.create
  repository.create = (record) => {
    const result = create(record)
    checkpoint('bound')
    return result
  }
  service.onDidChange((event) => {
    if (event.kind === 'file-published')
      checkpoint('published')
  })
  await service.registerUploads('crash-draft', [{ name: 'source.txt', mimeType: 'text/plain', bytes: Buffer.from('durable attachment bytes') }])
  throw new Error('Requested publication checkpoint was not reached')
}
else {
  const before = database.prepare('SELECT state FROM managed_files').get()
  const recovered = await service.reconcileStorage()
  const records = repository.listAll()
  const bytes = await Promise.all(records.map(record => readFile(record.storedPath, 'utf8')))
  const files = database.prepare('SELECT state, sha256, durability FROM managed_files').all()
  const references = database.prepare('SELECT kind, owner_id FROM file_references').all()
  const preparations = database.prepare('SELECT state, reserved_bytes FROM file_preparations').all()
  await service.dispose()
  database.close()
  writeSync(1, `${JSON.stringify({ before, recovered, files, references, preparations, bytes })}\n`)
}
