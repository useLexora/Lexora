import type { RendererDiagnosticReport } from '@buddy-shared/diagnostics/rendererDiagnostic'
import type { WorkingCopyProvider } from '@/workbench/services/WorkingCopyService'
import { deferred } from '@buddy-tests/deferred'
import { describe, expect, it } from 'vitest'
import { createRendererDiagnostics } from '@/platform/runtime/RendererDiagnostics'
import { ContributionRegistry } from '@/workbench/services/ContributionRegistry'
import { WorkbenchController } from '@/workbench/services/WorkbenchController'
import { WorkingCopyService } from '@/workbench/services/WorkingCopyService'
import { WorkbenchDiagnostics } from '../WorkbenchDiagnostics'

const resource = { scheme: 'file', id: '/fixture-private/resource', data: { path: '/fixture-private/document.md' } }

describe('workbench diagnostic projection', () => {
  it('preserves save versions and one dirty transition without exposing mutable content or resource identities', async () => {
    const write = deferred<Awaited<ReturnType<WorkingCopyProvider['save']>>>()
    const copies = new WorkingCopyService({ read: async () => ({ text: 'fixture-private-body', etag: 'fixture-private-etag' }), save: () => write.promise })
    const controller = new WorkbenchController(new ContributionRegistry())
    const reports: RendererDiagnosticReport[] = []
    const transport = createRendererDiagnostics({ report: async (event) => {
      reports.push(event)

      return true
    } })
    const projection = new WorkbenchDiagnostics({ copies, controller, events: transport.events })
    await copies.open(resource)
    copies.edit(resource, 'fixture-private-first')
    const savedVersion = copies.get(resource)!.contentVersion
    const saving = copies.save(resource)
    copies.edit(resource, 'fixture-private-second')
    write.resolve({ status: 'saved', document: { text: 'fixture-private-first', etag: 'fixture-private-new-etag' } })
    await saving
    await transport.flush()
    const events = reports.map(report => report.diagnostic)
    expect(events.filter(event => event.event === 'workbench.copy.dirty_changed')).toHaveLength(1)
    expect(events.find(event => event.event === 'workbench.copy.saved')).toMatchObject({ savedVersion, contentVersion: savedVersion + 1, dirty: true, workingCopyId: copies.get(resource)!.incarnation })
    expect(events.filter(event => event.event === 'workbench.copy.saved' || event.event === 'workbench.copy.save_started').map(event => event.operationId)).toEqual([expect.any(String), events.find(event => event.event === 'workbench.copy.save_started')!.operationId])
    expect(JSON.stringify(reports)).not.toContain('fixture-private')
    expect(events.map(event => event.sourceSequence)).toEqual(events.map((_, index) => index + 1))
    projection.dispose()
    copies.edit(resource, 'after-diagnostics-removed')
    expect(copies.get(resource)!.text).toBe('after-diagnostics-removed')
    await copies.dispose()
    await controller.dispose()
    controller.registry.dispose()
    expect(await transport.dispose()).toEqual({ pending: 0, dropped: 0, failed: 0 })
  })

  it('projects registration, command and close outcomes without contribution names, arguments or cleanup errors', async () => {
    const controller = new WorkbenchController(new ContributionRegistry(), async () => ({ complete: () => {
      throw new Error('fixture-private-cleanup')
    } }))
    const copies = new WorkingCopyService({ read: async () => ({ text: '', etag: '' }), save: async (_, document) => ({ status: 'saved', document }) })
    const reports: RendererDiagnosticReport[] = []
    const transport = createRendererDiagnostics({ report: async (event) => {
      reports.push(event)

      return true
    } })
    const projection = new WorkbenchDiagnostics({ copies, controller, events: transport.events })
    controller.registry.register('fixture-private-owner', (scope) => {
      scope.view({ id: 'fixture-private-view', renderer: 'text', label: 'fixture-private-label', supports: () => true, locations: ['main'], multiple: true })
      scope.command({ id: 'fixture-private-command', label: 'fixture-private-label', execute: () => {
        throw new Error('fixture-private-command-error')
      } })
    })
    const view = (await controller.open(resource, 'fixture-private-title'))!
    await expect(controller.commands.execute('fixture-private-command', { arguments: 'fixture-private-argument' })).rejects.toThrow('fixture-private-command-error')
    expect(await controller.close(view)).toMatchObject({ committed: true, status: 'cleanup-pending' })
    await copies.dispose()
    await controller.dispose()
    controller.registry.dispose()
    projection.dispose()
    expect(await transport.dispose()).toEqual({ pending: 0, dropped: 0, failed: 0 })
    const events = reports.map(report => report.diagnostic)
    expect(events).toContainEqual(expect.objectContaining({ event: 'workbench.contributions.registered', count: 2 }))
    expect(events).toContainEqual(expect.objectContaining({ event: 'workbench.command.failed', level: 'error' }))
    expect(events).toContainEqual(expect.objectContaining({ event: 'workbench.layout.closed', count: 1 }))
    expect(events).toContainEqual(expect.objectContaining({ event: 'workbench.close.cleanup_pending', count: 1 }))
    expect(events.at(-1)).toMatchObject({ event: 'workbench.contributions.removed', count: 2 })
    expect(JSON.stringify(reports)).not.toContain('fixture-private')
  })
})
