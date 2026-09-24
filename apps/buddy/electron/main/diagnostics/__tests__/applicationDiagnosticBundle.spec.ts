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
  it('exports the selected scope and preceding context without free-form content or unrelated user files', async () => {
    const { reader } = await fixture([
      record(1, { launchId: 'launch-history' }),
      record(1, { level: 'info', event: 'run.started' }),
      record(2, { sourceId: 'private-source', message: 'private message', error: { name: 'Error', message: 'private error', stack: 'private stack' } }),
      record(3, { level: 'info', event: 'run.started' }),
    ])
    const bundle = await createApplicationDiagnosticBundle(reader, 'current')
    const { manifest, errors, context, files } = unpack(bundle!.bytes)
    expect(Object.keys(files).sort()).toEqual(['context.jsonl', 'errors.jsonl', 'manifest.json'])
    expect(manifest).toMatchObject({ scope: { launch: 'launch-current' }, errors: { total: 1, exported: 1, truncated: false } })
    expect(errors).toEqual([record(2)])
    expect(context.map(record => record.sequence)).toEqual([2, 1])
    expect(context[1]).toMatchObject({ event: 'run.started', runId: 'run-fixture' })
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
    expect(manifest.errors).toMatchObject({ total: 240, exported: 100, truncated: true, skippedRecords: 1 })
    expect(manifest.context).toMatchObject({ total: 240, exported: 100, truncated: true, anchor: { sequence: 240 } })
    expect(errors).toHaveLength(100)
    expect(context).toHaveLength(100)
    expect(context[0].sequence).toBe(240)
  })

  it('reports an expired context anchor without substituting unrelated recent events', async () => {
    const { reader, file } = await fixture([record(1)])
    const bundle = await createApplicationDiagnosticBundle({ query: async (input) => {
      const page = await reader.query(input)
      if (!input.anchor)
        await writeFile(file, `${JSON.stringify(record(2))}\n`)
      return page
    } }, 'current')
    const { manifest, context } = unpack(bundle!.bytes)
    expect(manifest.context.anchorExpired).toBe(true)
    expect(context).toEqual([])
  })

  it('does not generate an empty diagnostic archive', async () => {
    const { reader } = await fixture([record(1, { level: 'info' })])
    expect(await createApplicationDiagnosticBundle(reader, 'current')).toBeNull()
  })
})
