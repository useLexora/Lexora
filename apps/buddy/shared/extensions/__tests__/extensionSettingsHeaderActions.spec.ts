import { describe, expect, it } from 'vitest'
import { extensionSettingsHeaderActionsSchema } from '../extensionSettingsHeaderActions'

const action = { id: 'engines', title: '推理引擎', icon: 'settings' }
describe('settings header action contract', () => {
  it('accepts bounded plain actions and an explicit empty replacement', () => {
    expect(extensionSettingsHeaderActionsSchema.parse([{ ...action, title: '  推理引擎  ' }, { id: 'downloads', title: '下载任务 3', icon: 'download', disabled: true }])).toEqual([action, { id: 'downloads', title: '下载任务 3', icon: 'download', disabled: true }])
    expect(extensionSettingsHeaderActionsSchema.parse([])).toEqual([])
  })

  it.each([undefined, null, 0, 43.5, 100])('preserves explicit progress %s without coercion', (progress) => {
    expect(extensionSettingsHeaderActionsSchema.parse([{ ...action, progress }])[0]?.progress).toBe(progress)
  })

  it.each([-1, 101, Number.NaN, '50'])('rejects invalid progress %s', (progress) => {
    expect(extensionSettingsHeaderActionsSchema.safeParse([{ ...action, progress }]).success).toBe(false)
  })

  it.each([
    [action, action],
    Array.from({ length: 5 }, (_, index) => ({ ...action, id: `action-${index}` })),
    [{ ...action, id: '../engines' }],
    [{ ...action, id: 'a'.repeat(65) }],
    [{ ...action, title: ' ' }],
    [{ ...action, title: 'a'.repeat(41) }],
    [{ ...action, title: 'first\nsecond' }],
    [{ ...action, icon: 'https://example.test/icon.svg' }],
    [{ ...action, command: 'host.delete' }],
    [{ ...action, disabled: 'false' }],
  ])('rejects invalid, unbounded or executable input %#', (...actions) => {
    expect(extensionSettingsHeaderActionsSchema.safeParse(actions).success).toBe(false)
  })
})
