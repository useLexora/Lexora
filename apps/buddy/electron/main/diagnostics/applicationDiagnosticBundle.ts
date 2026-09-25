import type { ApplicationLogAnchor, ApplicationLogApi, ApplicationLogRecord } from '../../../shared/diagnostics/applicationLog'
import { strToU8, zipSync } from 'fflate/browser'
import { applicationLogKey, applicationLogRecordSchema } from '../../../shared/diagnostics/applicationLog'
import { isRoutineRpcRecord } from '../../../shared/diagnostics/rpcDiagnosticPolicy'

const bundleRecordSchema = applicationLogRecordSchema.pick({
  schemaVersion: true,
  timestamp: true,
  elapsedMs: true,
  sequence: true,
  launchId: true,
  appVersion: true,
  platform: true,
  collectorPid: true,
  sourcePid: true,
  scope: true,
  event: true,
  component: true,
  level: true,
  operationId: true,
  parentOperationId: true,
  generation: true,
  sessionId: true,
  providerId: true,
  connectorId: true,
  automationId: true,
  occurrenceId: true,
  toolCallId: true,
  conversationId: true,
  branchId: true,
  runId: true,
  turnId: true,
  requestId: true,
  durationMs: true,
  errorCode: true,
  errorType: true,
  failure: true,
  providerRequest: true,
  recorderLoss: true,
  processExit: true,
  loadFailure: true,
  recoveryAction: true,
  previousLaunchId: true,
  count: true,
  attempt: true,
  method: true,
  sourceSequence: true,
  occurredAt: true,
}).strip()
const limits = { scannedRecords: 5000, scannedBytes: 8 * 1024 * 1024, contextRecords: 2000, contextBytes: 4 * 1024 * 1024, errors: 100, incidents: 10 }

