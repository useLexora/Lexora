import type { webcrypto } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { RuntimePlatform } from '../platform/RuntimePlatform'
import { Buffer } from 'node:buffer'
import { createHash, createPrivateKey, createPublicKey, randomBytes, X509Certificate } from 'node:crypto'
import { isIP } from 'node:net'
import { z } from 'zod'
import { PRIVATE_NETWORK_LIMITS } from '../../../shared/privateNetwork/limits'
import { PrivateNetworkError, privateNetworkPinSchema } from '../../../shared/privateNetwork/pairing'
import { withTransaction } from '../storage/transaction'
import 'reflect-metadata'

const storedIdentitySchema = z.object({ version: z.literal(1), profileId: z.string().min(1), privateKey: z.string().min(1).max(16384), certificate: z.string().min(1).max(16384), spkiPin: privateNetworkPinSchema }).strict()
export type PrivateNetworkTlsIdentity = z.infer<typeof storedIdentitySchema>

export async function loadPrivateNetworkTlsIdentity(options: { database: DatabaseSync, profileId: string, secrets: NonNullable<RuntimePlatform['privateNetworkSecrets']>, addresses: string[], reset?: boolean }): Promise<PrivateNetworkTlsIdentity> {
  const { ExtendedKeyUsage, ExtendedKeyUsageExtension, KeyUsageFlags, KeyUsagesExtension, SubjectAlternativeNameExtension, X509CertificateGenerator } = await import('@peculiar/x509')
  const { database, profileId, secrets } = options
  const addresses = [...new Set(options.addresses)]
  if (!addresses.length || addresses.some(address => !isPrivateNetworkAddress(address)))
    throw new PrivateNetworkError('INVALID_REQUEST')
  const marker = database.prepare('SELECT tls_pin FROM private_network_state WHERE id = 1').get()?.tls_pin
  const stored = await secrets.read(`tls:${profileId}`)
  let identity = stored === null ? null : storedIdentitySchema.parse(stored)
  if (options.reset) {
    const active = database.prepare('SELECT 1 FROM remote_devices WHERE state IN (\'pending\',\'active\') LIMIT 1').get()
    if (active)
      throw new PrivateNetworkError('NOT_AUTHORIZED')
    identity = null
  }
  else if ((!identity && marker) || (identity && (identity.profileId !== profileId || (marker && identity.spkiPin !== marker)))) {
    throw new PrivateNetworkError('TLS_IDENTITY_UNAVAILABLE')
  }
  let keys: webcrypto.CryptoKeyPair
  if (identity) {
    const privateKey = createPrivateKey(identity.privateKey)
    const publicKey = createPublicKey(privateKey)
    const publicBytes = publicKey.export({ type: 'spki', format: 'der' })
    const certificate = new X509Certificate(identity.certificate)
    const pin = `sha256/${createHash('sha256').update(publicBytes).digest('base64')}`
    if (pin !== identity.spkiPin || !certificate.publicKey.export({ type: 'spki', format: 'der' }).equals(publicBytes))
      throw new PrivateNetworkError('TLS_IDENTITY_UNAVAILABLE')
    const now = Date.now()
    if (Date.parse(certificate.validFrom) <= now && Date.parse(certificate.validTo) > now + 7 * 24 * 60 * 60 * 1000 && addresses.every(address => certificate.checkIP(address))) {
      withTransaction(database, () => database.prepare('UPDATE private_network_state SET tls_pin = ? WHERE id = 1').run(pin))
      return identity
    }
    keys = {
      privateKey: await crypto.subtle.importKey('pkcs8', new Uint8Array(privateKey.export({ type: 'pkcs8', format: 'der' })), { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']),
      publicKey: await crypto.subtle.importKey('spki', new Uint8Array(publicBytes), { name: 'ECDSA', namedCurve: 'P-256' }, true, ['verify']),
    }
  }
  else {
    keys = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'])
  }
  const now = Date.now()
  const certificate = await X509CertificateGenerator.createSelfSigned({
    serialNumber: randomBytes(16).toString('hex'),
    name: 'CN=Lexora Private Service',
    notBefore: new Date(now - 300_000),
    notAfter: new Date(now + PRIVATE_NETWORK_LIMITS.tlsCertificateDays * 24 * 60 * 60 * 1000),
    signingAlgorithm: { name: 'ECDSA', hash: 'SHA-256' },
    keys,
    extensions: [new KeyUsagesExtension(KeyUsageFlags.digitalSignature, true), new ExtendedKeyUsageExtension([ExtendedKeyUsage.serverAuth]), new SubjectAlternativeNameExtension(addresses.map(value => ({ type: 'ip', value })))],
  })
  const privateBytes = Buffer.from(await crypto.subtle.exportKey('pkcs8', keys.privateKey))
  const publicBytes = Buffer.from(await crypto.subtle.exportKey('spki', keys.publicKey))
  const result = storedIdentitySchema.parse({ version: 1, profileId, privateKey: createPrivateKey({ key: privateBytes, format: 'der', type: 'pkcs8' }).export({ type: 'pkcs8', format: 'pem' }).toString(), certificate: certificate.toString('pem'), spkiPin: `sha256/${createHash('sha256').update(publicBytes).digest('base64')}` })
  await secrets.write(`tls:${profileId}`, result)
  withTransaction(database, () => database.prepare('UPDATE private_network_state SET tls_pin = ? WHERE id = 1').run(result.spkiPin))
  return result
}

export function isPrivateNetworkAddress(address: string): boolean {
  const family = isIP(address)
  if (family === 4) {
    const [a, b] = address.split('.').map(Number)
    return a === 10 || a === 127 || (a === 172 && b! >= 16 && b! <= 31) || (a === 192 && b === 168) || (a === 100 && b! >= 64 && b! <= 127)
  }
  if (family === 6)
    return address === '::1' || /^f[cd][\da-f]{2}:/i.test(address)
  return false
}
