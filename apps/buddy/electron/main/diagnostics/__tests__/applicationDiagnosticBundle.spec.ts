import type { ApplicationLogRecord } from '../../../../shared/diagnostics/applicationLog'
import { appendFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createTemporaryDirectory } from '@buddy-tests/temporaryDirectories'
import { strFromU8, unzipSync } from 'fflate'
import { describe, expect, it } from 'vitest'
import { createApplicationDiagnosticBundle } from '../applicationDiagnosticBundle'
import { ApplicationLogReader } from '../ApplicationLogReader'

function record(sequence: number, overrides: Partial<ApplicationLogRecord> = {}): ApplicationLogRecord {
  return { schemaVersion: 1, timestamp: '2026-09-24T00:00:00.000Z', elapsedMs: sequence, sequence, launchId: 'launch-current', appVersion: '0.8.7', platform: 'win32', collectorPid: 42, scope: 'local-service', level: 'error', event: 'run.failed', runId: 'run-fixture', errorCode: 'MODEL_STREAM_INCOMPLETE', ...overrides }
}

async function fixture(records: ApplicationLogRecord[]) {
  const directory = await createTemporaryDirectory('lexora-diagnostic-bundle-')
  const file = join(directory, 'application.jsonl')
  await writeFile(file, `${records.map(record => JSON.stringify(record)).join('\n')}\n`)
  return { file, reader: new ApplicationLogReader(directory, 'launch-current', '/home/fixture') }
}

function unpack(bytes: Uint8Array) {
  const files = unzipSync(bytes)
  const records = (name: string) => strFromU8(files[name]!).trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  return { manifest: JSON.parse(strFromU8(files['manifest.json']!)), errors: records('errors.jsonl'), context: records('context.jsonl'), files }
}

