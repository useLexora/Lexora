import type { Prisma } from '@prisma/client'
import { Buffer } from 'node:buffer'
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto'
import process from 'node:process'
import { Logger } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { NestFactory } from '@nestjs/core'
import { getEnv } from '../config/env.schema'
import { PrismaService } from '../database/prisma.service'
import { CliModule } from './cli.module'

const ALGORITHM = 'aes-256-gcm'
const AUTH_TAG_LENGTH = 16
const IV_LENGTH = 12
const HEX_RE = /^[0-9a-f]+$/i
const logger = new Logger('MigrateCryptoNamespaceCommand')

interface CryptoNamespace {
  salt: string
  info: string
}

interface EncryptedColumnSpec {
  name: string
  tableName: string
  idColumnName: string
  valueColumnName: string
}

interface EncryptedRow {
  id: string
  value: string
}

interface ColumnMigrationSummary {
  name: string
  total: number
  migrated: number
  alreadyTarget: number
  plaintextEncrypted: number
}

const SOURCE_NAMESPACE: CryptoNamespace = {
  salt: 'samepage-api',
  info: 'samepage:encryption',
}

const TARGET_NAMESPACE: CryptoNamespace = {
  salt: 'lexora-api',
  info: 'lexora:encryption',
}

const ENCRYPTED_COLUMNS: EncryptedColumnSpec[] = [
  {
    name: 'AiProvider.apiKeyEncrypted',
    tableName: 'AiProvider',
    idColumnName: 'id',
    valueColumnName: 'apiKeyEncrypted',
  },
  {
    name: 'SystemAuthConfig.registrationInviteCodeEncrypted',
    tableName: 'SystemAuthConfig',
    idColumnName: 'id',
    valueColumnName: 'registrationInviteCodeEncrypted',
  },
  {
    name: 'SystemEmailConfig.smtpPasswordEncrypted',
    tableName: 'SystemEmailConfig',
    idColumnName: 'id',
    valueColumnName: 'smtpPasswordEncrypted',
  },
  {
    name: 'BotAccount.credentialEncrypted',
    tableName: 'BotAccount',
    idColumnName: 'id',
    valueColumnName: 'credentialEncrypted',
  },
]

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run')
  const app = await NestFactory.createApplicationContext(CliModule)
  const configService = app.get(ConfigService)
  const prisma = app.get(PrismaService).$bypass

  try {
    const appSecret = getEnv().APP_SECRET
    const targetKeyHex = configService.getOrThrow<string>('crypto.encryptionKey')
    const sourceKeyHex = deriveEncryptionKey(appSecret, SOURCE_NAMESPACE)
    const derivedTargetKeyHex = deriveEncryptionKey(appSecret, TARGET_NAMESPACE)

    if (targetKeyHex !== derivedTargetKeyHex) {
      throw new Error('当前 crypto.encryptionKey 与 Lexora 目标命名空间不一致，请先确认运行代码版本')
    }
    if (sourceKeyHex === targetKeyHex) {
      throw new Error('源命名空间和目标命名空间派生出了相同密钥，迁移配置异常')
    }

    logger.log(`Mode: ${dryRun ? 'dry-run' : 'apply'}`)
    logger.log(`Source namespace: ${SOURCE_NAMESPACE.salt}/${SOURCE_NAMESPACE.info}`)
    logger.log(`Target namespace: ${TARGET_NAMESPACE.salt}/${TARGET_NAMESPACE.info}`)

    const summaries = dryRun
      ? await migrateEncryptedColumns(prisma, sourceKeyHex, targetKeyHex, true)
      : await prisma.$transaction(tx => migrateEncryptedColumns(tx, sourceKeyHex, targetKeyHex, false))

    for (const summary of summaries) {
      logger.log(`${summary.name}: total=${summary.total}, migrated=${summary.migrated}, alreadyTarget=${summary.alreadyTarget}, plaintextEncrypted=${summary.plaintextEncrypted}`)
    }
  }
  finally {
    await app.close()
  }
}

