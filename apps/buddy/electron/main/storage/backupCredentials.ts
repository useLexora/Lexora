import type { ApplicationDiagnosticReporter } from '../../../shared/diagnostics/applicationDiagnostic'
import type { BackupScope } from '../../../shared/storage/backupScope'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { isMissing } from '../../../platform/storage/storageFiles'
import { createCredentialVault, createSafeStorageCipher } from '../secrets/CredentialVault'

const namespaceSchema = z.enum(['providers', 'connectors', 'web', 'sync', 'images'])
const credentialSchema = z.object({ namespace: namespaceSchema, id: z.string().min(1).max(256), value: z.unknown() }).strict()
const scopes = { providers: 'providers', connectors: 'connections', web: 'connections', sync: 'connections', images: 'settings' } as const
export async function exportBackupCredentials(home: string, selected: readonly BackupScope[]) {
  const cipher = createSafeStorageCipher()
  if (!cipher.available())
    throw new Error('CREDENTIAL_STORE_UNAVAILABLE')
  const credentials: z.infer<typeof credentialSchema>[] = []
  for (const namespace of namespaceSchema.options) {
    if (!selected.includes(scopes[namespace]))
      continue
    const root = join(home, 'secrets', namespace)
    const files = await readdir(root).catch((error) => {
      if (isMissing(error))
        return []
      throw error
    })
    for (const file of files.filter(name => name.endsWith('.credential'))) {
      const envelope = z.object({ id: z.string(), value: z.unknown(), version: z.literal(1) }).parse(JSON.parse(cipher.decrypt(await readFile(join(root, file)))))
      const value = envelope.value
      if (value && typeof value === 'object' && 'type' in value && value.type === 'oauth')
        continue
      credentials.push(credentialSchema.parse({ namespace, id: envelope.id, value }))
    }
  }
  return credentials
}
export async function stageBackupCredentials(home: string, value: unknown, selected: readonly BackupScope[], reportDiagnostic?: ApplicationDiagnosticReporter): Promise<void> {
  const credentials = z.array(credentialSchema).max(10000).parse(value)
  const vault = createCredentialVault({ buddyHome: home, reportDiagnostic })
  for (const item of credentials) {
    if (selected.includes(scopes[item.namespace]))
      await vault.write(item.namespace, item.id, item.value)
  }
}
