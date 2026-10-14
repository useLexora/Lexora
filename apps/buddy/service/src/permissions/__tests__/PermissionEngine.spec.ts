import type { PermissionGrant, PermissionRequest } from '../permissionContract'
import { execFile } from 'node:child_process'
import { access, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { PermissionEngine } from '../PermissionEngine'
import { createSensitivePathMatcher } from '../sensitivePaths'

const roots: string[] = []
const executeFile = promisify(execFile)

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { force: true, recursive: true })))
})

describe('permissionEngine', () => {
  it('allows verified Git queries across profiles and backgrounds, while preserving manual approval', async () => {
    const fixture = await createGitFixture()
    const engine = createEngine(fixture.home)
    for (const profile of ['read_only', 'workspace_write', 'full_access'] as const) {
      await expect(engine.decide(request(fixture, {
        approvalAvailable: false,
        arguments: { command: 'git status --short && git diff --check' },
        profile,
        toolName: 'bash',
      }))).resolves.toEqual({ type: 'allow' })
    }
    await expect(engine.decide(request(fixture, {
      approvalPolicy: 'manual',
      arguments: { command: 'git status --short && git diff --check' },
      toolName: 'bash',
    }))).resolves.toMatchObject({
      shell: { cwd: fixture.workspace, reason: 'manual-policy' },
      type: 'ask',
    })
    await expect(engine.decide(request(fixture, {
      arguments: { command: 'git status --short && git reset --hard' },
      toolName: 'bash',
    }))).resolves.toMatchObject({ shell: { reason: 'unsafe-arguments' }, type: 'ask' })
  })

  it('checks effective Git configuration on every query without executing configured programs', async () => {
    const fixture = await createGitFixture()
    const engine = createEngine(fixture.home)
    const query = request(fixture, { arguments: { command: 'git status --short' }, toolName: 'bash' })
    await expect(engine.decide(query)).resolves.toEqual({ type: 'allow' })

    const marker = join(fixture.workspace, 'must-not-exist')
    vi.stubEnv('GIT_CONFIG', join(fixture.home, '.gitconfig'))
    await expect(engine.decide(query)).resolves.toMatchObject({ shell: { reason: 'git-config-unavailable' }, type: 'ask' })
    vi.stubEnv('GIT_CONFIG', undefined)
    await executeFile('git', ['config', 'core.fsmonitor', `touch ${marker}`], { cwd: fixture.workspace })
    await expect(engine.decide(query)).resolves.toMatchObject({
      shell: { reason: 'git-external-program' },
      type: 'ask',
    })
    await expect(engine.decide({ ...query, profile: 'read_only' })).resolves.toMatchObject({ code: 'READ_ONLY_PROFILE', type: 'deny' })
    await expect(engine.decide({ ...query, approvalAvailable: false })).resolves.toMatchObject({ code: 'APPROVAL_UNAVAILABLE_IN_BACKGROUND', type: 'deny' })
    await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' })

    await executeFile('git', ['config', 'core.fsmonitor', 'false'], { cwd: fixture.workspace })
    await expect(engine.decide(query)).resolves.toEqual({ type: 'allow' })
    const includedConfig = join(fixture.home, 'included.gitconfig')
    await writeFile(includedConfig, '[diff "document"]\n\ttextconv = test-converter\n')
    await executeFile('git', ['config', 'include.path', includedConfig], { cwd: fixture.workspace })
    await expect(engine.decide(query)).resolves.toMatchObject({ shell: { reason: 'git-external-program' }, type: 'ask' })
    await writeFile(includedConfig, 'invalid config [')
    await expect(engine.decide(query)).resolves.toMatchObject({ shell: { reason: 'git-config-unavailable' }, type: 'ask' })
  })

  it('uses canonical sensitive-path checks for shell reads and explicit Git content diffs', async () => {
    const fixture = await createGitFixture()
    const engine = createEngine(fixture.home)
    await writeFile(join(fixture.workspace, 'package.json'), '{}')
    await writeFile(join(fixture.workspace, '.env'), 'TEST_SECRET=not-a-real-secret')
    await executeFile('git', ['add', '--', '.env', 'package.json'], { cwd: fixture.workspace })
    await symlink(join(fixture.workspace, '.env'), join(fixture.workspace, 'public.txt'))
    await expect(engine.decide(request(fixture, {
      arguments: { command: 'ls -la . && cat package.json && git diff -- package.json' },
      toolName: 'bash',
    }))).resolves.toEqual({ type: 'allow' })
    for (const command of ['cat .env', 'cat public.txt', 'git diff -- .env', 'git diff -- public.txt', 'cat .env | python transform.py']) {
      for (const profile of ['read_only', 'workspace_write', 'full_access'] as const) {
        await expect(engine.decide(request(fixture, {
          arguments: { command },
          profile,
          toolName: 'bash',
        })), command).resolves.toMatchObject({
          shell: { reason: 'sensitive-path' },
          type: 'ask',
        })
      }
      await expect(engine.decide(request(fixture, {
        arguments: { command },
        profile: 'full_access',
        toolName: 'lexora_host_shell',
      })), command).resolves.toMatchObject({ shell: { reason: 'sensitive-path' }, type: 'ask' })
    }
    for (const command of ['git diff --cached', 'git diff --cached --check', 'git diff --cached -- .']) {
      await expect(engine.decide(request(fixture, {
        arguments: { command },
        toolName: 'bash',
      })), command).resolves.toMatchObject({ shell: { reason: 'sensitive-path' }, type: 'ask' })
    }
    await expect(engine.decide(request(fixture, {
      arguments: { command: 'git diff --cached -- package.json' },
      toolName: 'bash',
    }))).resolves.toEqual({ type: 'allow' })
    const powershell = new PermissionEngine({ platform: 'win32', sensitive: createSensitivePathMatcher({ home: fixture.home }) })
    for (const toolName of ['powershell', 'lexora_host_shell']) {
      await expect(powershell.decide(request(fixture, {
        arguments: { command: 'git diff -- .env' },
        profile: 'full_access',
        toolName,
      }))).resolves.toMatchObject({ type: 'ask', shell: { reason: 'sensitive-path' } })
    }
  })

  it('keeps Git filters, index hooks, lazy fetching, and submodule execution behind approval', async () => {
    const fixture = await createGitFixture()
    const engine = createEngine(fixture.home)
    const query = request(fixture, { arguments: { command: 'git status --short' }, toolName: 'bash' })
    await executeFile('git', ['config', 'filter.example.clean', 'test-filter'], { cwd: fixture.workspace })
    await expect(engine.decide(query)).resolves.toMatchObject({ shell: { reason: 'git-external-program' }, type: 'ask' })
    await executeFile('git', ['config', '--unset', 'filter.example.clean'], { cwd: fixture.workspace })

    const hooks = join(fixture.workspace, '.custom-hooks')
    await mkdir(hooks)
    await executeFile('git', ['config', 'core.hooksPath', '.custom-hooks'], { cwd: fixture.workspace })
    await expect(engine.decide(query)).resolves.toEqual({ type: 'allow' })
    const hook = join(hooks, 'post-index-change')
    await writeFile(hook, 'exit 1\n')
    await expect(engine.decide(query)).resolves.toMatchObject({ shell: { reason: 'git-external-program' }, type: 'ask' })
    const nested = join(fixture.workspace, 'subdirectory')
    await mkdir(nested)
    await expect(engine.decide({ ...query, cwd: nested })).resolves.toMatchObject({ shell: { reason: 'git-external-program' }, type: 'ask' })
    await rm(hook)

    await executeFile('git', ['config', 'remote.origin.promisor', 'true'], { cwd: fixture.workspace })
    await expect(engine.decide(query)).resolves.toMatchObject({ shell: { reason: 'git-config-unavailable' }, type: 'ask' })
    await executeFile('git', ['config', '--unset', 'remote.origin.promisor'], { cwd: fixture.workspace })
    await executeFile('git', ['update-index', '--add', '--cacheinfo', `160000,${'a'.repeat(40)},nested`], { cwd: fixture.workspace })
    await expect(engine.decide(query)).resolves.toMatchObject({ shell: { reason: 'git-config-unavailable' }, type: 'ask' })
    await expect(engine.decide({ ...query, cwd: nested })).resolves.toMatchObject({ shell: { reason: 'git-config-unavailable' }, type: 'ask' })
  })

  it('resolves historical and renamed diff targets before permitting their contents', async () => {
    const fixture = await createGitFixture()
    const engine = createEngine(fixture.home)
    await writeFile(join(fixture.workspace, '.env'), 'TEST_SECRET=placeholder\n')
    await writeFile(join(fixture.workspace, 'notes.md'), 'before\n')
    await executeFile('git', ['add', '.'], { cwd: fixture.workspace })
    await executeFile('git', ['-c', 'user.name=Permission Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'fixture'], { cwd: fixture.workspace })
    await executeFile('git', ['mv', '.env', 'public.txt'], { cwd: fixture.workspace })
    await writeFile(join(fixture.workspace, 'notes.md'), 'after\n')
    await mkdir(join(fixture.workspace, 'subdirectory'))

    await expect(engine.decide(request(fixture, {
      arguments: { command: 'git diff --cached HEAD' },
      cwd: join(fixture.workspace, 'subdirectory'),
      toolName: 'bash',
    }))).resolves.toMatchObject({ shell: { reason: 'sensitive-path' }, type: 'ask' })
    await expect(engine.decide(request(fixture, {
      arguments: { command: 'git diff HEAD -- notes.md' },
      toolName: 'bash',
    }))).resolves.toEqual({ type: 'allow' })
    const { stdout: blob } = await executeFile('git', ['rev-parse', 'HEAD:notes.md'], { cwd: fixture.workspace })
    await expect(engine.decide(request(fixture, {
      arguments: { command: `git diff ${blob.trim()} ${blob.trim()}` },
      toolName: 'bash',
    }))).resolves.toMatchObject({ shell: { reason: 'git-config-unavailable' }, type: 'ask' })
  })

  it('applies directory grants, read-only limits and manual approval to native file access', async () => {
    const fixture = await createFixture()
    const engine = createEngine(fixture.home)
    const readPath = join(fixture.outside, 'notes.md')
    await writeFile(readPath, 'notes')

    await expect(engine.decide(request(fixture, {
      arguments: { path: readPath },
      toolName: 'read',
    }))).resolves.toEqual({ type: 'allow' })
    await expect(engine.decide(request(fixture, {
      arguments: { content: 'draft', path: join(fixture.outside, 'draft.md') },
      toolName: 'write',
    }))).resolves.toMatchObject({
      grant: {
        owner: { id: 'conversation-1', kind: 'conversation' },
        root: fixture.outside,
      },
      kind: 'write',
      paths: [{ path: join(fixture.outside, 'draft.md'), zone: 'outside' }],
      type: 'ask',
    })
    const write = request(fixture, {
      arguments: { content: 'draft', path: join(fixture.workspace, 'draft.md') },
      toolName: 'write',
    })
    await expect(engine.decide({ ...write, profile: 'read_only' })).resolves.toEqual({
      code: 'READ_ONLY_PROFILE',
      source: 'profile',
      type: 'deny',
    })
    await expect(engine.decide({ ...write, approvalPolicy: 'manual' })).resolves.toMatchObject({
      kind: 'write',
      paths: [{ path: join(fixture.workspace, 'draft.md'), zone: 'workspace' }],
      type: 'ask',
    })
  })

  it('asks before reading a sensitive file and denies sensitive writes', async () => {
    const fixture = await createFixture()
    const engine = createEngine(fixture.home)
    const ssh = join(fixture.home, '.ssh')
    await mkdir(ssh)
    const secret = join(ssh, 'id_ed25519')
    await writeFile(secret, 'secret')

    await expect(engine.decide(request(fixture, {
      arguments: { path: secret },
      toolName: 'read',
    }))).resolves.toMatchObject({ kind: 'read', type: 'ask' })
    await expect(engine.decide(request(fixture, {
      arguments: { content: 'changed', path: secret },
      profile: 'full_access',
      toolName: 'write',
    }))).resolves.toEqual({
      code: 'SENSITIVE_PATH',
      source: 'sensitive',
      type: 'deny',
    })
  })

  it('keeps safe shell inspection available in read-only mode', async () => {
    const fixture = await createFixture()
    const engine = createEngine(fixture.home)

    await expect(engine.decide(request(fixture, {
      arguments: { command: 'pwd' },
      profile: 'read_only',
      toolName: 'bash',
    }))).resolves.toEqual({ type: 'allow' })
    await expect(engine.decide(request(fixture, {
      arguments: { command: 'python transform.py' },
      profile: 'read_only',
      toolName: 'bash',
    }))).resolves.toEqual({
      code: 'READ_ONLY_PROFILE',
      source: 'profile',
      type: 'deny',
    })
  })

  it('forces confirmation for unknown capabilities and recognizable system mutations', async () => {
    const fixture = await createFixture()
    const engine = createEngine(fixture.home)

    await expect(engine.decide(request(fixture, {
      arguments: {},
      profile: 'full_access',
      toolName: 'unknown_tool',
    }))).resolves.toMatchObject({
      kind: 'system',
      type: 'ask',
    })
    for (const toolName of ['bash', 'lexora_host_shell']) {
      for (const command of ['sudo /usr/bin/systemctl --user restart example.service', 'bash -c \'shutdown now\'']) {
        await expect(engine.decide(request(fixture, {
          arguments: { command },
          profile: 'full_access',
          toolName,
        }))).resolves.toMatchObject({ type: 'ask', shell: { reason: 'system-mutation' } })
      }
    }
    await expect(engine.decide(request(fixture, {
      access: 'execute',
      arguments: {},
      forceAsk: true,
      profile: 'read_only',
      toolName: 'lexora_system_action',
    }))).resolves.toEqual({
      code: 'READ_ONLY_PROFILE',
      source: 'profile',
      type: 'deny',
    })
  })

  it('requires multi-root writes to be split before any directory is granted', async () => {
    const fixture = await createFixture()
    const engine = createEngine(fixture.home)

    await expect(engine.decide(request(fixture, {
      access: 'write',
      arguments: {},
      paths: [
        { mode: 'create', path: join(fixture.outside, 'draft.md') },
        { mode: 'create', path: join(fixture.otherOutside, 'result.md') },
      ],
      toolName: 'multi_write',
    }))).resolves.toEqual({
      code: 'MULTIPLE_DIRECTORY_GRANTS_REQUIRED',
      source: 'invalid',
      type: 'deny',
    })
  })
})

function createEngine(home: string): PermissionEngine {
  return new PermissionEngine({ sensitive: createSensitivePathMatcher({ home }) })
}

function request(
  fixture: Awaited<ReturnType<typeof createFixture>>,
  overrides: Partial<PermissionRequest> & Pick<PermissionRequest, 'arguments' | 'toolName'>,
): PermissionRequest {
  return {
    approvalPolicy: 'policy',
    approvalAvailable: true,
    cwd: fixture.workspace,
    grants: fixture.grants,
    owner: { id: 'conversation-1', kind: 'conversation' },
    profile: 'workspace_write',
    ...overrides,
  }
}

async function createFixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'lexora-engine-')))
  roots.push(root)
  const workspace = join(root, 'workspace')
  const outside = join(root, 'outside')
  const otherOutside = join(root, 'other-outside')
  const home = join(root, 'home')
  await Promise.all([workspace, outside, otherOutside, home].map(path => mkdir(path)))
  const grants: PermissionGrant[] = [{
    canonicalRoot: workspace,
    grantId: 'conversation-1',
    kind: 'workspace' as const,
    root: workspace,
  }]
  return { grants, home, otherOutside, outside, workspace }
}

async function createGitFixture() {
  const fixture = await createFixture()
  const globalConfig = join(fixture.home, '.gitconfig')
  await writeFile(globalConfig, '')
  vi.stubEnv('GIT_CONFIG_GLOBAL', globalConfig)
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1')
  for (const key of ['GIT_CONFIG', 'GIT_EXTERNAL_DIFF', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_COMMON_DIR', 'GIT_INDEX_FILE', 'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_PARAMETERS'])
    vi.stubEnv(key, undefined)
  await executeFile('git', ['init', '--quiet', '--template=', fixture.workspace])
  return fixture
}
