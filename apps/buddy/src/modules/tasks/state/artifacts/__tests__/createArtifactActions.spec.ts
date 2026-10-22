import type { LocalArtifact } from '@buddy-shared/artifacts/artifactApi'
import type { JSONContent } from '@tiptap/core'
import type { TaskCapability } from '../../../contracts'
import type { TaskContextTab } from '../../../model/context-panel/taskContextPanel'
import { describe, expect, it } from 'vitest'
import { shallowRef } from 'vue'
import { createArtifactActions } from '../createArtifactActions'

const artifact = { artifactId: 'artifact', conversationId: 'conversation', runId: 'run', kind: 'file', path: '/workspace/report.md' } as LocalArtifact

function fixture() {
  const content = shallowRef<JSONContent>({ type: 'doc', attrs: { panelResourceIds: ['existing'], quotes: [{ id: 'quote' }] }, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'keep draft' }] }] })
  const draftId = shallowRef('draft')
  const editorKey = shallowRef('editor')
  const branchId = shallowRef('branch')
  const selected: unknown[] = []
  let resolve = async () => 'resource'
  const task = {
    workspace: {
      composer: {
        draftId,
        editorKey,
        composerContent: content,
        draft: shallowRef('keep draft'),
        selectSource: async (source: unknown, id: string) => {
          selected.push({ source, draftId: id })
          return resolve()
        },
        updateComposerContent: (_text: string, document: JSONContent) => content.value = document,
      },
      session: {
        activeConversationId: shallowRef('conversation'),
        activeBranchId: branchId,
        activeSpace: shallowRef({ id: 'space', revokedAt: null, primaryDirectory: { id: 'directory', revision: 2, root: '/workspace', canonicalRoot: '/workspace', revokedAt: null }, additionalDirectories: [] }),
      },
      restoration: { state: shallowRef('ready') },
      status: { isClosing: shallowRef(false) },
      execution: { isSending: shallowRef(false), isMutatingBranch: shallowRef(false) },
    },
  }
  const activeTab = shallowRef<TaskContextTab | null>(null)
  const actions = createArtifactActions({
    task: () => task as unknown as TaskCapability,
    resources: {
      locateFile: (target, kind) => {
        activeTab.value = { id: 'files-tab', kind: 'files', scope: 'task:conversation', rootName: 'workspace', target: { ...target, path: kind === 'file' ? target.path : '' }, treeTarget: { path: target.path, kind } }
      },
    },
    revealFile: async () => {},
    writeClipboardText: async () => {},
  })
  return { actions, content, draftId, editorKey, branchId, activeTab, selected, pending: (promise: Promise<string>) => resolve = () => promise }
}

describe('artifact card actions', () => {
  it('references the exact artifact and branch while preserving the latest draft and quotes', async () => {
    const f = fixture()
    const pending = Promise.withResolvers<string>()
    f.pending(pending.promise)
    const request = f.actions.execute('reference', artifact)
    f.content.value = { ...f.content.value, attrs: { ...f.content.value.attrs, panelResourceIds: ['existing', 'newer'] } }
    pending.resolve('resource')
    await request
    expect(f.selected).toEqual([{ source: { artifactId: 'artifact', conversationId: 'conversation', branchId: 'branch' }, draftId: 'draft' }])
    expect(f.content.value).toEqual({
      type: 'doc',
      attrs: { panelResourceIds: ['existing', 'newer', 'resource'], quotes: [{ id: 'quote' }] },
      content: [{ type: 'paragraph', content: [{ type: 'text', text: 'keep draft' }] }],
    })
  })

  it.each(['draft', 'editor', 'branch'] as const)('does not attach a late reference to a changed %s', async (identity) => {
    const f = fixture()
    const pending = Promise.withResolvers<string>()
    f.pending(pending.promise)
    const request = f.actions.execute('reference', artifact)
    ;({ draft: f.draftId, editor: f.editorKey, branch: f.branchId })[identity].value = 'changed'
    pending.resolve('late')
    await request
    expect(f.content.value.attrs?.panelResourceIds).toEqual(['existing'])
  })

  it('locates only the bound target without changing selection on failure', async () => {
    const f = fixture()
    await f.actions.execute('locate', artifact)
    expect(f.activeTab.value).toMatchObject({ kind: 'files', target: { spaceId: 'space', directoryId: 'directory', revision: 2, path: 'report.md' } })
    expect(f.actions.canLocate({ ...artifact, path: '/elsewhere/report.md' })).toBe(false)
    await expect(f.actions.execute('locate', { ...artifact, path: '/elsewhere/report.md' })).rejects.toThrow('ARTIFACT_FILE_TARGET_UNAVAILABLE')
    expect(f.activeTab.value).toMatchObject({ target: { path: 'report.md' } })
  })

  it('does not reference or locate an artifact in a different conversation', async () => {
    const f = fixture()
    const other = { ...artifact, conversationId: 'other' }
    expect(f.actions.canReference(other)).toBe(false)
    expect(f.actions.canLocate(other)).toBe(false)
    await expect(f.actions.execute('reference', other)).rejects.toThrow('ARTIFACT_REFERENCE_UNAVAILABLE')
    expect(f.content.value.attrs?.panelResourceIds).toEqual(['existing'])
  })
})
