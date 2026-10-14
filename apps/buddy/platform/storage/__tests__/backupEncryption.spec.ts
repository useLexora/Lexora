import { Buffer } from 'node:buffer'
import { expect, it } from 'vitest'
import { decryptBackupCredentials, encryptBackupCredentials } from '../backupEncryption'

it('round-trips credentials with a password and rejects an incorrect password or modified ciphertext', async () => {
  const credentials = [{ namespace: 'providers', id: 'fixture', value: { type: 'api_key', key: 'synthetic-key-only' } }]
  const bytes = await encryptBackupCredentials(credentials, 'fixture-password')
  expect(Buffer.from(bytes).toString()).not.toContain('synthetic-key-only')
  expect(await decryptBackupCredentials(bytes, 'fixture-password')).toEqual(credentials)
  await expect(decryptBackupCredentials(bytes, 'wrong-password')).rejects.toThrow('SNAPSHOT_PASSWORD_INVALID')
  const modified = JSON.parse(Buffer.from(bytes).toString())
  modified.tag = `${modified.tag.startsWith('00') ? 'ff' : '00'}${modified.tag.slice(2)}`
  await expect(decryptBackupCredentials(Buffer.from(JSON.stringify(modified)), 'fixture-password')).rejects.toThrow('SNAPSHOT_PASSWORD_INVALID')
})
