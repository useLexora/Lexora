import { Buffer } from 'node:buffer'
import process from 'node:process'
import { z } from 'zod'
import { OPERATING_SYSTEM } from '../../shared/platform/identifiers'
import { filePaths } from '../filesystem/filePaths'
import { runNativeCommand } from '../native/nativeCommand'

const kernelUuidSchema = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/).refine(value => value !== '00000000-0000-0000-0000-000000000000')

const supervisorIdentityFields = {
  pid: z.number().int().positive().max(0xFFFF_FFFF),
  startTime: z.string().regex(/^\d+$/).max(20).pipe(z.string().refine(value => BigInt(value) <= 0xFFFF_FFFF_FFFF_FFFFn)),
}

export const supervisedProcessIdentitySchema = z.union([
  z.object({ ...supervisorIdentityFields, bootId: kernelUuidSchema.optional() }).strict(),
  z.object({
    ...supervisorIdentityFields,
    version: z.literal(2),
    bootId: kernelUuidSchema,
    jobName: z.string().startsWith('Global\\Lexora.Buddy.Shell.v2.').refine(value => kernelUuidSchema.safeParse(value.slice('Global\\Lexora.Buddy.Shell.v2.'.length)).success).optional(),
  }).strict(),
])

export const windowsSupervisedProcessIdentitySchema = supervisedProcessIdentitySchema.refine(
  identity => !('version' in identity) || identity.jobName !== undefined,
)

const unknownReasons = [
  'identity_invalid',
  'identity_incomplete',
  'identity_version_unsupported',
  'unsupported_process',
  'platform_mismatch',
  'boot_id_unavailable',
  'checkpoint_invalid',
  'access_denied',
  'query_failed',
  'descendants_unverified',
  'legacy_identity',
  'job_not_found',
  'job_boundary_unverified',
  'unsupported_platform',
  'helper_unavailable',
  'helper_failed',
  'invalid_response',
] as const

const verificationSchema = z.discriminatedUnion('status', [
  z.object({ protocol: z.literal(1), status: z.literal('released'), reason: z.enum(['boot_changed', 'job_empty']) }).strict(),
  z.object({ protocol: z.literal(1), status: z.literal('active'), reason: z.enum(['supervisor_active', 'job_active']) }).strict(),
  z.object({ protocol: z.literal(1), status: z.literal('unknown'), reason: z.enum(unknownReasons) }).strict(),
])

const checkpointSchema = z.object({
  kind: z.literal('recovery-boot'),
  version: z.literal(1),
  platform: z.enum([OPERATING_SYSTEM.Linux, OPERATING_SYSTEM.Windows]),
  bootId: kernelUuidSchema,
}).strict()

export type OwnedProcessVerification = Omit<z.infer<typeof verificationSchema>, 'protocol'>

interface RecoveryOptions {
  signal?: AbortSignal
  executable?: string
}

function supportedPlatform() {
  return process.platform === OPERATING_SYSTEM.Linux || process.platform === OPERATING_SYSTEM.Windows
}

function parseBoundedJson(value: string): unknown {
  if (Buffer.byteLength(value, 'utf8') > 8192)
    throw new Error('Process recovery input exceeds limit')
  return JSON.parse(value)
}

async function query(command: '--reverify-owned-process' | '--process-recovery-checkpoint', input: unknown, options: RecoveryOptions) {
  const executable = options.executable ?? process.env.LEXORA_BUDDY_PROCESS_CONTROL
  if (!executable)
    return null
  return runNativeCommand(filePaths.resolveInput(executable), [command], input, {
    env: process.platform === OPERATING_SYSTEM.Windows ? { SystemRoot: process.env.SystemRoot } : {},
    maxBytes: 8192,
    timeoutMs: 5000,
    signal: options.signal,
  })
}

export async function captureProcessRecoveryCheckpoint(options: RecoveryOptions = {}): Promise<string | null> {
  options.signal?.throwIfAborted()
  if (!supportedPlatform())
    return null
  try {
    const result = await query('--process-recovery-checkpoint', null, options)
    if (!result || result.code !== 0)
      return null
    const checkpoint = checkpointSchema.parse(parseBoundedJson(result.stdout.toString('utf8')))
    return checkpoint.platform === process.platform ? JSON.stringify(checkpoint) : null
  }
  catch {
    options.signal?.throwIfAborted()
    return null
  }
}

export async function reverifyOwnedProcess(
  processId: string,
  options: RecoveryOptions & { checkpoint?: string } = {},
): Promise<OwnedProcessVerification> {
  options.signal?.throwIfAborted()
  if (!supportedPlatform())
    return { status: 'unknown', reason: 'unsupported_platform' }
  let identity: unknown
  let checkpoint: z.infer<typeof checkpointSchema> | undefined
  try {
    identity = parseBoundedJson(processId)
  }
  catch {
    return { status: 'unknown', reason: 'identity_invalid' }
  }
  if (options.checkpoint !== undefined) {
    try {
      checkpoint = checkpointSchema.parse(parseBoundedJson(options.checkpoint))
    }
    catch {
      return { status: 'unknown', reason: 'checkpoint_invalid' }
    }
  }
  try {
    const result = await query('--reverify-owned-process', { identity, checkpoint }, options)
    if (!result)
      return { status: 'unknown', reason: 'helper_unavailable' }
    if (result.code !== 0)
      return { status: 'unknown', reason: 'helper_failed' }
    const parsed = verificationSchema.safeParse(parseBoundedJson(result.stdout.toString('utf8')))
    if (!parsed.success)
      return { status: 'unknown', reason: 'invalid_response' }
    return { status: parsed.data.status, reason: parsed.data.reason }
  }
  catch {
    options.signal?.throwIfAborted()
    return { status: 'unknown', reason: 'helper_failed' }
  }
}
