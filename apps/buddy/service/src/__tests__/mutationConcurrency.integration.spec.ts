import type { ServerResponse } from 'node:http'
import type { ConcurrencyRuntime, Role } from './mutationConcurrencyFixture'
import { readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join } from 'node:path'
import process from 'node:process'
import { describe, expect, it, vi } from 'vitest'
import { resolveBuddyPlatform } from '../../../shared/platform'
import { MutationCoordinator } from '../changes/MutationCoordinator'
import {
  assertCaptureChain,
  assertDurableTree,
  captures,
  createConcurrencyRuntime,
  deferred,
  hash,
  mutationTiming,
  roles,
  tool,
  treeByRole,
} from './mutationConcurrencyFixture'

function eventPayload(event: ConcurrencyRuntime['events'][number]) {
  return event.payload as { toolCallId?: string, toolName?: string, isError?: boolean }
}

async function assertToolOverlap(f: ConcurrencyRuntime, ids: string[]) {
  await expect.poll(() => f.events.filter(event => event.type === 'tool.started' && ids.includes(eventPayload(event).toolCallId ?? '')).length, { timeout: 15000 }).toBe(ids.length)
  expect(f.events.filter(event => event.type === 'tool.completed' && ids.includes(eventPayload(event).toolCallId ?? ''))).toEqual([])
  expect(new Set(f.events.filter(event => event.type === 'tool.started' && ids.includes(eventPayload(event).toolCallId ?? '')).map(event => event.runId)).size).toBe(ids.length)
}

function shellCommand(script: string, ...args: string[]) {
  const quote = (value: string) => process.platform === 'win32' ? `'${value.replaceAll('\'', '\'\'')}'` : `'${value.replaceAll('\'', '\'\\\'\'')}'`
  return `${process.platform === 'win32' ? '& ' : ''}${[process.execPath, script, ...args].map(quote).join(' ')}`
}

function toolResults(f: ConcurrencyRuntime, ids: string[]) {
  return f.events.filter(event => event.type === 'tool.completed' && ids.includes(eventPayload(event).toolCallId ?? ''))
}

