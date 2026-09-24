import type { ApplicationLogApi, ApplicationLogPage, ApplicationLogRecord } from '../../../shared/diagnostics/applicationLog'
import { strToU8, zipSync } from 'fflate/browser'
import { applicationLogRecordSchema } from '../../../shared/diagnostics/applicationLog'

const bundleRecordSchema = applicationLogRecordSchema.omit({ message: true, error: true, sourceId: true }).strip()
const recordLimit = 100

export async function createApplicationDiagnosticBundle(reader: Pick<ApplicationLogApi, 'query'>, launch: string) {
  const capturedAt = new Date().toISOString()
  const errors = await reader.query({ launch, category: 'all', level: 'error', pageSize: recordLimit })
  const latestError = errors.records[0]
  if (!latestError)
    return null
  const context = await reader.query({
    launch: latestError.launchId,
    anchor: { launchId: latestError.launchId, sequence: latestError.sequence },
    category: 'all',
    level: 'all',
    pageSize: recordLimit,
  })
  const manifest = {
    schemaVersion: 1,
    capturedAt,
    completedAt: new Date().toISOString(),
    scope: { launch: launch === 'current' ? errors.currentLaunchId : launch, category: 'all', level: 'error' },
    currentLaunchId: errors.currentLaunchId,
    errors: describePage(errors),
    context: { ...describePage(context), anchor: { launchId: latestError.launchId, sequence: latestError.sequence }, direction: 'at-and-before-latest-error' },
    privacy: { content: 'structured-application-metadata-only', omitted: ['messages', 'error-text-and-stacks', 'conversation-content', 'request-and-response-bodies', 'configuration', 'credentials', 'files', 'crash-dumps'] },
  }
  return {
    bytes: zipSync({
      'manifest.json': strToU8(JSON.stringify(manifest, null, 2)),
      'errors.jsonl': encodeRecords(errors.records),
      'context.jsonl': encodeRecords(context.records),
    }),
    errorCount: errors.records.length,
    contextCount: context.records.length,
    filename: `lexora-diagnostics-${capturedAt.replace(/[:.]/g, '-')}.zip`,
  }
}

function describePage(page: ApplicationLogPage) {
  return { exported: page.records.length, total: page.total, truncated: page.total > page.records.length, skippedRecords: page.skippedRecords, anchorExpired: page.anchorExpired }
}

function encodeRecords(records: ApplicationLogRecord[]): Uint8Array {
  return strToU8(records.map(record => JSON.stringify(bundleRecordSchema.parse(record))).join('\n') + (records.length ? '\n' : ''))
}