describe('application diagnostic bundles', () => {
  it('exports related activity before and after errors without free-form content or unrelated user files', async () => {
    const { reader } = await fixture([
      record(1, { launchId: 'launch-history' }),
      record(1, { level: 'info', event: 'run.started' }),
      record(2, { sourceId: 'private-source', message: 'private message', error: { name: 'Error', message: 'private error', stack: 'private stack' } }),
      record(3, { level: 'info', event: 'run.started' }),
    ])
    const bundle = await createApplicationDiagnosticBundle(reader, 'current')
    const { manifest, errors, context, files } = unpack(bundle!.bytes)
    expect(Object.keys(files).sort()).toEqual(['context.jsonl', 'errors.jsonl', 'manifest.json', 'summary.txt'])
    expect(manifest).toMatchObject({ scope: { launch: 'launch-current' }, errors: { observed: 1, exported: 1, truncated: false } })
    expect(errors).toEqual([record(2)])
    expect(context.map(record => record.sequence)).toEqual([1, 2, 3])
    expect(context[0]).toMatchObject({ event: 'run.started', runId: 'run-fixture' })
    expect(JSON.stringify({ manifest, errors, context })).not.toContain('private')
    const history = unpack((await createApplicationDiagnosticBundle(reader, 'launch-history'))!.bytes)
    expect(history.manifest.scope.launch).toBe('launch-history')
    expect(history.errors).toHaveLength(1)
    expect(history.context.every(record => record.launchId === 'launch-history')).toBe(true)
  })

  it('bounds both collections and reports truncation and corrupt records, ignoring later appended events', async () => {
    const { reader, file } = await fixture(Array.from({ length: 240 }, (_, index) => record(index + 1)))
    await appendFile(file, 'invalid\n')
    let queried = false
    const bundle = await createApplicationDiagnosticBundle({ query: async (input) => {
      const page = await reader.query(input)
      if (!queried) {
        queried = true
        await appendFile(file, `${JSON.stringify(record(241))}\n`)
      }
      return page
    } }, 'all')
    const { manifest, errors, context } = unpack(bundle!.bytes)
    expect(manifest.errors).toMatchObject({ observed: 240, exported: 100, truncated: true })
    expect(manifest.snapshot).toMatchObject({ available: 240, scanned: 240, skippedRecords: 1, anchor: { sequence: 240 } })
    expect(manifest.context).toMatchObject({ matched: 240, exported: 240, truncated: false })
    expect(manifest.coverage).toEqual({ limited: true, reasons: ['error_limit', 'records_skipped'] })
    expect(errors).toHaveLength(100)
    expect(context).toHaveLength(240)
    expect(context.at(-1).sequence).toBe(240)
  })

  it('reports an expired context anchor without substituting unrelated recent events', async () => {
    const { reader, file } = await fixture(Array.from({ length: 101 }, (_, index) => record(index + 1)))
    const bundle = await createApplicationDiagnosticBundle({ query: async (input) => {
      const page = await reader.query(input)
      if (!input.anchor)
        await writeFile(file, `${JSON.stringify(record(102))}\n`)
      return page
    } }, 'current')
    const { manifest, context } = unpack(bundle!.bytes)
    expect(manifest.snapshot.anchorExpired).toBe(true)
    expect(manifest.snapshot.truncated).toBe(true)
    expect(context).toHaveLength(100)
    expect(context.some(record => record.sequence === 102)).toBe(false)
  })

  it('does not generate an empty diagnostic archive', async () => {
    const { reader } = await fixture([])
    expect(await createApplicationDiagnosticBundle(reader, 'current')).toBeNull()
  })

  it('exports recent activity even without errors', async () => {
    const { reader } = await fixture([record(1, { level: 'info', event: 'run.started', errorCode: undefined })])
    const bundle = await createApplicationDiagnosticBundle(reader, 'current')
    expect(bundle).toMatchObject({ errorCount: 0, contextCount: 1 })
    expect(unpack(bundle!.bytes).manifest.context.mode).toBe('recent-activity')
  })

  it('selects the full run across polling noise, including retries and recovery, without an unrelated run', async () => {
    const { reader } = await fixture([
      record(1, { level: 'info', event: 'run.started' }),
      ...Array.from({ length: 120 }, (_, index) => record(index + 2, { level: 'info', event: 'rpc.request.completed', method: 'chat.queue.list', runId: undefined })),
      record(122, { event: 'provider.request.failed', providerRequest: { operation: 'completion', api: 'openai-completions', responseObserved: true, status: 200, responseType: 'html' } }),
      record(123, { level: 'info', event: 'run.retry.started' }),
      record(124, { level: 'info', event: 'run.completed' }),
      record(125, { runId: 'run-other' }),
    ])
    const { context, errors, manifest } = unpack((await createApplicationDiagnosticBundle(reader, 'current', { launchId: 'launch-current', sequence: 122 }))!.bytes)
    expect(context.map(record => record.sequence)).toEqual([1, 122, 123, 124])
    expect(errors).toHaveLength(1)
    expect(manifest.incidents[0]).toMatchObject({ runStartObserved: true, runEndObserved: true })
    expect(manifest.snapshot.omittedRoutineRecords).toBe(120)
    expect(JSON.stringify(context)).not.toContain('run-other')
    const missing = unpack((await createApplicationDiagnosticBundle(reader, 'current', { launchId: 'launch-current', sequence: 999 }))!.bytes)
    expect(missing.manifest.scope.selectedFound).toBe(false)
    expect(missing.context).toEqual([])
  })

  it('bounds large incidents while preserving both ends and declaring gaps', async () => {
    const { reader } = await fixture(Array.from({ length: 2100 }, (_, index) => record(index + 1, { level: index === 1000 ? 'error' : 'info' })))
    const { context, manifest } = unpack((await createApplicationDiagnosticBundle(reader, 'current'))!.bytes)
    expect(context).toHaveLength(2000)
    expect(context[0].sequence).toBe(1)
    expect(context.at(-1).sequence).toBe(2100)
    expect(context.some(record => record.sequence === 1001)).toBe(true)
    expect(manifest.context.truncated).toBe(true)
    expect(manifest.coverage.reasons).toContain('context_limit')
  })

  it('centers the bounded scan around an older selected event instead of replacing it with recent incidents', async () => {
    const { reader } = await fixture(Array.from({ length: 6200 }, (_, index) => record(index + 1, { runId: index < 3 ? 'run-old' : 'run-new', level: index === 1 ? 'error' : 'info' })))
    const { context, manifest } = unpack((await createApplicationDiagnosticBundle(reader, 'current', { launchId: 'launch-current', sequence: 2 }))!.bytes)
    expect(context.map(record => record.sequence)).toEqual([1, 2, 3])
    expect(manifest.scope.selectedFound).toBe(true)
    expect(manifest.snapshot).toMatchObject({ truncated: true, available: 6200 })
    expect(manifest.snapshot.scanOffset).toBeGreaterThan(0)
  })

  it('caps recent distinct incident groups at ten and declares the internal limit only in the archive', async () => {
    const { reader } = await fixture(Array.from({ length: 12 }, (_, index) => record(index + 1, { runId: `run-${index}` })))
    const { manifest, files } = unpack((await createApplicationDiagnosticBundle(reader, 'current'))!.bytes)
    expect(manifest.incidents).toHaveLength(10)
    expect(manifest.limits.incidents).toBe(10)
    expect(manifest.incidentSelection).toEqual({ observed: 12, exported: 10, truncated: true })
    expect(manifest.coverage).toEqual({ limited: true, reasons: ['incident_limit'] })
    expect(strFromU8(files['summary.txt']!)).toContain('Limited coverage: yes - incident_limit')
  })

  it('resolves a selected RPC operation back to its run without including other runs or launches', async () => {
    const { reader } = await fixture([
      record(1, { level: 'info', event: 'run.started' }),
      record(2, { level: 'info', event: 'provider.request.started', operationId: 'operation-fixture' }),
      record(3, { event: 'provider.request.failed', operationId: 'operation-fixture' }),
      record(4, { event: 'run.failed' }),
      record(5, { event: 'rpc.request.failed', operationId: 'operation-fixture', runId: undefined }),
      record(6, { runId: 'run-other' }),
      record(7, { launchId: 'launch-history', operationId: 'operation-fixture' }),
    ])
    const { context, manifest } = unpack((await createApplicationDiagnosticBundle(reader, 'all', { launchId: 'launch-current', sequence: 5 }))!.bytes)
    expect(context.map(record => record.sequence)).toEqual([1, 2, 3, 4, 5])
    expect(manifest.incidents[0]).toMatchObject({ runStartObserved: true, runEndObserved: true })
    expect(context.every(record => record.launchId === 'launch-current')).toBe(true)
  })

  it('retains cumulative recorder losses per launch while keeping legacy counts unknown', async () => {
    const loss = { event: 'recorder.loss', level: 'warn', runId: undefined, errorCode: undefined } as const
    const { reader } = await fixture([
      record(1, { ...loss, recorderLoss: { dropped: 7, failed: 4 } }),
      record(2, { ...loss, recorderLoss: { dropped: 9, failed: 4 } }),
      record(1, { ...loss, launchId: 'launch-other', recorderLoss: { dropped: 3, failed: 2 } }),
      record(1, { ...loss, launchId: 'launch-legacy', message: 'private loss details' }),
    ])
    const { manifest, context, files } = unpack((await createApplicationDiagnosticBundle(reader, 'all'))!.bytes)
    expect(manifest.recorder).toMatchObject({ scope: 'scanned-records', lossObserved: true })
    expect(manifest.recorder.launches).toEqual(expect.arrayContaining([
      { launchId: 'launch-current', dropped: 9, failed: 4 },
      { launchId: 'launch-other', dropped: 3, failed: 2 },
      { launchId: 'launch-legacy', dropped: null, failed: null },
    ]))
    expect(context.find(record => record.launchId === 'launch-current' && record.sequence === 2).recorderLoss).toEqual({ dropped: 9, failed: 4 })
    expect(manifest.coverage).toEqual({ limited: true, reasons: ['recorder_loss'] })
    expect(strFromU8(files['summary.txt']!)).toContain('Limited coverage: yes - recorder_loss')
    expect(Object.values(files).map(bytes => strFromU8(bytes)).join('')).not.toContain('private')
  })

  it('keeps an explicitly selected run isolated from another run sharing its parent operation', async () => {
    const { reader } = await fixture([
      record(1, { level: 'info', event: 'run.started' }),
      record(2, { event: 'provider.request.failed', operationId: 'operation-shared' }),
      record(3, { event: 'provider.request.failed', operationId: 'operation-shared', runId: 'run-other' }),
      record(4, { event: 'run.failed' }),
    ])
    const { context } = unpack((await createApplicationDiagnosticBundle(reader, 'current', { launchId: 'launch-current', sequence: 2 }))!.bytes)
    expect(context.map(record => record.sequence)).toEqual([1, 2, 4])
  })

  it('exports only approved metadata even when the reader supplies additional local fields', async () => {
    const { reader } = await fixture([record(1)])
    const bundle = await createApplicationDiagnosticBundle({ query: async (input) => {
      const page = await reader.query(input)
      return { ...page, records: page.records.map(record => ({ ...record, message: 'private message', sourceId: 'private source', error: { name: 'Error', message: 'private error' }, localState: { path: '/private/path', credential: 'private credential' } })) }
    } }, 'current')
    const { errors, context, files } = unpack(bundle!.bytes)
    expect(errors).toEqual([record(1)])
    expect(context).toEqual([record(1)])
    expect(Object.values(files).map(bytes => strFromU8(bytes)).join('')).not.toContain('private')
  })
})
