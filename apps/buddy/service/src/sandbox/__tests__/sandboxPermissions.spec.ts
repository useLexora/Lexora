import type { PermissionRequest } from '../../permissions/permissionContract'
import { describe, expect, it } from 'vitest'
import { createSandboxEnvironment } from '../../../../platform/process/sandboxEnvironment'
import { approvalReviewPayloadMatchesKind, approvalReviewPayloadSchema, createApprovalReviewPayload } from '../../../../shared/permissions/approvalReviewPayload'
import { PermissionEngine } from '../../permissions/PermissionEngine'

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

  describe.each(['bash', 'powershell'] as const)('%s boundary', (toolName) => {
    it.each(['workspace_write', 'read_only'] as const)('allows isolated commands in %s', async (profile) => {
      const command = toolName === 'bash' ? 'rm obsolete.vue && node build.mjs | cat' : 'Remove-Item obsolete.vue; node build.mjs | Out-String'
      await expect(engine.decide({ ...request, toolName, profile, shellBoundary: 'sandbox', arguments: { command } })).resolves.toEqual({ type: 'allow' })
    })

    it('preserves manual and background approval boundaries', async () => {
      await expect(engine.decide({ ...request, toolName, approvalPolicy: 'manual', shellBoundary: 'sandbox' })).resolves.toMatchObject({ type: 'ask', shell: { boundary: 'sandbox', reason: 'manual-policy' } })
      await expect(engine.decide({ ...request, toolName, approvalPolicy: 'manual', approvalAvailable: false, shellBoundary: 'sandbox' })).resolves.toMatchObject({ type: 'deny', code: 'APPROVAL_UNAVAILABLE_IN_BACKGROUND' })
      await expect(engine.decide({ ...request, toolName, shellBoundary: 'sandbox', arguments: { command: 42 } })).resolves.toMatchObject({ type: 'deny', code: 'VALIDATION_FAILED' })
      await expect(engine.decide({ ...request, toolName, shellBoundary: 'sandbox', forceAsk: true })).resolves.toMatchObject({ type: 'ask', shell: { reason: 'forced-confirmation' } })
    })
  })

  it('does not trust a sandbox flag in model arguments', async () => {
    await expect(engine.decide({ ...request, arguments: { command: 'node build.mjs', shellBoundary: 'sandbox' } })).resolves.toMatchObject({ type: 'ask' })
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
    expect(approvalReviewPayloadSchema.safeParse({ ...review, device: 1, inode: 2 }).success).toBe(false)
  })

  it('requires host authorization and forbids host escape in read-only/background runs', async () => {
    await expect(engine.decide({ ...request, toolName: 'lexora_host_shell' })).resolves.toMatchObject({ type: 'ask', shell: { reason: 'sandbox-bypass' } })
    await expect(engine.decide({ ...request, toolName: 'lexora_host_shell', profile: 'read_only' })).resolves.toMatchObject({ type: 'deny', code: 'READ_ONLY_PROFILE' })
    await expect(engine.decide({ ...request, toolName: 'lexora_host_shell', approvalAvailable: false })).resolves.toMatchObject({ type: 'deny', code: 'APPROVAL_UNAVAILABLE_IN_BACKGROUND' })
  })

  it.each([
    ['linux', 'bash', 'node build.mjs && pnpm test', 'systemctl --user restart example.service'],
    ['win32', 'powershell', 'Get-ChildItem | Select-Object -First 15', 'Restart-Service -Name example'],
  ] as const)('uses the same full-access host command policy on %s', async (platform, toolName, command, mutation) => {
    const engine = new PermissionEngine({ platform })
    for (const name of [toolName, 'lexora_host_shell']) {
      const host = { ...request, toolName: name, profile: 'full_access' as const, arguments: { command } }
      await expect(engine.decide(host)).resolves.toEqual({ type: 'allow' })
      await expect(engine.decide({ ...host, approvalAvailable: false })).resolves.toEqual({ type: 'allow' })
      await expect(engine.decide({ ...host, approvalPolicy: 'manual' })).resolves.toMatchObject({ type: 'ask', shell: { reason: 'manual-policy' } })
      await expect(engine.decide({ ...host, forceAsk: true })).resolves.toMatchObject({ type: 'ask', kind: 'shell', shell: { cwd: request.cwd } })
      await expect(engine.decide({ ...host, arguments: { command: 42 } })).resolves.toMatchObject({ type: 'deny', code: 'VALIDATION_FAILED' })
      await expect(engine.decide({ ...host, arguments: { command: mutation } })).resolves.toMatchObject({ type: 'ask', shell: { reason: 'system-mutation' } })
      await expect(engine.decide({ ...host, arguments: { command: mutation }, approvalAvailable: false })).resolves.toMatchObject({ type: 'deny', code: 'APPROVAL_UNAVAILABLE_IN_BACKGROUND' })
    }
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

  it('creates a destination-specific network approval review', () => {
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
