import type { ToolCallEvent, ToolCallEventResult } from '@earendil-works/pi-coding-agent'
import type { PermissionGrant, PermissionRequest } from '../permissionContract'
import { execFile } from 'node:child_process'
import { access, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { createToolPolicyExtension } from '../../agent/extensions/toolPolicyExtension'
import { PermissionEngine } from '../PermissionEngine'
import { createSensitivePathMatcher } from '../sensitivePaths'
import { ToolAuthorizationService } from '../ToolAuthorizationService'

const roots: string[] = []
const executeFile = promisify(execFile)

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true })))
})

describe.skipIf(process.platform === 'win32')('shell file deletion permissions', () => {
  it('allows literal ordinary files only in workspace and granted directories', async () => {
    const fixture = await createFixture()
    for (const command of ['rm obsolete.vue', 'rm -f -- obsolete.vue', 'rm "file with spaces"', `rm "${fixture.granted}/obsolete.vue"`]) {
      await expect(fixture.engine.decide(request(fixture, command))).resolves.toEqual({ type: 'allow' })
    }
    await expect(fixture.engine.decide(request(fixture, 'rm obsolete.vue', { approvalAvailable: false }))).resolves.toEqual({ type: 'allow' })
    await expect(fixture.engine.decide(request(fixture, 'rm obsolete.vue', { profile: 'full_access' }))).resolves.toEqual({ type: 'allow' })
    await expect(fixture.engine.decide(request(fixture, 'rm obsolete.vue', { profile: 'full_access', toolName: 'lexora_host_shell' }))).resolves.toEqual({ type: 'allow' })
    await expect(readFile(join(fixture.workspace, 'obsolete.vue'), 'utf8')).resolves.toBe('fixture')
  })

  it('preserves read-only, manual, forced and background approval semantics', async () => {
    const fixture = await createFixture()
    await expect(fixture.engine.decide(request(fixture, 'rm obsolete.vue', { profile: 'read_only' }))).resolves.toEqual({
      code: 'READ_ONLY_PROFILE',
      source: 'profile',
      type: 'deny',
    })
    await expect(fixture.engine.decide(request(fixture, 'rm obsolete.vue', { approvalPolicy: 'manual' }))).resolves.toMatchObject({
      kind: 'delete',
      paths: [{ path: join(fixture.workspace, 'obsolete.vue'), zone: 'workspace' }],
      type: 'ask',
    })
    await expect(fixture.engine.decide(request(fixture, 'rm obsolete.vue', { forceAsk: true }))).resolves.toMatchObject({
      kind: 'delete',
      type: 'ask',
    })
    await expect(fixture.engine.decide(request(fixture, 'rm obsolete.vue', { approvalAvailable: false, approvalPolicy: 'manual' }))).resolves.toMatchObject({
      code: 'APPROVAL_UNAVAILABLE_IN_BACKGROUND',
      type: 'deny',
    })
  })

  it('reviews every external target and proposes only its direct directory', async () => {
    const fixture = await createFixture()
    const path = join(fixture.outside, 'obsolete.vue')
    const command = `rm obsolete.vue "${path}"`
    await expect(fixture.engine.decide(request(fixture, command))).resolves.toMatchObject({
      grant: { owner: { id: 'space-1', kind: 'space' }, root: fixture.outside },
      kind: 'delete',
      paths: [
        { path: join(fixture.workspace, 'obsolete.vue'), zone: 'workspace' },
        { path, zone: 'outside' },
      ],
      type: 'ask',
    })
    await expect(fixture.engine.decide(request(fixture, command, { approvalAvailable: false }))).resolves.toMatchObject({
      code: 'APPROVAL_UNAVAILABLE_IN_BACKGROUND',
      type: 'deny',
    })
    await expect(fixture.engine.decide(request(fixture, `rm "${path}" "${fixture.home}/obsolete.vue"`))).resolves.toMatchObject({
      code: 'MULTIPLE_DIRECTORY_GRANTS_REQUIRED',
      type: 'deny',
    })
  })

  it('uses canonical boundaries and does not confuse workspace siblings with authorized paths', async () => {
    const fixture = await createFixture()
    await symlink(fixture.outside, join(fixture.workspace, 'external'), 'junction')
    await symlink(join(fixture.outside, 'obsolete.vue'), join(fixture.workspace, 'link.vue'))
    for (const command of ['rm external/obsolete.vue', 'rm link.vue']) {
      await expect(fixture.engine.decide(request(fixture, command))).resolves.toMatchObject({
        grant: { root: fixture.outside },
        kind: 'delete',
        paths: [{ zone: 'outside' }],
        type: 'ask',
      })
    }
    const sibling = `${fixture.workspace}-other`
    await mkdir(sibling)
    await writeFile(join(sibling, 'file'), 'fixture')
    await expect(fixture.engine.decide(request(fixture, `rm "${sibling}/file"`))).resolves.toMatchObject({
      grant: { root: sibling },
      type: 'ask',
    })
    await expect(fixture.engine.decide(request(fixture, 'rm external/../obsolete.vue'))).resolves.toMatchObject({
      kind: 'shell',
      type: 'ask',
    })
  })

  it('denies sensitive names and canonical sensitive targets even in full access', async () => {
    const fixture = await createFixture()
    await writeFile(join(fixture.workspace, '.env'), 'SYNTHETIC=fixture')
    await symlink(join(fixture.workspace, '.env'), join(fixture.workspace, 'public.vue'))
    for (const profile of ['read_only', 'workspace_write', 'full_access'] as const) {
      for (const command of ['rm .env', 'rm public.vue', 'rm obsolete.vue .env']) {
        await expect(fixture.engine.decide(request(fixture, command, { profile }))).resolves.toEqual({
          code: 'SENSITIVE_PATH',
          source: 'sensitive',
          type: 'deny',
        })
      }
    }
    for (const command of ['rm .env', 'rm public.vue', 'rm obsolete.vue .env']) {
      await expect(fixture.engine.decide(request(fixture, command, { profile: 'full_access', toolName: 'lexora_host_shell' }))).resolves.toEqual({
        code: 'SENSITIVE_PATH',
        source: 'sensitive',
        type: 'deny',
      })
    }
  })

  it('keeps directories, root targets, Git metadata and unbounded commands behind review', async () => {
    const fixture = await createFixture()
    await mkdir(join(fixture.workspace, '.git'))
    await writeFile(join(fixture.workspace, '.git', 'config'), 'fixture')
    await symlink(join(fixture.workspace, '.git', 'config'), join(fixture.workspace, 'git-config'))
    for (const command of ['rm .', 'rm .git', 'rm .git/config', 'rm git-config', `rm "${fixture.granted}"`]) {
      await expect(fixture.engine.decide(request(fixture, command)), command).resolves.toMatchObject({ kind: 'delete', type: 'ask' })
      await expect(fixture.engine.decide(request(fixture, command, { profile: 'read_only' }))).resolves.toMatchObject({
        code: 'READ_ONLY_PROFILE',
        type: 'deny',
      })
    }
    await writeFile(join(fixture.granted, '.git'), 'gitdir: fixture')
    await expect(fixture.engine.decide(request(fixture, `rm "${fixture.granted}/.git"`))).resolves.toMatchObject({ type: 'ask' })
    for (const command of ['rm -rf .', 'rm *.vue', 'rm "$TARGET"', 'rm obsolete.vue && pwd']) {
      await expect(fixture.engine.decide(request(fixture, command))).resolves.toMatchObject({ kind: 'shell', type: 'ask' })
      await expect(fixture.engine.decide(request(fixture, command, { profile: 'read_only' }))).resolves.toMatchObject({
        code: 'READ_ONLY_PROFILE',
        type: 'deny',
      })
    }
  })

  it('does not assume missing or dangling targets are verified ordinary files', async () => {
    const fixture = await createFixture()
    await symlink(join(fixture.outside, 'missing'), join(fixture.workspace, 'dangling'))
    for (const command of ['rm missing', 'rm -f missing', 'rm dangling']) {
      await expect(fixture.engine.decide(request(fixture, command))).resolves.toMatchObject({ code: 'PATH_NOT_FOUND', type: 'deny' })
    }
  })

  it('checks the same literal filename that Bash removes when double quotes contain a backslash', async () => {
    const fixture = await createFixture()
    const name = String.raw`folder\name.txt`
    await writeFile(join(fixture.workspace, name), 'literal')
    await writeFile(join(fixture.workspace, 'foldername.txt'), 'keep')
    const command = String.raw`rm "folder\name.txt"`
    await expect(fixture.engine.decide(request(fixture, command))).resolves.toEqual({ type: 'allow' })
    await executeFile('bash', ['--noprofile', '--norc', '-c', command], { cwd: fixture.workspace, env: { PATH: process.env.PATH, BASH_ENV: '' } })
    await expect(access(join(fixture.workspace, name))).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(join(fixture.workspace, 'foldername.txt'), 'utf8')).resolves.toBe('keep')
  })

  it.each(['denied', 'approved_once', 'approved_for_turn', 'grant_failure'] as const)('applies the %s approval outcome before a real deletion', async (outcome) => {
    const fixture = await createFixture()
    const target = join(fixture.outside, 'obsolete.vue')
    const command = `rm "${target}"`
    let handler!: (event: ToolCallEvent) => Promise<ToolCallEventResult | void>
    const extension = createToolPolicyExtension({
      authorization: new ToolAuthorizationService({
        approvalAvailable: true,
        approvalPolicy: 'policy',
        approvalService: {
          request: async (input) => {
            expect(input.kind).toBe('delete')
            expect(input.paths).toEqual({
              access: 'delete',
              grant: { owner: 'space', root: fixture.outside },
              targets: [{ path: target, zone: 'outside' }],
            })
            await expect(readFile(target, 'utf8')).resolves.toBe('fixture')
            return { approvalId: 'approval-1', decision: outcome === 'grant_failure' ? 'approved_once' : outcome }
          },
        },
        applyGrant: async (grant) => {
          if (outcome === 'grant_failure')
            throw new Error('fixture grant failure')
          fixture.grants.push({ canonicalRoot: grant.root, grantId: 'external-1', kind: 'granted', root: grant.root })
        },
        cwd: fixture.workspace,
        engine: fixture.engine,
        executionProfile: 'workspace_write',
        getGrants: () => fixture.grants,
        owner: { id: 'space-1', kind: 'space' },
      }),
      getRunContext: () => ({
        flushProjectedEvents: async () => {},
        onToolExecutionAuthorized: async () => {},
        runId: 'run-1',
        signal: new AbortController().signal,
      }),
    })
    extension.factory({
      on: (_name: string, callback: typeof handler) => {
        handler = callback
      },
    } as never)
    const result = await handler({ input: { command }, toolCallId: 'tool-1', toolName: 'bash', type: 'tool_call' })
    if (outcome === 'denied' || outcome === 'grant_failure') {
      expect(result).toMatchObject({ block: true, reason: outcome === 'denied' ? 'APPROVAL_DENIED' : 'DIRECTORY_GRANT_FAILED' })
      await expect(readFile(target, 'utf8')).resolves.toBe('fixture')
    }
    else {
      expect(result).toBeUndefined()
      await executeFile('bash', ['--noprofile', '--norc', '-c', command], { cwd: fixture.workspace, env: { PATH: process.env.PATH, BASH_ENV: '' } })
      await expect(access(target)).rejects.toMatchObject({ code: 'ENOENT' })
      await writeFile(target, 'restored fixture')
      await expect(fixture.engine.decide(request(fixture, command))).resolves.toMatchObject({ type: outcome === 'approved_once' ? 'allow' : 'ask' })
    }
  })
})

