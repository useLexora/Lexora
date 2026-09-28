import type { ApplicationDiagnostic } from '../../../../../shared/diagnostics/applicationDiagnostic'
import { describe, expect, it } from 'vitest'
import { applicationDiagnosticSchema } from '../../../../../shared/diagnostics/applicationDiagnostic'
import { PiApplicationObserver } from '../PiApplicationObserver'

describe('pi application metadata', () => {
  it('records a missing resource once as a failure and preserves actual permission denials', () => {
    const records: ApplicationDiagnostic[] = []
    const observer = new PiApplicationObserver({ runId: 'run-1', report: event => records.push(event) })
    for (const errorCode of ['PATH_NOT_FOUND', 'APPROVAL_DENIED']) {
      const toolCallId = `tool-${errorCode}`
      observer.handle({ type: 'tool_execution_start', toolCallId, toolName: 'read', args: { path: 'fixture.txt' } })
      observer.denied(toolCallId, errorCode)
      observer.handle({ type: 'tool_execution_end', toolCallId, toolName: 'read', result: {}, isError: true })
    }
    expect(records.map(record => record.event)).toEqual(['pi.tool.requested', 'pi.tool.failed', 'pi.tool.requested', 'pi.tool.denied'])
    expect(records[1]?.errorCode).toBe('PATH_NOT_FOUND')
  })

  it('correlates compound SDK tool identities without copying encoded or private payloads', () => {
    const records: ApplicationDiagnostic[] = []
    const observer = new PiApplicationObserver({ runId: 'run-1', report: event => records.push(event) })
    const toolCallId = `call-1|${'encoded-private-value/+'.repeat(30)}=`
    observer.handle({ type: 'turn_start' })
    observer.handle({ type: 'tool_execution_start', toolCallId, toolName: 'read', args: { path: 'private-path' } })
    observer.authorized(toolCallId)
    observer.handle({ type: 'tool_execution_end', toolCallId, toolName: 'read', result: 'private-result', isError: false })
    const toolEvents = records.filter(record => record.event.startsWith('pi.tool.'))
    expect(toolEvents.map(record => record.event)).toEqual(['pi.tool.requested', 'pi.tool.authorized', 'pi.tool.completed'])
    expect(new Set(toolEvents.map(record => record.toolCallId)).size).toBe(1)
    expect(toolEvents[0]?.toolCallId).toMatch(/^pi:[\da-f]{64}$/)
    expect(toolEvents.every(record => record.turnId === 'run-1:1')).toBe(true)
    expect(records.every(record => applicationDiagnosticSchema.safeParse(record).success)).toBe(true)
    expect(JSON.stringify(records)).not.toContain('private')
  })
})
