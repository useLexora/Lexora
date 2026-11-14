import { readFile, readlink, realpath } from 'node:fs/promises'
import process from 'node:process'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import { serviceProcessIdentitySchema } from '../../shared/service/localServiceProtocol'
import { runNativeCommand } from '../native/nativeCommand'

export async function readServiceProcessIdentity(pid = process.pid, helper?: string) {
  if (process.platform === 'linux') {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8')
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ')
    const start = fields[19]
    const executable = await readlink(`/proc/${pid}/exe`)
    const boot = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim()
    const current = await readFile(`/proc/${pid}/stat`, 'utf8')
    if (!start || !/^\d+$/.test(start) || current.slice(current.lastIndexOf(')') + 2).split(' ')[19] !== start || ['Z', 'X'].includes(fields[0]!))
      throw new Error('SERVICE_PROCESS_CHANGED')
    return serviceProcessIdentitySchema.parse({ pid, executable, startIdentity: `${boot}:${start}` })
  }
  if (helper) {
    const result = await runNativeCommand(helper, [], { operation: 'read', pid, protectedPids: [] }, { env: process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot } : {}, maxBytes: 16384, timeoutMs: 5000 })
    if (result.code !== 0)
      throw new Error('SERVICE_PROCESS_UNVERIFIABLE')
    const [target] = z.array(z.object({ pid: z.number(), executable: z.string(), instanceId: z.string() })).max(1).parse(JSON.parse(result.stdout.toString('utf8')))
    if (target?.pid !== pid)
      throw new Error('SERVICE_PROCESS_CHANGED')
    return serviceProcessIdentitySchema.parse({ pid, executable: await realpath(target.executable), startIdentity: target.instanceId })
  }
  throw new Error('SERVICE_PROCESS_UNVERIFIABLE')
}

export async function waitForServiceProcessExit(identity: z.infer<typeof serviceProcessIdentitySchema>, helper?: string, timeoutMs = 45000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const current = await readServiceProcessIdentity(identity.pid, helper).catch((error) => {
      if (['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '') || (error as Error).message === 'SERVICE_PROCESS_CHANGED')
        return null
      throw error
    })
    if (!current || current.startIdentity !== identity.startIdentity)
      return
    await delay(100)
  }
  throw new Error('SERVICE_STOP_UNCONFIRMED')
}
