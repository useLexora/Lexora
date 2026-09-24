import { z } from 'zod'
import { applicationDiagnosticSchema, diagnosticIdentitySchema } from './applicationDiagnostic'

export const APPLICATION_LOG_MAX_FILE_BYTES = 4 * 1024 * 1024
export const APPLICATION_LOG_MAX_FILES = 16
export const APPLICATION_LOG_CATEGORIES = ['application', 'runtime', 'models', 'execution', 'automations', 'capabilities', 'storage', 'recorder', 'other'] as const
export type ApplicationLogCategory = typeof APPLICATION_LOG_CATEGORIES[number]

const logText = z.string().max(16 * 1024)
export const applicationLogRecordSchema = applicationDiagnosticSchema.extend({
  schemaVersion: z.literal(1),
  timestamp: z.iso.datetime(),
  elapsedMs: z.number().finite().nonnegative(),
  sequence: z.number().int().positive(),
  launchId: diagnosticIdentitySchema,
  appVersion: z.string().max(64),
  platform: z.string().max(32),
  collectorPid: z.number().int().positive(),
  scope: z.enum(['desktop', 'local-service', 'native-pet']),
  message: logText.optional(),
  sourceId: z.string().max(192).optional(),
  sourcePid: z.number().int().positive().optional(),
  error: z.object({ name: logText, message: logText, stack: logText.optional(), code: logText.optional() }).strip().optional(),
}).strip()

export type ApplicationLogRecord = z.infer<typeof applicationLogRecordSchema>

const logAnchorSchema = z.object({ launchId: diagnosticIdentitySchema, sequence: z.number().int().positive() }).strict()
export type ApplicationLogAnchor = z.infer<typeof logAnchorSchema>

export const applicationLogQuerySchema = z.object({
  launch: diagnosticIdentitySchema.default('current'),
  category: z.enum(['all', ...APPLICATION_LOG_CATEGORIES]).default('all'),
  level: z.enum(['all', 'debug', 'info', 'warn', 'error']).default('all'),
  search: z.string().trim().max(256).default(''),
  anchor: logAnchorSchema.optional(),
  page: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER).default(1),
  pageSize: z.number().int().min(1).max(100).default(100),
}).strict()

export type ApplicationLogQuery = z.input<typeof applicationLogQuerySchema>

export const applicationLogExportSchema = z.object({ launch: diagnosticIdentitySchema, anchor: logAnchorSchema.optional() }).strict()
export type ApplicationLogExport = z.infer<typeof applicationLogExportSchema>
export type ApplicationLogExportResult = { status: 'saved', errorCount: number, contextCount: number } | { status: 'canceled' | 'empty' }
export interface ApplicationLogLaunch {
  launchId: string
  firstRecordedAt: string
  appVersion: string
  platform: string
}

export interface ApplicationLogPage {
  records: ApplicationLogRecord[]
  launches: ApplicationLogLaunch[]
  currentLaunchId: string
  page: number
  pageSize: number
  total: number
  anchor: ApplicationLogAnchor | null
  anchorExpired: boolean
  skippedRecords: number
}

export interface ApplicationLogApi {
  query: (input: ApplicationLogQuery) => Promise<ApplicationLogPage>
  exportDiagnostics: (input: ApplicationLogExport) => Promise<ApplicationLogExportResult>
}

const domains: ReadonlyArray<readonly [ApplicationLogCategory, readonly string[]]> = [
  ['models', ['provider', 'providers', 'models']],
  ['automations', ['automation', 'automations', 'scheduler']],
  ['execution', ['run', 'runs', 'turn', 'tool', 'session', 'sessions', 'session_factory', 'execution', 'chat', 'approvals', 'usage']],
  ['storage', ['database', 'event_log', 'event_replay', 'recovery', 'artifacts', 'attachments', 'filesystem', 'spaces']],
  ['capabilities', ['connector', 'connectors', 'mcp', 'skills', 'web', 'browser', 'browser_adapter', 'pet', 'guard']],
  ['recorder', ['recorder', 'observer']],
]

export function applicationLogCategory(record: Pick<ApplicationLogRecord, 'event' | 'component' | 'method' | 'scope'>): ApplicationLogCategory {
  const event = record.event.split('.')[0]!
  for (const [category, names] of domains) {
    if (names.includes(event))
      return category
  }
  const component = record.component?.replace(/^(?:runtime|desktop|renderer)\./, '').split('.')[0]
  const method = record.method?.split('.')[0]
  for (const [category, names] of domains) {
    if ((component && names.includes(component)) || (method && names.includes(method)))
      return category
  }
  if (record.scope === 'native-pet')
    return 'capabilities'
  if (['app', 'window', 'desktop', 'renderer'].includes(event) || record.component?.startsWith('desktop') || record.component?.startsWith('renderer'))
    return 'application'
  if (['runtime', 'rpc', 'process', 'service', 'component', 'startup'].includes(event) || record.component?.startsWith('runtime'))
    return 'runtime'
  return 'other'
}

export function applicationLogKey(record: ApplicationLogAnchor): string {
  return `${record.launchId}:${record.sequence}`
}
