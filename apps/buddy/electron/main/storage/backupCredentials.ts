import type { ApplicationDiagnosticReporter } from '../../../shared/diagnostics/applicationDiagnostic'
import type { BackupScope } from '../../../shared/storage/backupScope'
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'
import { z } from 'zod'
import { isMissing } from '../../../platform/storage/storageFiles'
import { isWindows } from '../../../shared/platform/identifiers'
import { createCredentialVault, createSafeStorageCipher } from '../secrets/CredentialVault'

const namespaceSchema = z.enum(['providers', 'connectors', 'web', 'sync', 'extensions', 'images'])
const credentialSchema = z.object({ namespace: namespaceSchema, id: z.string().min(1).max(256), value: z.unknown() }).strict()
const scopes = { providers: 'providers', connectors: 'connections', web: 'connections', sync: 'connections', extensions: 'plugins', images: 'settings' } as const
export async function exportBackupCredentials(home: string, selected: readonly BackupScope[]) {
  const cipher = createSafeStorageCipher()
  if (!isWindows(process.platform) && !cipher.available())
    throw new Error('CREDENTIAL_STORE_UNAVAILABLE')
  const credentials: z.infer<typeof credentialSchema>[] = []
  for (const namespace of namespaceSchema.options) {
    if (!selected.includes(scopes[namespace]))
      continue
    if (namespace === 'providers') {
      const vault = createCredentialVault({ buddyHome: home, cipher })
      for (const item of await vault.exportProviderApiKeys())
        credentials.push({ namespace, ...item })
      continue
    }
    const root = join(home, 'secrets', namespace)
    const files = await readdir(root).catch((error) => {
      if (isMissing(error))
        return []
      throw error
    })
    const entries = files.filter(name => name.endsWith('.credential'))
    if (entries.length && !cipher.available())
      throw new Error('CREDENTIAL_STORE_UNAVAILABLE')
    for (const file of entries) {
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