async function migrateEncryptedColumns(
  prisma: Prisma.TransactionClient,
  sourceKeyHex: string,
  targetKeyHex: string,
  dryRun: boolean,
): Promise<ColumnMigrationSummary[]> {
  const summaries: ColumnMigrationSummary[] = []

  for (const spec of ENCRYPTED_COLUMNS) {
    const rows = await readEncryptedRows(prisma, spec)
    const summary: ColumnMigrationSummary = {
      name: spec.name,
      total: rows.length,
      migrated: 0,
      alreadyTarget: 0,
      plaintextEncrypted: 0,
    }

    for (const row of rows) {
      const nextValue = resolveTargetCiphertext(row.value, sourceKeyHex, targetKeyHex, spec, row.id)
      if (!nextValue) {
        summary.alreadyTarget += 1
        continue
      }

      if (!isEncryptedValue(row.value)) {
        summary.plaintextEncrypted += 1
      }
      else {
        summary.migrated += 1
      }

      if (!dryRun) {
        await updateEncryptedRow(prisma, spec, row.id, nextValue)
      }
    }

    summaries.push(summary)
  }

  return summaries
}

async function readEncryptedRows(
  prisma: Prisma.TransactionClient,
  spec: EncryptedColumnSpec,
): Promise<EncryptedRow[]> {
  return prisma.$queryRawUnsafe<EncryptedRow[]>(
    `SELECT "${spec.idColumnName}" AS "id", "${spec.valueColumnName}" AS "value"
     FROM "${spec.tableName}"
     WHERE "${spec.valueColumnName}" IS NOT NULL
     ORDER BY "${spec.idColumnName}"`,
  )
}

async function updateEncryptedRow(
  prisma: Prisma.TransactionClient,
  spec: EncryptedColumnSpec,
  id: string,
  value: string,
): Promise<void> {
  await prisma.$executeRawUnsafe(
    `UPDATE "${spec.tableName}" SET "${spec.valueColumnName}" = $1 WHERE "${spec.idColumnName}" = $2`,
    value,
    id,
  )
}

function resolveTargetCiphertext(
  value: string,
  sourceKeyHex: string,
  targetKeyHex: string,
  spec: EncryptedColumnSpec,
  id: string,
): string | null {
  if (canDecrypt(value, targetKeyHex)) {
    return null
  }

  if (!isEncryptedValue(value)) {
    return encryptAes256Gcm(value, targetKeyHex)
  }

  const plaintext = tryDecrypt(value, sourceKeyHex)
  if (plaintext === null) {
    throw new Error(`${spec.name}(${id}) 既不是 Lexora 密文，也无法用 SamePage 命名空间解密`)
  }

  return encryptAes256Gcm(plaintext, targetKeyHex)
}

function deriveEncryptionKey(appSecret: string, namespace: CryptoNamespace): string {
  return Buffer.from(hkdfSync(
    'sha256',
    Buffer.from(appSecret, 'utf8'),
    Buffer.from(namespace.salt, 'utf8'),
    Buffer.from(namespace.info, 'utf8'),
    32,
  )).toString('hex')
}

function encryptAes256Gcm(plaintext: string, keyHex: string): string {
  const key = Buffer.from(keyHex, 'hex')
  const iv = randomBytes(IV_LENGTH)
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: AUTH_TAG_LENGTH })
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()])
  return `${iv.toString('hex')}:${cipher.getAuthTag().toString('hex')}:${encrypted.toString('hex')}`
}

function tryDecrypt(ciphertext: string, keyHex: string): string | null {
  try {
    const parts = ciphertext.split(':')
    if (parts.length !== 3) {
      return null
    }

    const decipher = createDecipheriv(
      ALGORITHM,
      Buffer.from(keyHex, 'hex'),
      Buffer.from(parts[0], 'hex'),
      { authTagLength: AUTH_TAG_LENGTH },
    )
    decipher.setAuthTag(Buffer.from(parts[1], 'hex'))
    return Buffer.concat([decipher.update(Buffer.from(parts[2], 'hex')), decipher.final()]).toString('utf8')
  }
  catch {
    return null
  }
}

function canDecrypt(ciphertext: string, keyHex: string): boolean {
  return tryDecrypt(ciphertext, keyHex) !== null
}

function isEncryptedValue(value: string): boolean {
  const parts = value.split(':')
  return parts.length === 3 && HEX_RE.test(parts[0]) && HEX_RE.test(parts[1]) && HEX_RE.test(parts[2])
}

main().catch((error) => {
  logger.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
