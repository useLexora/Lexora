import { Buffer } from 'node:buffer'
import process from 'node:process'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { runNativeCommand } from '../../native/nativeCommand'
import { captureProcessRecoveryCheckpoint, reverifyOwnedProcess, supervisedProcessIdentitySchema, windowsSupervisedProcessIdentitySchema } from '../ownedProcessRecovery'

vi.mock('../../native/nativeCommand', () => ({ runNativeCommand: vi.fn() }))

const checkpoint = { kind: 'recovery-boot', version: 1, platform: process.platform, bootId: 'e840eb15-dbf6-48e9-b438-bc6d07774d32' }
const identity = JSON.stringify({ kind: 'native-shell', platform: process.platform, pid: 32, startTime: '123', nonce: 'fixture' })
const options = { executable: process.execPath }

function response(value: unknown, code = 0) {
  vi.mocked(runNativeCommand).mockResolvedValue({ code, stdout: Buffer.from(JSON.stringify(value)), stderr: '' })
}

describe.skipIf(!['linux', 'win32'].includes(process.platform))('owned process recovery protocol', () => {
  beforeEach(() => {
    vi.mocked(runNativeCommand).mockReset()
  })

  it.each([
    { status: 'released', reason: 'boot_changed' },
    { status: 'released', reason: 'job_empty' },
    { status: 'active', reason: 'supervisor_active' },
    { status: 'active', reason: 'job_active' },
    { status: 'unknown', reason: 'access_denied' },
    { status: 'unknown', reason: 'descendants_unverified' },
    { status: 'unknown', reason: 'job_not_found' },
  ])('preserves bounded evidence $status/$reason', async (result) => {
    response({ protocol: 1, ...result })
    await expect(reverifyOwnedProcess(identity, options)).resolves.toEqual(result)
  })

  it.each([
    { protocol: 1, status: 'released', reason: 'supervisor_active' },
    { protocol: 1, status: 'released', reason: 'pid_not_found' },
    { protocol: 2, status: 'released', reason: 'job_empty' },
    { protocol: 1, status: 'released', reason: 'job_empty', pid: 32 },
    { protocol: 1, status: 'unknown', reason: 'arbitrary native message' },
  ])('rejects contradictory or unknown native evidence', async (result) => {
    response(result)
    await expect(reverifyOwnedProcess(identity, options)).resolves.toEqual({ status: 'unknown', reason: 'invalid_response' })
  })

  it('rejects a successful-looking response from a failed helper', async () => {
    response({ protocol: 1, status: 'released', reason: 'job_empty' }, 1)
    await expect(reverifyOwnedProcess(identity, options)).resolves.toEqual({ status: 'unknown', reason: 'helper_failed' })
  })

  it('does not substitute process disappearance for a failed native query', async () => {
    vi.mocked(runNativeCommand).mockRejectedValue(new Error('ENOENT'))
    await expect(reverifyOwnedProcess(identity, options)).resolves.toEqual({ status: 'unknown', reason: 'helper_failed' })
  })

  it('keeps malformed and oversized identities unknown', async () => {
    await expect(reverifyOwnedProcess('{', options)).resolves.toEqual({ status: 'unknown', reason: 'identity_invalid' })
    await expect(reverifyOwnedProcess(' '.repeat(8193), options)).resolves.toEqual({ status: 'unknown', reason: 'identity_invalid' })
  })

  it('rejects malformed checkpoints instead of treating them as proof', async () => {
    await expect(reverifyOwnedProcess(identity, { ...options, checkpoint: '{"bootId":"yesterday"}' }))
      .resolves
      .toEqual({ status: 'unknown', reason: 'checkpoint_invalid' })
  })

  it('captures only a validated local kernel boot checkpoint', async () => {
    response(checkpoint)
    await expect(captureProcessRecoveryCheckpoint(options)).resolves.toBe(JSON.stringify(checkpoint))
  })

  it.each([
    { ...checkpoint, bootId: 'yesterday' },
    { ...checkpoint, platform: 'darwin' },
    { ...checkpoint, version: 2 },
    { protocol: 1, status: 'unknown', reason: 'boot_id_unavailable' },
  ])('does not persist an invalid boot checkpoint', async (value) => {
    response(value)
    await expect(captureProcessRecoveryCheckpoint(options)).resolves.toBeNull()
  })

  it('accepts the native Windows v2 named-job identity without losing its boot or job fields', () => {
    const nativeIdentity = {
      version: 2,
      pid: 32,
      startTime: '123',
      bootId: checkpoint.bootId,
      jobName: 'Global\\Lexora.Buddy.Shell.v2.e840eb15-dbf6-48e9-b438-bc6d07774d32',
    }
    expect(windowsSupervisedProcessIdentitySchema.parse(nativeIdentity)).toEqual(nativeIdentity)
  })

  it('accepts legacy handshakes and requires complete Windows v2 identity', () => {
    expect(windowsSupervisedProcessIdentitySchema.safeParse({ pid: 32, startTime: '123' }).success).toBe(true)
    const linuxIdentity = { version: 2, pid: 32, startTime: '123', bootId: checkpoint.bootId }
    expect(supervisedProcessIdentitySchema.safeParse(linuxIdentity).success).toBe(true)
    expect(windowsSupervisedProcessIdentitySchema.safeParse(linuxIdentity).success).toBe(false)
    expect(supervisedProcessIdentitySchema.safeParse({ pid: 32, startTime: 'not-a-time' }).success).toBe(false)
  })

  it('propagates cancellation without returning release evidence', async () => {
    const controller = new AbortController()
    controller.abort(new Error('cancelled'))
    await expect(reverifyOwnedProcess(identity, { ...options, signal: controller.signal })).rejects.toThrow('cancelled')
  })
})
