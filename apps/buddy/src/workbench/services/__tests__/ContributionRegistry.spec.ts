import { builtinFileOpeningProviders } from '@buddy-shared/files/fileOpening'
import { describe, expect, it } from 'vitest'
import { ContributionRegistry } from '../ContributionRegistry'

describe('contribution commits', () => {
  it('owns contribution snapshots and publishes and withdraws the entire owner atomically', () => {
    const registry = new ContributionRegistry()
    const changes: { ids: readonly string[], visible: string[] }[] = []
    registry.onDidChange(change => changes.push({ ids: change.ids.launchers, visible: [...registry.launchers.keys()] }))
    const launcher = { id: 'tools.launch', label: 'Launch', icon: { url: 'data:image/png;base64,a' }, command: 'tools.open' }
    const command = { id: 'tools.open', label: 'Original', slash: { name: 'one' }, execute() {} }
    const release = registry.register('tools', (scope) => {
      scope.launcher(launcher)
      scope.command(command)
      scope.configuration({ id: 'enabled', defaultValue: true, validate: value => typeof value === 'boolean' })
      scope.fileOpener(builtinFileOpeningProviders[0]!)
      scope.view({ id: 'tools.view', renderer: 'tools.view', label: 'Tools', locations: ['context'], supports: () => true, multiple: true })
      expect(registry.launchers.size).toBe(0)
      scope.cleanup(() => {
        expect(registry.launchers.size).toBe(0)
        expect(registry.views.size).toBe(0)
        expect(registry.fileOpeners.size).toBe(0)
        expect(registry.commands.size).toBe(0)
        expect(registry.configurations.size).toBe(0)
      })
    })
    launcher.icon.url = 'changed'
    expect(registry.launchers.get(launcher.id)).toMatchObject({ owner: 'tools', icon: { url: 'data:image/png;base64,a' } })
    command.label = 'Mutated'
    command.slash.name = 'mutated'
    expect(registry.commands.get(command.id)).toMatchObject({ label: 'Original', slash: { name: 'one' } })
    expect(() => Reflect.set(registry.commands.get(command.id)!.slash!, 'name', 'changed')).not.toThrow()
    expect(registry.commands.get(command.id)!.slash!.name).toBe('one')
    release()
    release()
    expect(changes).toEqual([{ ids: ['tools.launch'], visible: ['tools.launch'] }, { ids: ['tools.launch'], visible: [] }])
  })

  it('rolls back the complete owner when a launcher conflicts and permits reuse after withdrawal', () => {
    const registry = new ContributionRegistry()
    const launcher = { id: 'tools.launch', label: 'Launch', command: 'tools.open' }
    const release = registry.register('tools', scope => scope.launcher(launcher))
    expect(() => registry.register('other', (scope) => {
      scope.command({ id: 'other.command', label: 'Other', execute() {} })
      scope.fileOpener(builtinFileOpeningProviders[0]!)
      scope.launcher(launcher)
    })).toThrow('Contribution ID conflict')
    expect(registry.commands.size).toBe(0)
    expect(registry.fileOpeners.size).toBe(0)
    expect(registry.revision).toBe(1)
    release()
    registry.register('other', scope => scope.launcher(launcher))
    expect(registry.launchers.get(launcher.id)?.owner).toBe('other')
    registry.dispose()
    expect(registry.launchers.size).toBe(0)
  })

  it('keeps committed registration releasable despite failed observers', async () => {
    const failures: unknown[] = []
    const registry = new ContributionRegistry(error => failures.push(error))
    const states: string[][] = []
    registry.onDidChange(() => {
      throw new Error('observer')
    })
    registry.onDidChange(async () => {
      throw new Error('async observer')
    })
    registry.onDidChange(() => states.push([...registry.commands.keys()]))
    let cleaned = false
    const release = registry.register('tools', (scope) => {
      scope.command({ id: 'one', label: 'One', execute() {} })
      scope.command({ id: 'two', label: 'Two', execute() {} })
      scope.cleanup(() => {
        cleaned = true
      })
    })
    expect(registry.revision).toBe(1)
    release()
    release()
    await Promise.resolve()
    expect(states).toEqual([['one', 'two'], []])
    expect(cleaned).toBe(true)
    expect(registry.revision).toBe(2)
    expect(failures).toHaveLength(4)
  })

  it('rechecks staged conflicts after nested registration and publishes only committed owners', () => {
    const registry = new ContributionRegistry(() => {})
    const owners: string[] = []
    registry.onDidChange(change => owners.push(change.owner))
    expect(() => registry.register('outer', (scope) => {
      scope.command({ id: 'shared', label: 'Outer', execute() {} })
      scope.configuration({ id: 'outer.only', defaultValue: true, validate: () => true })
      registry.register('inner', inner => inner.command({ id: 'shared', label: 'Inner', execute() {} }))
    })).toThrow('Contribution ID conflict')
    expect(registry.commands.get('shared')!.label).toBe('Inner')
    expect(registry.configurations.size).toBe(0)
    expect(owners).toEqual(['inner'])
  })
})
