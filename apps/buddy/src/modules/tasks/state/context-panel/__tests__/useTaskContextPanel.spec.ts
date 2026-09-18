import type { LocalArtifact } from '@buddy-shared/artifacts/artifactApi'
import type { LocalChangeSetSummary } from '@buddy-shared/changes/changeApi'
import type { LocalRunOutput } from '@buddy-shared/runs/runApi'
import type { LocalSpace } from '@buddy-shared/spaces/spaceApi'

import { describe, expect, it } from 'vitest'
import { nextTick, shallowRef } from 'vue'
import { createTaskPanel } from './contextPanelFixture'

describe('useTaskContextPanel', () => {
  it('discards only context tabs owned by the closed new-task pane', async () => {
    const activeDraftId = shallowRef('first')
    const panel = createTaskPanel({ activeDraftId })
    panel.addBrowser()
    const first = panel.activeTab.value!
    activeDraftId.value = 'second'
    await nextTick()
    panel.addBrowser()
    const second = panel.activeTab.value!
    expect(panel.discardDraft('first')).toEqual([first])
    expect(panel.allTabs.value).toEqual([second])
    expect(panel.activeTab.value?.id).toBe(second.id)
  })

  it('keeps browser identity when a closed new-task pane releases independent context', () => {
    const activeDraftId = shallowRef('first')
    const mode = shallowRef<'task' | 'independent'>('task')
    const panel = createTaskPanel({ activeDraftId, mode })
    panel.addBrowser()
    const first = panel.activeTab.value!
    mode.value = 'independent'
    expect(panel.discardDraft('first')).toEqual([])
    expect(panel.allTabs.value).toEqual([{ ...first, scope: 'independent' }])
    expect(panel.activeTab.value?.id).toBe(first.id)
  })

  it('offers only authorized directories and hides the linked file entry without a current directory', async () => {
    const space = fileSpace()
    const unbound = { ...space, id: 'unbound', primaryDirectory: null }
    const revoked = { ...space, id: 'revoked', revokedAt: '2026-09-17T00:00:00.000Z' }
    const spaces = shallowRef<readonly LocalSpace[]>([space, unbound, revoked])
    const activeSpace = shallowRef<LocalSpace | null>(null)
    const mode = shallowRef<'task' | 'independent'>('task')
    const panel = createTaskPanel({ spaces, activeSpace, mode })
    expect(panel.fileEntry.value).toBeNull()
    activeSpace.value = unbound
    expect(panel.fileEntry.value).toBeNull()
    activeSpace.value = space
    expect(panel.fileEntry.value).toEqual({ kind: 'directory', spaceId: space.id })
    mode.value = 'independent'
    expect(panel.fileEntry.value).toEqual({ kind: 'space-picker' })
    expect(panel.fileSpaces.value.map(space => space.id)).toEqual([space.id])
    panel.openFiles(unbound.id)
    panel.openFiles(revoked.id)
    expect(panel.tabs.value).toEqual([])
    spaces.value = [{ ...space, primaryDirectory: { ...space.primaryDirectory!, revokedAt: '2026-09-17T00:00:00.000Z' } }]
    await nextTick()
    expect(panel.fileSpaces.value).toEqual([])
    mode.value = 'task'
    expect(panel.fileEntry.value).toBeNull()
  })

  it('isolates manual tabs and restores each task selection without changing panel visibility', async () => {
    const activeConversationId = shallowRef<string | null>(null)
    const panel = createTaskPanel({
      spaces: shallowRef([]),
      activeConversationId,
      activeRunId: shallowRef(null),
      changeSets: shallowRef([]),
      runOutputs: shallowRef([]),
    })
    panel.toggle()
    expect(panel.isOpen.value).toBe(true)
    expect(panel.canAddChanges.value).toBe(false)
    panel.openChanges()
    expect(panel.tabs.value).toEqual([])
    panel.addBrowser()
    const first = panel.activeTab.value!
    expect(first).toMatchObject({ kind: 'browser', conversationId: null })
    panel.addBrowser()
    const second = panel.activeTab.value!
    expect(second.id).not.toBe(first.id)

    for (const conversationId of ['conversation-1', 'conversation-2']) {
      activeConversationId.value = conversationId
      await nextTick()
      expect(panel.tabs.value).toEqual([])
      expect(panel.activeTab.value).toBeNull()
      expect(panel.isOpen.value).toBe(true)
      expect(panel.canAddChanges.value).toBe(true)
    }
    panel.addBrowser()
    const taskBrowser = panel.activeTab.value!
    activeConversationId.value = null
    expect(panel.tabs.value).toEqual([first, second])
    expect(panel.activeTab.value).toEqual(second)
    panel.selectTab(first.id)
    activeConversationId.value = 'conversation-2'
    expect(panel.tabs.value).toEqual([taskBrowser])
    expect(panel.activeTab.value).toEqual(taskBrowser)
    panel.toggle()
    activeConversationId.value = null
    await nextTick()
    expect(panel.isOpen.value).toBe(false)
    panel.toggle()
    expect(panel.activeTab.value).toEqual(first)
  })

  it('retains a file tab in its source space and removes it when the binding changes', async () => {
    const space = fileSpace()
    const spaces = shallowRef<readonly LocalSpace[]>([space])
    const activeSpace = shallowRef<LocalSpace | null>(space)
    const activeConversationId = shallowRef<string | null>(null)
    const panel = createTaskPanel({
      spaces,
      activeSpace,
      activeConversationId,
      activeRunId: shallowRef(null),
      changeSets: shallowRef([]),
      runOutputs: shallowRef([]),
    })
    panel.openFiles('space')
    const fileTab = panel.activeTab.value!
    panel.selectFile(fileTab.id, 'README.md')
    expect(panel.activeTab.value).toMatchObject({ kind: 'files', target: { spaceId: space.id, revision: 1, path: 'README.md' } })
    activeSpace.value = null
    activeConversationId.value = 'unbound-conversation'
    await nextTick()
    expect(panel.activeTab.value).toBeNull()
    expect(panel.tabs.value).toEqual([])
    panel.addBrowser()
    const browserTab = panel.activeTab.value
    spaces.value = [{ ...space, primaryDirectory: { ...space.primaryDirectory!, revision: 2 } }]
    await nextTick()
    expect(panel.tabs.value).toEqual([browserTab])
    expect(panel.isOpen.value).toBe(true)
    spaces.value = [space]
    await nextTick()
    expect(panel.tabs.value).toEqual([browserTab])
    activeConversationId.value = null
    expect(panel.tabs.value).toEqual([])
  })

  it('keeps file previews from the same directory separate in different tasks', () => {
    const space = fileSpace()
    const activeConversationId = shallowRef<string | null>('first')
    const panel = createTaskPanel({ activeConversationId, activeSpace: shallowRef(space), spaces: shallowRef([space]) })
    panel.previewFile('/workspace/README.md')
    const first = panel.activeTab.value!
    panel.addBrowser()
    panel.selectTab(first.id)
    activeConversationId.value = 'second'
    expect(panel.tabs.value).toEqual([])
    panel.previewFile('/workspace/other.txt')
    const second = panel.activeTab.value!
    expect(second.id).not.toBe(first.id)
    activeConversationId.value = 'first'
    expect(panel.activeTab.value).toEqual(first)
    expect(panel.activeTab.value).toMatchObject({ target: { path: 'README.md' } })
    activeConversationId.value = 'second'
    expect(panel.tabs.value).toEqual([second])
    expect(panel.activeTab.value).toMatchObject({ target: { path: 'other.txt' } })
  })

  it('isolates draft resources and carries them into the task created from that draft', () => {
    const activeConversationId = shallowRef<string | null>(null)
    const activeDraftId = shallowRef('first-draft')
    const panel = createTaskPanel({ activeConversationId, activeDraftId })
    panel.addBrowser()
    const firstId = panel.activeTab.value!.id
    panel.addBrowser()
    panel.selectTab(firstId)
    activeDraftId.value = 'second-draft'
    expect(panel.tabs.value).toEqual([])
    panel.addBrowser()
    const secondId = panel.activeTab.value!.id
    activeDraftId.value = 'first-draft'
    expect(panel.activeTab.value?.id).toBe(firstId)
    panel.adoptDraft('first-draft', 'created-task')
    activeConversationId.value = 'created-task'
    expect(panel.tabs.value).toHaveLength(2)
    expect(panel.activeTab.value).toMatchObject({ id: firstId, scope: 'task:created-task', conversationId: null })
    activeDraftId.value = 'second-draft'
    activeConversationId.value = null
    expect(panel.activeTab.value?.id).toBe(secondId)
  })

  it('opens conversation resources only after an explicit user action', async () => {
    const activeConversationId = shallowRef<string | null>('conversation-1')
    const runOutputs = shallowRef<ReadonlyArray<LocalRunOutput>>([
      output('run-1', [
        artifact('artifact-1', 'conversation-1', 'first.png'),
        artifact('artifact-2', 'conversation-1', 'second.png'),
      ]),
    ])
    const panel = createTaskPanel({
      spaces: shallowRef([]),
      activeConversationId,
      activeRunId: shallowRef(null),
      changeSets: shallowRef([]),
      runOutputs,
    })

    await nextTick()
    expect(panel.tabs.value).toEqual([])
    expect(panel.activeTab.value).toBeNull()

    panel.toggle()
    expect(panel.isOpen.value).toBe(true)
    expect(panel.tabs.value).toEqual([])
    expect(panel.activeTab.value).toBeNull()

    panel.openArtifact('artifact-2')
    expect(panel.tabs.value.map(tab => 'label' in tab ? tab.label : 'Browser'))
      .toEqual(['second.png'])
    expect(panel.activeTab.value).toMatchObject({ label: 'second.png' })

    runOutputs.value = [
      ...runOutputs.value,
      output('run-1-later', [artifact('artifact-later', 'conversation-1', 'later.png')]),
    ]
    await nextTick()
    expect(panel.tabs.value.map(tab => 'label' in tab ? tab.label : 'Browser'))
      .toEqual(['second.png'])

    panel.openArtifact('artifact-1')
    expect(panel.tabs.value.map(tab => 'label' in tab ? tab.label : 'Browser')).toEqual([
      'second.png',
      'first.png',
    ])
    expect(panel.activeTab.value).toMatchObject({ label: 'first.png' })

    panel.closeTab('artifact:artifact-1')
    expect(panel.tabs.value.map(tab => 'label' in tab ? tab.label : 'Browser'))
      .toEqual(['second.png'])
    expect(panel.activeTab.value).toMatchObject({ label: 'second.png' })

    activeConversationId.value = 'conversation-2'
    runOutputs.value = [output('run-2', [
      artifact('artifact-3', 'conversation-2', 'third.png'),
    ])]
    await nextTick()

    expect(panel.isOpen.value).toBe(true)
    expect(panel.tabs.value).toEqual([])
    expect(panel.activeTab.value).toBeNull()

    panel.openArtifact('artifact-3')
    expect(panel.isOpen.value).toBe(true)
    expect(panel.tabs.value.map(tab => 'label' in tab ? tab.label : 'Browser'))
      .toEqual(['third.png'])

    activeConversationId.value = null
    await nextTick()
    expect(panel.isOpen.value).toBe(true)
    expect(panel.tabs.value).toEqual([])
  })

  it('defaults artifacts to preview and keeps each tab mode until it is closed', async () => {
    const activeConversationId = shallowRef<string | null>('conversation-1')
    const runOutputs = shallowRef<readonly LocalRunOutput[]>([output('run-1', [
      { ...artifact('first', 'conversation-1', 'first.md'), mimeType: 'text/markdown' },
      { ...artifact('second', 'conversation-1', 'second.markdown'), mimeType: 'text/markdown' },
    ])])
    const panel = createTaskPanel({
      spaces: shallowRef([]),
      activeConversationId,
      activeRunId: shallowRef(null),
      changeSets: shallowRef([]),
      runOutputs,
    })
    panel.openArtifact('first')
    expect(panel.activeTab.value).toMatchObject({ viewMode: 'preview' })
    panel.setArtifactViewMode('artifact:first', 'source')
    panel.openArtifact('second')
    expect(panel.activeTab.value).toMatchObject({ viewMode: 'preview' })
    panel.selectTab('artifact:first')
    expect(panel.activeTab.value).toMatchObject({ viewMode: 'source' })
    panel.toggle()
    panel.toggle()
    expect(panel.activeTab.value).toMatchObject({ viewMode: 'source' })

    runOutputs.value = runOutputs.value.map(item => ({
      ...item,
      artifacts: item.artifacts.map(file => ({ ...file, updatedAt: '2026-09-15T00:00:00.000Z' })),
    }))
    panel.openArtifact('first')
    expect(panel.activeTab.value).toMatchObject({ viewMode: 'source', artifact: { updatedAt: '2026-09-15T00:00:00.000Z' } })
    activeConversationId.value = 'conversation-2'
    await nextTick()
    expect(panel.tabs.value).toEqual([])
    activeConversationId.value = 'conversation-1'
    await nextTick()
    expect(panel.activeTab.value).toMatchObject({ viewMode: 'source' })
    panel.closeTab('artifact:first')
    panel.openArtifact('first')
    expect(panel.activeTab.value).toMatchObject({ viewMode: 'preview' })
  })

  it('opens a run change set in the current conversation context', async () => {
    const activeConversationId = shallowRef<string | null>('conversation-1')
    const changeSets = shallowRef<ReadonlyArray<LocalChangeSetSummary>>([
      changeSet('changes-1', 'conversation-1', 2),
      changeSet('changes-2', 'conversation-2', 1),
    ])
    const panel = createTaskPanel({
      spaces: shallowRef([]),
      activeConversationId,
      activeRunId: shallowRef(null),
      changeSets,
      runOutputs: shallowRef([]),
    })

    await nextTick()
    panel.openChanges('changes-2')
    expect(panel.isOpen.value).toBe(false)
    expect(panel.tabs.value).toEqual([])

    panel.openChanges('changes-1')
    expect(panel.isOpen.value).toBe(true)
    expect(panel.activeTab.value).toMatchObject({
      changeSet: { changeSetId: 'changes-1', fileCount: 2 },
      id: 'changes:conversation-1',
      kind: 'changes',
    })

    panel.openChanges()
    expect(panel.tabs.value).toHaveLength(1)
    expect(panel.activeTab.value).toMatchObject({ changeSet: null })
    panel.openChanges('changes-1')
    expect(panel.tabs.value).toHaveLength(1)

    activeConversationId.value = 'conversation-2'
    await nextTick()
    expect(panel.isOpen.value).toBe(true)
    expect(panel.tabs.value).toEqual([])
  })
})