async function createFixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'lexora-delete-')))
  roots.push(root)
  const home = join(root, 'home')
  const workspace = join(root, 'workspace')
  const granted = join(root, 'granted')
  const outside = join(root, 'outside')
  for (const directory of [home, workspace, granted, outside]) {
    await mkdir(directory)
    await writeFile(join(directory, 'obsolete.vue'), 'fixture')
  }
  await writeFile(join(workspace, 'file with spaces'), 'fixture')
  const grants: PermissionGrant[] = [
    { canonicalRoot: workspace, grantId: 'workspace-1', kind: 'workspace', root: workspace },
    { canonicalRoot: granted, grantId: 'granted-1', kind: 'granted', root: granted },
  ]
  const engine = new PermissionEngine({ platform: 'linux', sensitive: createSensitivePathMatcher({ home }) })
  return { engine, granted, grants, home, outside, workspace }
}

function request(fixture: Awaited<ReturnType<typeof createFixture>>, command: string, overrides: Partial<PermissionRequest> = {}): PermissionRequest {
  return {
    approvalAvailable: true,
    approvalPolicy: 'policy',
    arguments: { command },
    cwd: fixture.workspace,
    grants: fixture.grants,
    owner: { id: 'space-1', kind: 'space' },
    profile: 'workspace_write',
    toolName: 'bash',
    ...overrides,
  }
}
