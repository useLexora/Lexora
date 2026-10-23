import type { LocalSpace } from '@buddy-shared/spaces/spaceApi'
import { expect, it, onTestFinished } from 'vitest'
import { effectScope, onScopeDispose, shallowRef } from 'vue'
import { contextPanelFixture } from '@/modules/tasks/state/context-panel/__tests__/contextPanelFixture'
import { useTaskResourcePanel } from '@/modules/tasks/state/context-panel/useTaskResourcePanel'
import { useWorkbenchLaunchers } from '@/workbench/browser/useWorkbenchLaunchers'
import { ContributionRegistry } from '@/workbench/services/ContributionRegistry'
import { WorkbenchController } from '@/workbench/services/WorkbenchController'
import { registerResourceContributions } from '../registerResourceContributions'

function createResourcePanel(overrides: Parameters<typeof contextPanelFixture>[0] = {}) {
  const { scope, options } = contextPanelFixture(overrides)
  return scope.run(() => useTaskResourcePanel({
    ...options,
    autoCollapse: shallowRef(false),
    linkOpening: shallowRef('in-app'),
    files: { resolve: async () => { throw new Error('Unexpected file resolution') } },
    openFile: async () => { throw new Error('Unexpected file opening') },
    browser: {
      onStateChanged: () => () => {},
      close: async () => {},
      ensureSession: async () => { throw new Error('Unexpected browser session') },
      openFile: async () => { throw new Error('Unexpected file link') },
      openArtifact: async () => { throw new Error('Unexpected browser artifact') },
      navigate: async () => { throw new Error('Unexpected browser navigation') },
    },
  }))!
}

function setup(panel: Parameters<typeof registerResourceContributions>[1]) {
  const registry = new ContributionRegistry()
  const scope = effectScope()
  onTestFinished(() => scope.stop())
  const controller = new WorkbenchController(registry)
  scope.run(() => onScopeDispose(registerResourceContributions(registry, panel, () => 'en-US')))
  const launchers = scope.run(() => useWorkbenchLaunchers(controller))!
  return { controller, ...launchers }
}

it('opens a single root, asks before choosing among roots and dispatches to the current panel', async () => {
  const now = '2026-09-10T00:00:00.000Z'
  const space: LocalSpace = {
    id: 'space',
    name: 'Files',
    icon: 'folder',
    iconColor: 'default',
    memoryScope: 'space_only',
    activeRunCount: 0,
    additionalDirectories: [],
    revokedAt: null,
    createdAt: now,
    updatedAt: now,
    primaryDirectory: { id: 'directory', spaceId: 'space', root: '/workspace', canonicalRoot: '/workspace', revision: 1, accessGrantedAt: now, resourcesTrustedAt: now, revokedAt: null, createdAt: now, updatedAt: now },
  }
  const spaces = shallowRef<readonly LocalSpace[]>([space])
  const activeSpace = shallowRef<LocalSpace | null>(space)
  const original = createResourcePanel({ spaces, activeSpace })
  const panel = shallowRef(original)
  const f = setup(() => panel.value)
  await f.launch('files')
  expect(original.activeTab.value).toMatchObject({ kind: 'files', target: { spaceId: 'space', directoryId: 'directory', path: '' } })
  expect(panel.value.fileSpacePickerOpen.value).toBe(false)
  const additional = { ...space.primaryDirectory!, id: 'additional', root: '/extra', canonicalRoot: '/extra' }
  spaces.value = [{ ...space, additionalDirectories: [additional] }]
  activeSpace.value = spaces.value[0]!
  await f.controller.commands.execute('resource.files', { source: 'palette' })
  expect(panel.value.fileSpacePickerOpen.value).toBe(true)
  expect(original.allTabs.value).toHaveLength(1)
  panel.value = createResourcePanel({ activeConversationId: shallowRef('replacement') })
  expect(await f.launch('files')).toBe(false)
  await f.launch('browser')
  expect(panel.value.activeTab.value).toMatchObject({ kind: 'browser', scope: 'task:replacement' })
  expect(original.allTabs.value).toHaveLength(1)
})