function fileSpace(): LocalSpace {
  const now = '2026-09-10T00:00:00.000Z'
  return {
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
    primaryDirectory: {
      id: 'directory',
      spaceId: 'space',
      root: '/workspace',
      canonicalRoot: '/workspace',
      revision: 1,
      accessGrantedAt: now,
      resourcesTrustedAt: now,
      revokedAt: null,
      createdAt: now,
      updatedAt: now,
    },
  }
}

function changeSet(
  changeSetId: string,
  conversationId: string,
  fileCount: number,
): LocalChangeSetSummary {
  return {
    changeSetId,
    conversationId,
    coverage: 'complete',
    fileCount,
    runId: `run-${changeSetId}`,
    status: 'completed',
    updatedAt: '2026-08-27T00:00:00.000Z',
  }
}

function output(runId: string, artifacts: ReadonlyArray<LocalArtifact>): LocalRunOutput {
  return {
    artifacts,
    createdAt: '2026-08-27T00:00:00.000Z',
    runId,
    sourceToolCallId: `tool-${runId}`,
  }
}

function artifact(
  artifactId: string,
  conversationId: string,
  path: string,
  kind: LocalArtifact['kind'] = 'file',
): LocalArtifact {
  const name = path.split('/').at(-1)!
  return {
    artifactId,
    conversationId,
    createdAt: '2026-08-27T00:00:00.000Z',
    kind,
    mimeType: kind === 'directory' ? 'inode/directory' : 'image/png',
    name,
    path: `/workspace/${path}`,
    previewUrl: null,
    runId: `run-${artifactId}`,
    sizeBytes: kind === 'directory' ? 0 : 1,
    sourceArtifactId: null,
    sourceToolCallId: `tool-${artifactId}`,
    updatedAt: '2026-08-27T00:00:00.000Z',
  }
}
