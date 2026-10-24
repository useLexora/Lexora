import { z } from 'zod'

const methods = new Set([
  'activate',
  'ready',
  'deactivate',
  'command',
  'agent.invoke',
  'agent.cancel',
  'agent.request',
  'bootstrap',
  'window.styles.set',
  'window.styles.remove',
  'themes.request',
  'themes.changed',
  'configuration.get',
  'configuration.changed',
  'conditions.evaluate',
  'conditions.cancel',
  'conditions.invalidate',
  'commands.execute',
  'storage.get',
  'storage.read',
  'storage.set',
  'notifications.show',
  'network.get',
  'network.download',
  'network.cancel',
  'links.openExternal',
  'resources.importFile',
  'resources.beginCreate',
  'resources.release',
  'schedules.get',
  'schedules.set',
  'schedules.remove',
  'views.open',
  'views.broadcast',
  'placements.show',
  'placements.hide',
  'interactions.start',
  'interactions.end',
  'interaction.setRegions',
  'view.ready',
  'view.failed',
  'view.setActive',
  'view.setState',
  'clipboard.read',
  'clipboard.write',
  'view.setPresentation',
  'control.propose',
  'resources.readText',
  'resources.readBytes',
  'resources.pickFiles',
  'resources.pickDirectory',
  'resources.listFiles',
  'resources.listDirectories',
  'resources.scanDirectory',
  'resources.getUrl',
  'resources.revokeFile',
  'resources.revokeDirectory',
  'resources.beginSave',
  'resources.writeChunk',
  'resources.commitSave',
  'resources.cancelSave',
  'panes',
  'interactionEnded',
])
const fields = new Set([
  'action',
  'id',
  'archive',
  'document',
  'schemaVersion',
  'label',
  'appearance',
  'colors',
  'shadows',
  'materials',
  'anchor',
  'image',
  'color',
  'gradient',
  'angle',
  'stops',
  'at',
  'opacity',
  'imageOpacity',
  'scale',
  'blur',
  'position',
  'size',
  'welcome',
  'text',
  'html',
  'zh-CN',
  'en-US',
  'assets',
  'preference',
  'overrides',
  'token',
  'revision',
  'content',
  'command',
  'enabled',
  'intervalMinutes',
  'url',
  'value',
  'version',
  'resource',
  'arguments',
  'invocation',
  'type',
  'state',
  'name',
  'offset',
  'length',
  'base64',
  'filters',
  'extensions',
  'multiple',
  'width',
  'height',
  'mode',
  'params',
])

export const extensionDiagnosticSchema = z.object({
  method: z.string().max(80).refine(value => methods.has(value) || value === 'unknown'),
  stage: z.enum(['validation', 'execution', 'result', 'timeout', 'process']),
  issues: z.array(z.object({ path: z.string().max(256), code: z.string().regex(/^[a-z_]{1,40}$/) }).strict()).max(8).readonly().optional(),
}).strict()
export type ExtensionDiagnostic = z.infer<typeof extensionDiagnosticSchema>
export class ExtensionRequestError extends Error {
  readonly diagnostic: ExtensionDiagnostic

  constructor(code: string, method: string, error: unknown, stage: ExtensionDiagnostic['stage']) {
    super(code)
    this.diagnostic = extensionDiagnostic(method, error, stage)
  }
}
export interface ExtensionHostFailure {
  code: 'EXTENSION_REQUEST_TIMEOUT' | 'EXTENSION_HOST_CRASHED' | 'EXTENSION_HOST_UNRESPONSIVE' | 'EXTENSION_HOST_LOAD_FAILED'
  method: string
  stage: 'timeout' | 'process'
}
export const extensionLogSchema = z.object({
  time: z.string(),
  event: z.string(),
  code: z.string().optional(),
  durationMs: z.number().optional(),
  diagnostic: extensionDiagnosticSchema.optional(),
}).strict()

export function extensionDiagnostic(method: string, error: unknown, stage: ExtensionDiagnostic['stage'] = 'execution'): ExtensionDiagnostic {
  if (error instanceof ExtensionRequestError)
    return error.diagnostic
  const result: ExtensionDiagnostic = { method: methods.has(method) ? method : 'unknown', stage }
  if (error instanceof Error && error.message === 'EXTENSION_REQUEST_TIMEOUT')
    result.stage = 'timeout'
  if (error instanceof z.ZodError) {
    if (stage === 'execution')
      result.stage = 'validation'
    result.issues = error.issues.slice(0, 8).map(issue => ({
      code: issue.code,
      path: issue.path.slice(0, 12).map(part => typeof part === 'number' ? String(part) : fields.has(String(part)) ? String(part) : '*').join('.').slice(0, 256),
    }))
  }
  return result
}
