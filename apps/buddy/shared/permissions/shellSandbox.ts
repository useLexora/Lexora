import { z } from 'zod'
import { SHELL_SANDBOX_BACKEND } from '../platform/identifiers'

const pathSchema = z.string().min(1).max(4_096).refine(path => /^(?:\/|[a-z]:\\)/i.test(path) && !path.includes('\0'))

export const sandboxEnvironmentStatusSchema = z.enum(['available', 'unavailable', 'unsupported', 'needs_setup', 'needs_repair', 'incompatible'])
export type SandboxEnvironmentStatus = z.infer<typeof sandboxEnvironmentStatusSchema>

const SANDBOX_AVAILABILITY = {
  available: { ready: true, isolated: true, action: null, checking: false },
  unavailable: { ready: false, isolated: true, action: null, checking: false },
  unsupported: { ready: false, isolated: false, action: null, checking: false },
  needs_setup: { ready: false, isolated: true, action: 'setup', checking: false },
  needs_repair: { ready: false, isolated: true, action: 'repair', checking: false },
  incompatible: { ready: false, isolated: true, action: null, checking: false },
  unknown: { ready: false, isolated: true, action: null, checking: false },
  checking: { ready: false, isolated: true, action: null, checking: true },
} as const

export function sandboxAvailability(status: SandboxEnvironmentStatus | 'unknown' | 'checking') {
  return { status, ...SANDBOX_AVAILABILITY[status] }
}

export const sandboxSetupResultSchema = z.enum(['ready', 'incompatible', 'cancelled', 'failed', 'busy'])
export type SandboxSetupResult = z.infer<typeof sandboxSetupResultSchema>

export const sandboxDirectoryRequestSchema = z.object({
  access: z.enum(['read', 'write']),
  path: z.string().trim().min(1).max(4_096),
  reason: z.string().trim().min(1).max(512),
}).strict()
export type SandboxDirectoryRequest = z.infer<typeof sandboxDirectoryRequestSchema>

export const sandboxDirectoryGrantSchema = z.object({
  access: z.enum(['read', 'write']),
  path: pathSchema,
  device: z.string().regex(/^\d{1,20}$/),
  inode: z.string().regex(/^\d{1,20}$/),
}).strict()
export type SandboxDirectoryGrant = z.infer<typeof sandboxDirectoryGrantSchema>

export const sandboxCommandSchema = z.object({
  command: z.string().min(1).max(1024 * 1024),
  cwd: pathSchema,
  readOnly: z.boolean(),
  roots: z.array(pathSchema).min(1).max(128),
  workspaceRoots: z.array(pathSchema).max(128).default([]),
  resourceReadRoots: z.array(pathSchema).max(512).default([]),
  additionalDirectories: z.array(sandboxDirectoryGrantSchema).max(128).default([]),
  requestId: z.uuid(),
  timeout: z.number().positive().max(86_400).optional(),
}).strict()

export type SandboxCommand = z.infer<typeof sandboxCommandSchema>

export const sandboxProcessInputSchema = sandboxCommandSchema.extend({
  home: pathSchema,
  privateRoot: pathSchema,
  protectedRoots: z.array(pathSchema).max(32),
  searchDirectory: pathSchema,
  backend: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal(SHELL_SANDBOX_BACKEND.Linux), sandboxDirectory: pathSchema }).strict(),
    z.object({ kind: z.literal(SHELL_SANDBOX_BACKEND.MacOS) }).strict(),
    z.object({ kind: z.literal(SHELL_SANDBOX_BACKEND.Windows), executable: pathSchema, shell: pathSchema, systemRoot: pathSchema }).strict(),
  ]),
  path: z.string().max(32_768),
})
export type SandboxProcessInput = z.infer<typeof sandboxProcessInputSchema>
export type SandboxBackendInput<Kind extends SandboxProcessInput['backend']['kind']> = Omit<SandboxProcessInput, 'backend'> & {
  backend: Extract<SandboxProcessInput['backend'], { kind: Kind }>
}

export type SrtSandboxInput = SandboxBackendInput<typeof SHELL_SANDBOX_BACKEND.Linux | typeof SHELL_SANDBOX_BACKEND.MacOS>

export const sandboxNetworkTargetSchema = z.object({
  host: z.string().min(1).max(253).regex(/^[\w.:[\]-]+$/),
  port: z.number().int().min(1).max(65_535),
}).strict()
export type SandboxNetworkTarget = z.infer<typeof sandboxNetworkTargetSchema>

export const sandboxNetworkRequestSchema = sandboxNetworkTargetSchema.extend({
  requestId: z.uuid(),
})
export const sandboxCancelSchema = sandboxCommandSchema.pick({ requestId: true })
export const sandboxOutputSchema = sandboxCancelSchema.extend({ data: z.string().max(128 * 1024) })

export const sandboxResultSchema = z.discriminatedUnion('ok', [
  z.object({ ok: z.literal(true), exitCode: z.number().int().nullable() }).strict(),
  z.object({
    ok: z.literal(false),
    code: z.enum(['SANDBOX_UNAVAILABLE', 'SANDBOX_FAILED', 'SANDBOX_CANCELLED', 'SANDBOX_TIMEOUT', 'SANDBOX_BUSY', 'SANDBOX_DIRECTORY_CHANGED']),
  }).strict(),
])
export type SandboxResult = z.infer<typeof sandboxResultSchema>

export const SANDBOX_RPC_TIMEOUT_MS = 25 * 60 * 60 * 1_000

export class ShellSandboxError extends Error {
  readonly code: Extract<SandboxResult, { ok: false }>['code']

  constructor(code: ShellSandboxError['code']) {
    const hints: Record<ShellSandboxError['code'], string> = {
      SANDBOX_UNAVAILABLE: 'The sandbox is unavailable. Enable or repair it in the permission menu. Related commands remain blocked until the sandbox is available.',
      SANDBOX_FAILED: 'The sandboxed command could not complete. Do not assume it made no changes.',
      SANDBOX_CANCELLED: 'Command cancelled.',
      SANDBOX_TIMEOUT: 'Command timed out.',
      SANDBOX_BUSY: 'Too many isolated commands are running. Retry after another command finishes.',
      SANDBOX_DIRECTORY_CHANGED: 'An authorized directory was replaced or redirected. Request authorization for its current identity before using it.',
    }
    super(`${code}: ${hints[code]}`)
    this.name = 'ShellSandboxError'
    this.code = code
  }
}
