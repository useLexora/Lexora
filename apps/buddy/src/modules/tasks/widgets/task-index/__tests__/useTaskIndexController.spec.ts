import type { DesktopTaskPinnedItem } from '@buddy-electron/shared/desktopApi'
import type { LocalSpace } from '@buddy-shared/spaces/spaceApi'
import { afterEach, describe, expect, it } from 'vitest'
import { effectScope, nextTick, shallowRef } from 'vue'
import { useTaskIndexController } from '../useTaskIndexController'

const scopes: ReturnType<typeof effectScope>[] = []
afterEach(() => scopes.splice(0).forEach(scope => scope.stop()))
function space(id: string): LocalSpace {
  return { id, name: id, icon: 'folder', iconColor: 'default', activeRunCount: 0, additionalDirectories: [], createdAt: '2026-09-08T00:00:00.000Z', memoryScope: 'space_only', primaryDirectory: null, revokedAt: null, updatedAt: '2026-09-08T00:00:00.000Z' }
}

describe('task index presentation', () => {
  it('keeps folded Spaces and pinned order across refresh while expanding newly introduced Spaces', async () => {
    const scope = effectScope()
    scopes.push(scope)
    const spaces = shallowRef<readonly LocalSpace[]>([space('a'), space('b')])
    const pins = shallowRef<readonly DesktopTaskPinnedItem[]>([{ kind: 'space', id: 'b' }, { kind: 'space', id: 'a' }])
    const controller = scope.run(() => useTaskIndexController({
      getUntitledLabel: () => 'Untitled',
      onCreateSpace: async () => true,
      onDeleteTask() {},
      onDeleteSpace() {},
      onNewTask() {},
      onOpenSpaceDirectory() {},
      onRenameTask() {},
      onUpdatePinnedItems: (items) => { pins.value = items },
      onUpdateSpace: async () => true,
      pinnedItems: pins,
      spaces,
      tasks: shallowRef([]),
    }))!
    controller.selectSpaceMenuAction(spaces.value[0]!, 'edit')
    controller.toggleSpace('a')
    spaces.value = [{ ...space('a'), activeRunCount: 1 }, space('b'), space('c')]
    await nextTick()
    expect(controller.spaceEditTarget.value?.activeRunCount).toBe(1)
    expect(controller.isSpaceExpanded('a')).toBe(false)
    expect(controller.isSpaceExpanded('b')).toBe(true)
    expect(controller.isSpaceExpanded('c')).toBe(true)
    expect(controller.pinnedItems.value.map(item => item.id)).toEqual(['b', 'a'])
    spaces.value = [space('b'), space('c')]
    await nextTick()
    expect(controller.pinnedItems.value.map(item => item.id)).toEqual(['b'])
    expect(controller.spaceDialogOpen.value).toBe(false)
    expect(controller.isSpaceExpanded('a')).toBe(false)
  })
})
