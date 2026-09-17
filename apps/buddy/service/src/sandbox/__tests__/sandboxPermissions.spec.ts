import type { PermissionRequest } from '../../permissions/permissionContract'
import { describe, expect, it } from 'vitest'
import { createSandboxEnvironment } from '../../../../platform/process/sandboxEnvironment'
import { approvalReviewPayloadMatchesKind, approvalReviewPayloadSchema, createApprovalReviewPayload } from '../../../../shared/permissions/approvalReviewPayload'
import { sandboxAvailability } from '../../../../shared/permissions/shellSandbox'
import { createBuddySystemPrompt } from '../../agent/resources/createBuddySystemPrompt'
import { PermissionEngine } from '../../permissions/PermissionEngine'
import { resolveShellExecution } from '../shellExecution'

const request: PermissionRequest = {
  approvalAvailable: true,
  approvalPolicy: 'policy',
  arguments: { command: 'command -v xvfb-run; pnpm --version; git ls-files | head -15' },
  cwd: '/workspace',
  grants: [{ canonicalRoot: '/workspace', grantId: 'workspace', kind: 'workspace', root: '/workspace' }],
  owner: { kind: 'conversation', id: 'conversation' },
  profile: 'workspace_write',
  toolName: 'bash',
}

describe('isolated shell permissions', () => {
  const engine = new PermissionEngine({ platform: 'linux' })

  it('does not offer component repair for a failed compatibility check or imply host fallback while checking', () => {
    expect(sandboxAvailability('incompatible')).toMatchObject({ ready: false, isolated: true, action: null })
    expect(sandboxAvailability('checking')).toMatchObject({ ready: false, isolated: true, checking: true })
    expect(sandboxAvailability('needs_repair')).toMatchObject({ ready: false, action: 'repair' })
    expect(sandboxAvailability('available')).toMatchObject({ ready: true, action: null })
  })

  describe.each(['bash', 'powershell'] as const)('%s boundary', (toolName) => {
    it.each(['workspace_write', 'read_only'] as const)('allows isolated commands in %s', async (profile) => {
      for (const command of ['rm obsolete.vue', 'command -v xvfb-run; pnpm --version; git ls-files | head -15', 'node build.mjs && pnpm test', 'Get-ChildItem | Select-Object -First 15'])
        await expect(engine.decide({ ...request, toolName, profile, shellBoundary: 'sandbox', arguments: { command } })).resolves.toEqual({ type: 'allow' })
    })

    it('preserves manual and background approval boundaries', async () => {
      await expect(engine.decide({ ...request, toolName, approvalPolicy: 'manual', shellBoundary: 'sandbox' })).resolves.toMatchObject({ type: 'ask', shell: { boundary: 'sandbox', reason: 'manual-policy' } })
      await expect(engine.decide({ ...request, toolName, approvalPolicy: 'manual', approvalAvailable: false, shellBoundary: 'sandbox' })).resolves.toMatchObject({ type: 'deny', code: 'APPROVAL_UNAVAILABLE_IN_BACKGROUND' })
      await expect(engine.decide({ ...request, toolName, shellBoundary: 'sandbox', arguments: { command: 42 } })).resolves.toMatchObject({ type: 'deny', code: 'VALIDATION_FAILED' })
    })
  })

  it.each(['linux', 'win32', 'darwin'] as const)('describes the same shell and boundary that tools use on %s', (platform) => {
    for (const executionProfile of ['read_only', 'workspace_write', 'full_access'] as const) {
      const execution = resolveShellExecution(executionProfile, platform)
      const prompt = createBuddySystemPrompt({ executionProfile, platform, approvalPolicy: 'policy' })
      expect(execution.dialect).toBe(platform === 'win32' ? 'powershell' : 'bash')
      expect(execution.boundary).toBe(executionProfile === 'full_access' ? 'host' : 'sandbox')
      if (execution.boundary === 'sandbox')
        expect(prompt).toContain(platform === 'win32' ? 'PowerShell' : 'bash')
      if (platform === 'win32')
        expect(prompt).not.toContain('bash runs')
    }
  })

  it('does not trust a sandbox flag in model arguments', async () => {
    await expect(engine.decide({ ...request, arguments: { command: 'node build.mjs', shellBoundary: 'sandbox' } })).resolves.toMatchObject({ type: 'ask' })
  })

  it('preserves manual approval inside isolation', async () => {
    await expect(engine.decide({ ...request, approvalPolicy: 'manual', shellBoundary: 'sandbox' })).resolves.toMatchObject({
      type: 'ask',
      kind: 'shell',
      shell: { boundary: 'sandbox', reason: 'manual-policy' },
    })
  })

  it('does not let isolation bypass an explicitly forced confirmation', async () => {
    await expect(engine.decide({ ...request, shellBoundary: 'sandbox', forceAsk: true })).resolves.toMatchObject({
      type: 'ask',
      shell: { reason: 'forced-confirmation' },
    })
  })

  it('records directory access and run expiry without exposing internal file identity', () => {
    const review = createApprovalReviewPayload({
      allowForTurn: true,
      arguments: { path: '/reference', access: 'read', reason: 'Inspect reference' },
      kind: 'read',
      sandboxDirectory: { path: '/reference', access: 'read', reason: 'Inspect reference' },
      toolName: 'lexora_authorize_directory',
    })
    expect(review).toEqual({ card: 'sandbox-directory', toolName: 'lexora_authorize_directory', path: '/reference', access: 'read', reason: 'Inspect reference', allowForTurn: true, scope: 'run' })
    expect(approvalReviewPayloadMatchesKind(review, 'read')).toBe(true)
    expect(approvalReviewPayloadMatchesKind(review, 'write')).toBe(false)
    expect(approvalReviewPayloadSchema.safeParse({ ...review, scope: 'permanent' }).success).toBe(false)
    expect(approvalReviewPayloadSchema.safeParse({ ...review, allowForTurn: false }).success).toBe(true)
    expect(approvalReviewPayloadSchema.safeParse({ ...review, device: 1, inode: 2 }).success).toBe(false)
  })

  it('requires host authorization and forbids host escape in read-only/background runs', async () => {
    await expect(engine.decide({ ...request, toolName: 'lexora_host_shell' })).resolves.toMatchObject({ type: 'ask', shell: { reason: 'sandbox-bypass' } })
    await expect(engine.decide({ ...request, toolName: 'lexora_host_shell', profile: 'read_only' })).resolves.toMatchObject({ type: 'deny', code: 'READ_ONLY_PROFILE' })
    await expect(engine.decide({ ...request, toolName: 'lexora_host_shell', approvalAvailable: false })).resolves.toMatchObject({ type: 'deny', code: 'APPROVAL_UNAVAILABLE_IN_BACKGROUND' })
  })

  it('builds a private shell environment without provider secrets, host sockets or proxy inheritance', () => {
    const environment = createSandboxEnvironment({
      PATH: '/untrusted/bin',
      HOME: '/real/home',
      ANTHROPIC_API_KEY: 'synthetic-key',
      HTTP_PROXY: 'http://host-proxy',
      SSH_AUTH_SOCK: '/host/agent',
      DBUS_SESSION_BUS_ADDRESS: 'unix:path=/host/bus',
      NODE_OPTIONS: '--require=/host/inject.js',
      BASH_ENV: '/host/inject.sh',
      DISPLAY: ':0',
    }, '/tmp/private')
    expect(environment).toEqual({
      HOME: '/tmp/private/home',
      TMPDIR: '/tmp/private/tmp',
      XDG_CACHE_HOME: '/tmp/private/home/.cache',
      XDG_CONFIG_HOME: '/tmp/private/home/.config',
      XDG_DATA_HOME: '/tmp/private/home/.local/share',
      PATH: '/usr/local/bin:/usr/bin:/bin',
      LANG: 'C.UTF-8',
      TERM: 'dumb',
    })
  })

  it('persists a destination-specific review without secret command arguments or broad turn grants', () => {
    const review = createApprovalReviewPayload({
      allowForTurn: false,
      arguments: { command: 'curl https://example.com' },
      kind: 'network',
      network: { host: 'example.com', port: 443 },
      toolName: 'bash',
    })
    expect(review).toEqual({ allowForTurn: false, card: 'sandbox-network', host: 'example.com', port: 443, command: 'curl https://example.com', toolName: 'bash' })
    expect(approvalReviewPayloadMatchesKind(review, 'network')).toBe(true)
    expect(approvalReviewPayloadMatchesKind(review, 'shell')).toBe(false)
  })
})
