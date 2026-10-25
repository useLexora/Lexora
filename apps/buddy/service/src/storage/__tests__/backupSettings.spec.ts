import { randomUUID } from 'node:crypto'
import { parse, stringify } from 'smol-toml'
import { describe, expect, it } from 'vitest'
import { DESKTOP_NAVIGATION_LAYOUTS } from '../../../../shared/desktopNavigationLayout'
import { mergeSettings, portableSettings } from '../backupSettings'

describe('navigation layout backup settings', () => {
  it('merges custom sound lists with the restored selection while old backups preserve current sounds', () => {
    const existing = { id: randomUUID(), name: 'Current', mimeType: 'audio/wav', durationMs: 800 }
    const imported = { id: randomUUID(), name: 'Imported', mimeType: 'audio/mpeg', durationMs: 500 }
    const current = stringify({ desktop: { notification_sound: { selected: existing.id, volume: 0.4, sounds: [existing] } } })
    const incoming = stringify({ desktop: { notification_sound: { selected: imported.id, volume: 0.9, sounds: [imported] } } })
    expect(parse(mergeSettings(current, incoming))).toMatchObject({ desktop: { notification_sound: { selected: imported.id, volume: 0.9, sounds: [existing, imported] } } })
    expect(parse(mergeSettings(current, '[desktop]\nlanguage="en-US"'))).toMatchObject({ desktop: { notification_sound: { selected: existing.id, volume: 0.4, sounds: [existing] } } })
  })

  it.each(DESKTOP_NAVIGATION_LAYOUTS)('backs up and restores %s with independent sidebar preferences while retaining device settings', (navigationLayout) => {
    const incoming = `
[desktop]
navigation_layout = "${navigationLayout}"
sidebar_collapsed = true
launch_at_login = false
[desktop.task_sidebar]
collapsed = true
collapsed_sections = ["tasks"]
collapsed_spaces = ["space-a"]
width = 336
[desktop.profile]
user_name = "Portable"
device_name = "Source device"
`
    const portable = {
      desktop: {
        navigation_layout: navigationLayout,
        sidebar_collapsed: true,
        task_sidebar: { collapsed: true, collapsed_sections: ['tasks'], collapsed_spaces: ['space-a'], width: 336 },
        profile: { user_name: 'Portable' },
      },
    }
    expect(parse(portableSettings(incoming))).toEqual(portable)
    const current = `
[desktop]
navigation_layout = "full"
sidebar_collapsed = false
launch_at_login = true
language = "en-US"
[desktop.profile]
device_name = "Current device"
`
    expect(parse(mergeSettings(current, incoming))).toEqual({
      desktop: {
        ...portable.desktop,
        launch_at_login: true,
        language: 'en-US',
        profile: { user_name: 'Portable', device_name: 'Current device' },
      },
    })
  })

  it('keeps the selected layout when an older backup has only sidebar collapse preferences', () => {
    const current = '[desktop]\nnavigation_layout = "immersive"\n'
    const incoming = '[desktop]\nsidebar_collapsed = true\n[desktop.task_sidebar]\ncollapsed = true\n'
    expect(parse(mergeSettings(current, incoming))).toMatchObject({
      desktop: { navigation_layout: 'immersive', sidebar_collapsed: true, task_sidebar: { collapsed: true } },
    })
    expect(parse(portableSettings(incoming)).desktop).not.toHaveProperty('navigation_layout')
  })
})