describe('real Runtime multi-agent mutation concurrency', () => {
  it('preserves root/actor/repeated-NPC ownership for concurrent files and serializes non-overlapping edits', async () => {
    let workspace = ''
    const f = await createConcurrencyRuntime({
      steps: role => [
        tool(`${role}-write`, 'write', { path: join(workspace, `${role}.txt`), content: `owned:${role}\n` }),
        tool(`${role}-edit`, 'edit', { path: join(workspace, 'shared.txt'), edits: [{ oldText: `${role}=before`, newText: `${role}=after` }] }),
      ],
    })
    const timing = mutationTiming()
    try {
      workspace = f.workspace
      const before = roles.map(role => `${role}=before\n`).join('')
      const after = roles.map(role => `${role}=after\n`).join('')
      const shared = join(workspace, 'shared.txt')
      await writeFile(shared, before)
      const differentFiles = timing.gate(input => input.claims.some(claim => claim.kind === 'file' && claim.canonicalPath !== shared))
      const sharedFile = timing.gate(input => input.claims.some(claim => claim.kind === 'file' && claim.canonicalPath === shared))
      f.start()
      await differentFiles.waitFor(4, 0)
      const live = treeByRole(f)
      expect(Object.values(live).every(run => run.status === 'running')).toBe(true)
      await assertToolOverlap(f, roles.map(role => `${role}-write`))
      differentFiles.release()
      await sharedFile.waitFor(1, 3)
      await assertToolOverlap(f, roles.map(role => `${role}-edit`))
      expect(await readFile(shared, 'utf8')).toBe(before)
      sharedFile.release()
      await f.complete()
      const tree = await assertDurableTree(f)
      expect(await readFile(shared, 'utf8')).toBe(after)
      const ledger = captures(f)
      expect(ledger).toHaveLength(8)
      for (const role of roles) {
        expect(await readFile(join(workspace, `${role}.txt`), 'utf8')).toBe(`owned:${role}\n`)
        const owned = ledger.filter(capture => capture.invocation?.runId === tree[role].id)
        expect(owned).toHaveLength(2)
        expect(owned.map(capture => capture.toolCallId).sort()).toEqual([`${role}-edit`, `${role}-write`])
        expect(owned.every(capture => capture.actorId === tree[role].buddyId && capture.toolReportedError === false)).toBe(true)
      }
      const chain = await assertCaptureChain(f, shared, before, after, 4)
      expect(new Set(chain.map(capture => capture.invocation!.segmentId)).size).toBe(4)
      expect(toolResults(f, roles.flatMap(role => [`${role}-write`, `${role}-edit`])).map(event => eventPayload(event).isError)).toEqual(Array.from({ length: 8 }).fill(false))
    }
    finally {
      timing.dispose()
      await f.dispose()
    }
  }, 60000)

  it('rejects one stale exact edit without overwriting the winning sibling', async () => {
    let path = ''
    const f = await createConcurrencyRuntime({
      steps: role => role.startsWith('npc-')
        ? [
            tool(`${role}-read`, 'read', { path }),
            tool(`${role}-race`, 'edit', { path, edits: [{ oldText: 'value=original', newText: `value=${role}` }] }),
          ]
        : [],
    })
    const timing = mutationTiming()
    try {
      path = join(f.workspace, 'conflict.txt')
      const original = 'value=original\n'
      await writeFile(path, original)
      const race = timing.gate(input => input.claims.some(claim => claim.kind === 'file' && claim.canonicalPath === path))
      f.start()
      await race.waitFor(1, 1)
      await assertToolOverlap(f, ['npc-a-race', 'npc-b-race'])
      expect(toolResults(f, ['npc-a-read', 'npc-b-read'])).toHaveLength(2)
      for (const role of ['npc-a', 'npc-b'] as const) {
        const continuation = f.requests.find(request => request.role === role && JSON.stringify(request.payload.messages).includes('value=original'))
        expect(continuation, `${role} must actually read the original before racing`).toBeDefined()
      }
      race.release()
      await f.complete()
      const tree = await assertDurableTree(f)
      const results = toolResults(f, ['npc-a-race', 'npc-b-race'])
      expect(results).toHaveLength(2)
      expect(results.map(event => eventPayload(event).isError).sort()).toEqual([false, true])
      const winner = results.find(event => !eventPayload(event).isError)!
      const winnerRole = winner.runId === tree['npc-a'].id ? 'npc-a' : 'npc-b'
      const loserRole = winnerRole === 'npc-a' ? 'npc-b' : 'npc-a'
      const conflict = f.requests.filter(request => request.role === loserRole).at(-1)!.payload.messages.find(message => message.tool_call_id === `${loserRole}-race`)
      expect(conflict?.content).toContain('The old text must match exactly including all whitespace and newlines.')
      const final = `value=${winnerRole}\n`
      expect(await readFile(path, 'utf8')).toBe(final)
      const chain = await assertCaptureChain(f, path, original, final, 2)
      expect(chain[0]).toMatchObject({ toolReportedError: false, invocation: { runId: winner.runId } })
      expect(chain[1]).toMatchObject({ toolReportedError: true })
      expect(chain[1]!.before.hash).toBe(chain[1]!.after?.hash)
    }
    finally {
      timing.dispose()
      await f.dispose()
    }
  }, 60000)

  it('serializes two full writes as whole replacements, never as an automatic merge', async () => {
    let path = ''
    const versions: Partial<Record<Role, string>> = {
      'npc-a': `A-BEGIN\n${'alpha-only line\n'.repeat(2048)}A-END\n`,
      'npc-b': `B-BEGIN\n${'bravo-only line\n'.repeat(2048)}B-END\n`,
    }
    const f = await createConcurrencyRuntime({
      steps: role => role.startsWith('npc-') ? [tool(`${role}-replace`, 'write', { path, content: versions[role]! })] : [],
    })
    const timing = mutationTiming()
    try {
      path = join(f.workspace, 'replace.txt')
      const before = 'initial whole version\n'
      await writeFile(path, before)
      const race = timing.gate(input => input.claims.some(claim => claim.kind === 'file' && claim.canonicalPath === path))
      f.start()
      await race.waitFor(1, 1)
      await assertToolOverlap(f, ['npc-a-replace', 'npc-b-replace'])
      race.release()
      await f.complete()
      await assertDurableTree(f)
      const final = await readFile(path, 'utf8')
      expect(Object.values(versions)).toContain(final)
      const chain = await assertCaptureChain(f, path, before, final, 2)
      expect(chain.every(capture => !capture.toolReportedError)).toBe(true)
      expect(new Set(chain.map(capture => capture.after?.hash))).toEqual(new Set(Object.values(versions).map(hash)))
      expect(chain[1]!.after?.hash).toBe(hash(final))
      expect(toolResults(f, ['npc-a-replace', 'npc-b-replace']).map(event => eventPayload(event).isError)).toEqual([false, false])
    }
    finally {
      timing.dispose()
      await f.dispose()
    }
  }, 60000)

  it('propagates an ancestor read_only ceiling through actor and repeated NPC descendants', async () => {
    let path = ''
    const f = await createConcurrencyRuntime({
      readOnly: true,
      steps: role => [tool(`${role}-forbidden`, 'write', { path, content: `forbidden:${role}` })],
    })
    try {
      path = join(f.workspace, 'protected.txt')
      await writeFile(path, 'untouched\n')
      f.start()
      await f.complete()
      const tree = await assertDurableTree(f)
      expect(await readFile(path, 'utf8')).toBe('untouched\n')
      for (const role of roles) {
        expect(tree[role].executionProfile).toBe(role === 'root' ? 'workspace_write' : 'read_only')
        expect(f.database.prepare('SELECT file_access_ceiling FROM execution_state WHERE run_id = ?').get(tree[role].id)?.file_access_ceiling).toBe('read_only')
        if (role !== 'root')
          expect(tree[role].actorSnapshot?.settings.limits.fileAccess).toBe('inherit')
        const payloads = f.requests.filter(request => request.role === role).map(request => request.payload)
        expect(payloads.length).toBeGreaterThanOrEqual(2)
        expect(payloads.every(payload => !payload.tools?.some(tool => tool.function.name === 'write'))).toBe(true)
        expect(JSON.stringify(payloads.at(-1)?.messages)).toContain('Tool write not found')
      }
      expect(f.database.prepare('SELECT COUNT(*) AS count FROM run_mutation_leases').get()?.count).toBe(0)
      expect(captures(f)).toEqual([])
    }
    finally {
      await f.dispose()
    }
  }, 60000)

  it.skipIf(!resolveBuddyPlatform(process.platform).hostShellSupervision)('recovers a lost native settlement from real receipts without replaying the command before a child writes', async () => {
    let command = ''
    let path = ''
    let lostInvocation: string | undefined
    const original = MutationCoordinator.prototype.recordOwnedProcessSettlement
    const failure = vi.spyOn(MutationCoordinator.prototype, 'recordOwnedProcessSettlement').mockImplementation(function (this: MutationCoordinator, input) {
      if (!lostInvocation && input.launchState === 'settled') {
        lostInvocation = input.invocationId
        throw new Error('INJECTED_RELEASE_NOTIFICATION_LOST')
      }
      return original.call(this, input)
    })
    let f: ConcurrencyRuntime | undefined
    try {
      f = await createConcurrencyRuntime({
        fullAccess: true,
        steps: (role) => {
          if (role === 'root')
            return [tool('lost-settlement-shell', process.platform === 'win32' ? 'powershell' : 'bash', { command, timeout: 40 })]
          if (role === 'npc-a')
            return [tool('write-after-recovery', 'write', { path, content: 'native write after recovery\n' })]
          return []
        },
      })
      const runtime = f
      path = join(f.workspace, 'after-recovery.txt')
      const marker = join(f.workspace, 'effects.log')
      const script = join(f.workspace, 'single-effect.cjs')
      await writeFile(script, 'require(\'node:fs\').appendFileSync(process.argv[2], \'old-effect\\n\');\n')
      command = shellCommand(script, marker)
      const writer = f.holdReply('write-after-recovery')
      f.start()
      await expect.poll(() => toolResults(runtime, ['lost-settlement-shell']).length, { timeout: 15000 }).toBe(1)
      expect(toolResults(f, ['lost-settlement-shell'])[0]).toMatchObject({ payload: { isError: true } })
      expect(lostInvocation).toBeDefined()
      expect(await readFile(marker, 'utf8')).toBe('old-effect\n')
      writer.resolve()
      await f.complete()
      const tree = await assertDurableTree(f)
      expect(await readFile(path, 'utf8')).toBe('native write after recovery\n')
      expect(await readFile(marker, 'utf8')).toBe('old-effect\n')
      const evidence = f.database.prepare('SELECT kind, outcome, reason, actor FROM run_mutation_evidence WHERE invocation_id = ?').all(lostInvocation!)
      expect(evidence).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'quiesced', outcome: 'applied', reason: 'supervisor_receipt', actor: 'system' })]))
      expect(f.database.prepare('SELECT status FROM run_mutation_leases WHERE invocation_id = ?').get(lostInvocation!)?.status).toBe('released')
      const processes = f.database.prepare('SELECT settlement FROM run_mutation_processes WHERE invocation_id = ?').all(lostInvocation!)
      expect(processes.length).toBeGreaterThan(0)
      expect(processes.every(process => process.settlement === 'released')).toBe(true)
      expect(f.events.filter(event => event.type === 'tool.started' && eventPayload(event).toolCallId === 'lost-settlement-shell')).toHaveLength(1)
      expect(toolResults(f, ['write-after-recovery'])).toMatchObject([{ runId: tree['npc-a'].id, payload: { isError: false } }])
      expect(f.database.prepare('SELECT tool_call_id, status FROM run_change_invocations WHERE run_id = ?').all(tree['npc-a'].id)).toEqual([expect.objectContaining({ tool_call_id: 'write-after-recovery', status: 'completed' })])
    }
    finally {
      failure.mockRestore()
      await f?.dispose()
    }
  }, 60000)

  it.skipIf(!resolveBuddyPlatform(process.platform).hostShellSupervision)('cancels a queued child behind a real supervised full_access shell and admits a fresh write after release', async () => {
    const shellReached = deferred()
    let shellResponse: ServerResponse | undefined
    const server = createServer((_request, response) => {
      shellResponse = response
      shellReached.resolve()
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const address = server.address()
    if (!address || typeof address === 'string')
      throw new Error('Shell barrier did not bind TCP')
    let command = ''
    let cancelledPath = ''
    let freshPath = ''
    const timing = mutationTiming()
    let f: ConcurrencyRuntime | undefined
    try {
      f = await createConcurrencyRuntime({
        fullAccess: true,
        steps: (role) => {
          if (role === 'root')
            return [tool('root-supervised-shell', process.platform === 'win32' ? 'powershell' : 'bash', { command, timeout: 40 })]
          if (role === 'npc-a')
            return [tool('cancelled-write', 'write', { path: cancelledPath, content: 'MUST NOT WRITE\n' })]
          if (role === 'npc-b')
            return [tool('fresh-write', 'write', { path: freshPath, content: 'after supervised release\n' })]
          return []
        },
      })
      const runtime = f
      cancelledPath = join(f.workspace, 'cancelled.txt')
      freshPath = join(f.workspace, 'fresh.txt')
      await writeFile(cancelledPath, 'preserved\n')
      const script = join(f.workspace, 'hold-shell.cjs')
      await writeFile(script, 'require(\'node:http\').get(process.argv[2], response => { response.resume(); response.on(\'end\', () => process.stdout.write(\'SHELL_RELEASED\')); }).on(\'error\', error => { console.error(error); process.exitCode = 1; });\n')
      command = shellCommand(script, `http://127.0.0.1:${address.port}/hold`)
      const cancelledReply = f.holdReply('cancelled-write')
      const freshReply = f.holdReply('fresh-write')
      const queued = timing.gate(input => input.claims.some(claim => claim.kind === 'file' && claim.canonicalPath === cancelledPath))
      f.start()
      await expect.poll(() => Boolean(shellResponse), { timeout: 15000 }).toBe(true)
      await shellReached.promise
      const tree = treeByRole(f)
      const active = f.database.prepare('SELECT invocation_id, claims_json FROM run_mutation_leases WHERE run_id = ? AND status = \'active\'').get(tree.root.id)!
      expect(JSON.parse(String(active.claims_json))).toEqual([{ kind: 'host' }])
      const processes = f.database.prepare('SELECT process_id, settlement FROM run_mutation_processes WHERE invocation_id = ? ORDER BY process_id').all(active.invocation_id!)
      expect(processes.length).toBeGreaterThan(0)
      expect(processes.every(process => process.settlement === 'pending')).toBe(true)
      cancelledReply.resolve()
      await queued.waitFor(0, 1)
      await assertToolOverlap(f, ['cancelled-write'])
      expect(await readFile(cancelledPath, 'utf8')).toBe('preserved\n')
      expect(await f.invoke('executions.cancel', {
        conversationId: f.turn.conversationId,
        branchId: f.turn.branchId,
        rootRunId: f.turn.runId,
        runId: tree['npc-a'].id,
      })).toEqual({ cancelled: true })
      await expect.poll(() => runtime.runs.findById(tree['npc-a'].id)?.status, { timeout: 15000 }).toBe('cancelled')
      expect(queued.admissions[0]!.coordinator.getRunState(tree['npc-a'].id)).toMatchObject({ pending: 0, active: 0, hazards: [] })
      expect(f.database.prepare('SELECT COUNT(*) AS count FROM run_mutation_leases WHERE run_id = ?').get(tree['npc-a'].id)?.count).toBe(0)
      expect(await readFile(cancelledPath, 'utf8')).toBe('preserved\n')
      shellResponse!.end('release')
      await expect.poll(() => runtime.database.prepare('SELECT status FROM run_mutation_leases WHERE invocation_id = ?').get(active.invocation_id!)?.status, { timeout: 15000 }).toBe('released')
      expect(f.database.prepare('SELECT process_id, settlement FROM run_mutation_processes WHERE invocation_id = ? ORDER BY process_id').all(active.invocation_id!)).toEqual(processes.map(process => ({ ...process, settlement: 'released' })))
      freshReply.resolve()
      await f.complete()
      await assertDurableTree(f, ['npc-a'])
      expect(await readFile(freshPath, 'utf8')).toBe('after supervised release\n')
      expect(await readFile(cancelledPath, 'utf8')).toBe('preserved\n')
      expect(toolResults(f, ['root-supervised-shell', 'fresh-write']).map(event => eventPayload(event).isError)).toEqual([false, false])
      expect(f.database.prepare('SELECT status FROM run_change_invocations WHERE run_id = ?').get(tree.root.id)?.status).toBe('partial')
      expect(f.database.prepare('SELECT COUNT(*) AS count FROM run_change_invocations WHERE run_id = ?').get(tree['npc-a'].id)?.count).toBe(0)
    }
    finally {
      shellResponse?.end('cleanup')
      timing.dispose()
      await f?.dispose()
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    }
  }, 60000)
})
