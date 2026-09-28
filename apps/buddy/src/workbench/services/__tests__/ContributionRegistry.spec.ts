import { describe, expect, it } from 'vitest'
import { ContributionRegistry } from '../ContributionRegistry'

describe('contribution commits', () => {
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

  it('owns registration inputs and removes an entire owner before cleanup can reenter', () => {
    const registry = new ContributionRegistry(() => {})
    const command = { id: 'one', label: 'Original', slash: { name: 'one' }, execute() {} }
    const release = registry.register('tools', (scope) => {
      scope.command(command)
      scope.configuration({ id: 'enabled', defaultValue: true, validate: value => typeof value === 'boolean' })
      scope.cleanup(() => {
        expect(registry.commands.has('one')).toBe(false)
        expect(registry.configurations.has('enabled')).toBe(false)
      })
    })
    command.label = 'Mutated'
    command.slash.name = 'mutated'
    expect(registry.commands.get('one')).toMatchObject({ label: 'Original', slash: { name: 'one' } })
    expect(() => Reflect.set(registry.commands.get('one')!.slash!, 'name', 'changed')).not.toThrow()
    expect(registry.commands.get('one')!.slash!.name).toBe('one')
    release()
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
