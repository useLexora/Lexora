import type { ToolDefinition } from '@earendil-works/pi-coding-agent'
import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { setTimeout } from 'node:timers/promises'
import { describe, expect, it } from 'vitest'
import { MutationCoordinator } from '../../changes/MutationCoordinator'
import { createMutationRepository } from '../../changes/mutationRepository'
import { ToolAuthorizationService } from '../../permissions/ToolAuthorizationService'
import { openBuddyDatabase } from '../../storage/database'
import { SandboxDirectoryPermissions } from '../SandboxDirectoryPermissions'
import { createShellCapability } from '../shellCapability'
import { resolveShellExecution } from '../shellExecution'

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), 'lexora-owned-shell-'))
  const database = openBuddyDatabase({ databasePath: ':memory:' })
  const repository = createMutationRepository(database)
  const mutations = new MutationCoordinator({ repository })
  const controller = new AbortController()
  const lease = await mutations.acquire({ lifetime: 'external' as const, runId: 'owner', invocationId: 'invocation', claims: [{ kind: 'host' }], signal: controller.signal })
  const run = { runId: 'owner', signal: controller.signal, flushProjectedEvents: async () => {}, onToolExecutionAuthorized: async () => {} }
  const tools = new Map<string, ToolDefinition>()
  const capability = createShellCapability({
    cwd: directory,
    execution: resolveShellExecution('full_access', 'linux'),
    getGrants: () => [],
    getRunContext: () => run,
    mutations,
    sandbox: undefined,
    directoryPermissions: new SandboxDirectoryPermissions(),
    authorization: new ToolAuthorizationService({
      approvalService: { request: async () => { throw new Error('Unexpected approval') } },
      approvalAvailable: false,
      approvalPolicy: 'policy',
      executionProfile: 'full_access',
      cwd: directory,
      owner: { kind: 'conversation', id: 'conversation' },
      getGrants: () => [],
    }),
  })
  await capability.extension!.factory({ registerTool: (tool: ToolDefinition) => {
    tools.set(tool.name, tool)
  } } as unknown as Parameters<typeof capability.extension.factory>[0])
  const invokeWithoutContext = (command: string) => tools.get('bash')!.execute('shell-call', { command }, controller.signal, undefined, undefined!)
  const invoke = (command: string) => mutations.withInvocation(lease, () => invokeWithoutContext(command))
  const processes = () => database.prepare('SELECT process_id, settlement FROM run_mutation_processes').all() as { process_id: string, settlement: string }[]
  return { database, directory, repository, mutations, controller, lease, invoke, invokeWithoutContext, processes, async dispose() {
    await mutations.dispose()
    database.close()
    await rm(directory, { recursive: true, force: true })
  } }
}

describe.skipIf(process.platform !== 'linux')('real shell process ownership', () => {
  it('persists a released process identity only after detached grandchildren have exited', async () => {
    const f = await fixture()
    try {
      await f.invoke('setsid /bin/sh -c \'sleep 60 >/dev/null 2>&1 & echo $!\' & wait')
      expect(f.processes()).toHaveLength(2)
      expect(f.processes().every(record => record.settlement === 'released')).toBe(true)
      const identity = f.processes().map(record => JSON.parse(record.process_id)).find(identity => identity.kind === 'native-shell')
      expect(identity).toMatchObject({ kind: 'native-shell', platform: 'linux', startTime: expect.any(String), bootId: expect.any(String) })
      await expect(access(`/proc/${identity.pid}`)).rejects.toThrow()
      expect(f.mutations.getInvocationSettlement('invocation')).toBe('released')
      f.lease.release()
      expect(new MutationCoordinator({ repository: f.repository }).getRunState('owner').hazards).toEqual([])
    }
    finally { await f.dispose() }
  })

  it('blocks the actual command when pending ownership cannot be persisted', async () => {
    const f = await fixture()
    try {
      f.database.exec(`CREATE TRIGGER deny_pending BEFORE INSERT ON run_mutation_processes WHEN NEW.settlement = 'pending' BEGIN SELECT RAISE(ABORT, 'fixture persistence failure'); END`)
      await expect(f.invoke('touch forbidden-start')).rejects.toThrow()
      await expect(access(join(f.directory, 'forbidden-start'))).rejects.toThrow()
      expect(f.processes().every(record => record.settlement === 'released')).toBe(true)
    }
    finally { await f.dispose() }
  })

  it('keeps a durable hazard when the supervisor dies without a tree exit receipt', async () => {
    const f = await fixture()
    const pids: number[] = []
    try {
      const pending = f.invoke('sleep 60 & printf "%s %s" "$$" "$!" > child-pids; wait')
      const rejected = expect(pending).rejects.toThrow('SHELL_SUPERVISION_FAILED')
      for (let attempt = 0; attempt < 200; attempt++) {
        try {
          pids.push(...(await readFile(join(f.directory, 'child-pids'), 'utf8')).trim().split(' ').map(Number))
          break
        }
        catch { await setTimeout(5) }
      }
      expect(pids).toHaveLength(2)
      const identity = f.processes().map(record => JSON.parse(record.process_id)).find(identity => identity.kind === 'native-shell')
      process.kill(identity.pid, 'SIGKILL')
      await rejected
      expect(f.processes()[0]?.settlement).toBe('unknown')
      f.lease.markHazard('SHELL_PROCESS_TREE_UNKNOWN')
      const restored = new MutationCoordinator({ repository: f.repository })
      expect(restored.getRunState('owner').hazards).toMatchObject([{ invocationId: 'invocation', reason: 'SHELL_PROCESS_TREE_UNKNOWN' }])
      await expect(restored.acquire({ lifetime: 'external' as const, runId: 'other', invocationId: 'other-call', claims: [{ kind: 'host' }], signal: new AbortController().signal })).rejects.toThrow('MUTATION_RESOURCE_UNSAFE')
    }
    finally {
      for (const pid of pids) {
        try {
          process.kill(pid, 'SIGKILL')
        }
        catch {}
      }
      await f.dispose()
    }
  })

  it('does not launch an untracked command when a production mutation coordinator is present', async () => {
    const f = await fixture()
    try {
      await expect(f.invokeWithoutContext('touch untracked-start')).rejects.toThrow('SHELL_INVOCATION_REQUIRED')
      await expect(access(join(f.directory, 'untracked-start'))).rejects.toThrow()
      expect(f.processes()).toEqual([])
    }
    finally { await f.dispose() }
  })

  it('does not launch a command for an invocation whose lease has already ended', async () => {
    const f = await fixture()
    try {
      f.lease.release()
      await expect(f.invoke('touch expired-start')).rejects.toThrow('SHELL_INVOCATION_EXPIRED')
      await expect(access(join(f.directory, 'expired-start'))).rejects.toThrow()
      expect(f.processes()).toEqual([])
    }
    finally { await f.dispose() }
  })
})