export async function createApplicationDiagnosticBundle(reader: Pick<ApplicationLogApi, 'query'>, launch: string, selected?: ApplicationLogAnchor) {
  const capturedAt = new Date().toISOString()
  const first = await reader.query({ launch, pageSize: 100 })
  if (!first.records.length)
    return null
  const location = selected ? await reader.query({ launch, anchor: selected, pageSize: 1 }) : undefined
  const startPage = location && !location.anchorExpired ? Math.max(1, Math.floor((first.total - location.total - 1000) / 100) + 1) : 1
  const scanOffset = (startPage - 1) * 100
  const records: ApplicationLogRecord[] = []
  let bytesRead = 0
  let skippedRecords = first.skippedRecords
  let anchorExpired = false
  let page = startPage === 1 ? first : await reader.query({ launch, anchor: first.anchor!, page: startPage, pageSize: 100 })
  while (true) {
    if (page.anchorExpired) {
      anchorExpired = true
      break
    }
    for (const raw of page.records) {
      const record = bundleRecordSchema.parse(raw)
      const size = strToU8(JSON.stringify(record)).length
      if (records.length >= limits.scannedRecords || bytesRead + size > limits.scannedBytes)
        break
      records.push(record)
      bytesRead += size
    }
    if (records.length + scanOffset >= first.total || records.length >= limits.scannedRecords || bytesRead >= limits.scannedBytes || records.length < (page.page - startPage + 1) * page.pageSize)
      break
    page = await reader.query({ launch, anchor: first.anchor!, page: page.page + 1, pageSize: 100 })
    skippedRecords = Math.max(skippedRecords, page.skippedRecords)
    if (page.anchorExpired) {
      anchorExpired = true
      break
    }
    if (!page.records.length)
      break
  }
  const meaningful = records.filter(record => !isRoutineRpcRecord(record))
  const selectedRecord = selected ? records.find(record => applicationLogKey(record) === applicationLogKey(selected)) : undefined
  const allErrors = meaningful.filter(record => record.level === 'error')
  const seeds: ApplicationLogRecord[] = []
  const seen = new Set<string>()
  for (const record of selected ? selectedRecord ? [selectedRecord] : [] : allErrors) {
    const key = `${record.launchId}:${record.runId ?? record.operationId ?? 'startup'}`
    if (seen.has(key))
      continue
    seen.add(key)
    if (seeds.length < limits.incidents)
      seeds.push(record)
  }
  const groups = seeds.map(seed => incidentRecords(meaningful, seed))
  const selectedKeys = new Set(groups.flatMap(group => group.map(applicationLogKey)))
  const candidates = selected || seeds.length ? meaningful.filter(record => selectedKeys.has(applicationLogKey(record))) : meaningful
  const prioritized = [...new Map([...seeds, ...candidates.slice(0, limits.contextRecords / 2), ...candidates.slice(limits.contextRecords / 2).reverse()].map(record => [applicationLogKey(record), record])).values()]
  const context: ApplicationLogRecord[] = []
  let contextBytes = 0
  for (const record of prioritized) {
    const size = strToU8(JSON.stringify(record)).length + 1
    if (context.length >= limits.contextRecords || contextBytes + size > limits.contextBytes)
      break
    context.push(record)
    contextBytes += size
  }
  context.sort((a, b) => a.timestamp.localeCompare(b.timestamp) || a.sequence - b.sequence)
  const scopedErrors = selected ? candidates.filter(record => record.level === 'error') : allErrors
  const errors = scopedErrors.slice(0, limits.errors).reverse()
  const recorderLosses = new Map<string, { launchId: string, dropped: number | null, failed: number | null }>()
  for (const record of records) {
    if (record.event !== 'recorder.loss')
      continue
    const loss = recorderLosses.get(record.launchId) ?? { launchId: record.launchId, dropped: null, failed: null }
    if (record.recorderLoss) {
      loss.dropped = Math.max(loss.dropped ?? 0, record.recorderLoss.dropped)
      loss.failed = Math.max(loss.failed ?? 0, record.recorderLoss.failed)
    }
    recorderLosses.set(record.launchId, loss)
  }
  const coverageReasons = Object.entries({
    scan_limit: records.length < first.total,
    incident_limit: seeds.length < seen.size,
    error_limit: errors.length < scopedErrors.length,
    context_limit: context.length < candidates.length,
    anchor_expired: anchorExpired,
    selected_event_missing: !!selected && !selectedRecord,
    records_skipped: skippedRecords > 0,
    recorder_loss: recorderLosses.size > 0,
  }).filter(([, limited]) => limited).map(([reason]) => reason)
  const manifest = {
    schemaVersion: 2,
    capturedAt,
    completedAt: new Date().toISOString(),
    scope: { launch: launch === 'current' ? first.currentLaunchId : launch, category: 'all', level: 'all', selected, selectedFound: selected ? !!selectedRecord : undefined },
    currentLaunchId: first.currentLaunchId,
    snapshot: { anchor: first.anchor, scanOffset, scanned: records.length, available: first.total, truncated: records.length < first.total, anchorExpired, skippedRecords, omittedRoutineRecords: records.length - meaningful.length },
    errors: { exported: errors.length, observed: scopedErrors.length, truncated: scopedErrors.length > errors.length },
    context: { exported: context.length, matched: candidates.length, truncated: context.length < candidates.length, order: 'chronological', mode: selected ? 'selected-event' : seeds.length ? 'recent-incidents' : 'recent-activity' },
    incidentSelection: { observed: seen.size, exported: seeds.length, truncated: seeds.length < seen.size },
    recorder: { scope: 'scanned-records', lossObserved: recorderLosses.size > 0, launches: [...recorderLosses.values()] },
    coverage: { limited: coverageReasons.length > 0, reasons: coverageReasons },
    incidents: seeds.map((seed, index) => ({
      anchor: { launchId: seed.launchId, sequence: seed.sequence },
      runId: seed.runId,
      operationId: seed.operationId,
      errorCode: seed.errorCode,
      matchedRecords: groups[index]!.length,
      runStartObserved: groups[index]!.some(record => record.event === 'run.started'),
      runEndObserved: groups[index]!.some(record => /^run\.(?:completed|failed|cancelled|interrupted)$/.test(record.event)),
    })),
    limits,
    privacy: { content: 'structured-application-metadata-only', omitted: ['messages', 'error-text-and-stacks', 'conversation-content', 'request-and-response-bodies', 'configuration', 'credentials', 'files', 'crash-dumps'] },
  }
  const summary = [
    'Lexora diagnostic bundle',
    `Captured: ${capturedAt}`,
    `Errors: ${errors.length}; context events: ${context.length}; incidents: ${seeds.length}`,
    `Snapshot: ${records.length} of ${first.total} retained events; skipped: ${skippedRecords}; routine events omitted: ${manifest.snapshot.omittedRoutineRecords}`,
    `Limited coverage: ${manifest.coverage.limited ? `yes - ${coverageReasons.join(', ')}; see manifest.json` : 'no export limit or recorded loss observed'}`,
    'context.jsonl is chronological and includes related normal events, retries and outcomes before and after errors.',
    'Coverage is limited to retained logs. A missing field or event is not evidence that it did not occur.',
    'Recorder loss counters are cumulative per launch within the scanned records; null means unknown, not zero.',
    'Provider response metadata is observational; unknown/unobserved does not mean no response was received.',
    'No conversation bodies, raw requests/responses, credentials or user files. Nothing was uploaded.',
  ].join('\n')
  return {
    bytes: zipSync({
      'manifest.json': strToU8(JSON.stringify(manifest, null, 2)),
      'summary.txt': strToU8(summary),
      'errors.jsonl': encodeRecords(errors),
      'context.jsonl': encodeRecords(context),
    }),
    errorCount: errors.length,
    contextCount: context.length,
    filename: `lexora-diagnostics-${capturedAt.replace(/[:.]/g, '-')}.zip`,
  }
}

function incidentRecords(records: ApplicationLogRecord[], seed: ApplicationLogRecord): ApplicationLogRecord[] {
  const launch = records.filter(record => record.launchId === seed.launchId)
  const runs = new Set<string>()
  if (seed.runId)
    runs.add(seed.runId)
  if (!seed.runId && seed.operationId) {
    for (const record of launch) {
      if (record.runId && (record.operationId === seed.operationId || record.parentOperationId === seed.operationId))
        runs.add(record.runId)
    }
  }
  const operations = new Set<string>()
  if (seed.operationId)
    operations.add(seed.operationId)
  for (const record of launch) {
    if (record.runId && runs.has(record.runId) && record.operationId)
      operations.add(record.operationId)
  }
  const linked = (record: ApplicationLogRecord) => applicationLogKey(record) === applicationLogKey(seed)
    || (record.runId && runs.has(record.runId))
    || (!record.runId && ((record.operationId && operations.has(record.operationId))
      || (record.parentOperationId && operations.has(record.parentOperationId))))
  const related = launch.filter(linked)
  const times = related.map(record => Date.parse(record.timestamp))
  const from = Math.min(...times) - 30_000
  const to = Math.max(...times) + 30_000
  return launch.filter(record => linked(record)
    || record.event === 'network.start_failed'
    || (!record.runId && (!record.operationId || /^(?:app|startup|runtime|recorder|component)\./.test(record.event)) && Date.parse(record.timestamp) >= from && Date.parse(record.timestamp) <= to))
}

function encodeRecords(records: ApplicationLogRecord[]): Uint8Array {
  return strToU8(records.map(record => JSON.stringify(bundleRecordSchema.parse(record))).join('\n') + (records.length ? '\n' : ''))
}
