import type { LocalChatApi } from '@buddy-electron/shared/localChatApi'
import type { FilePreview } from '@buddy-shared/files/filePreview'
import type { LocalSkill } from '@buddy-shared/skills/skillApi'
import type { Ref } from 'vue'
import type { ExplorerNode } from '@/shared/ui/explorer/treeCollection'
import { shallowRef, watch } from 'vue'
import { replaceChildren } from '@/shared/ui/explorer/treeCollection'

interface FileTarget {
  spaceId: string | null
  skill: LocalSkill
}

export function useSkillFilePreview(api: LocalChatApi['skills'], target: Readonly<Ref<FileTarget | null>>) {
  const nodes = shallowRef<ExplorerNode[]>([])
  const expandedKeys = shallowRef<string[]>([])
  const path = shallowRef('')
  const preview = shallowRef<FilePreview | null>(null)
  const loading = shallowRef(false)
  const failed = shallowRef(false)
  const treeFailed = shallowRef(false)
  let generation = 0
  let fileVersion = 0

  async function readNodes(value: FileTarget, path: string, current: number): Promise<ExplorerNode[]> {
    const nodes: ExplorerNode[] = []
    let cursor: string | undefined
    do {
      const page = await api.listFiles({ spaceId: value.spaceId, id: value.skill.id, path, cursor })
      if (current !== generation)
        return []
      nodes.push(...page.entries.map(entry => ({ key: entry.path, label: entry.name, kind: entry.kind, disabled: entry.unavailable })))
      cursor = page.nextCursor ?? undefined
    } while (cursor)
    return nodes
  }

  async function open(filePath: string) {
    const value = target.value
    if (!value)
      return
    const current = generation
    const request = ++fileVersion
    path.value = filePath
    preview.value = null
    loading.value = true
    failed.value = false
    try {
      const result = await api.readFile({ spaceId: value.spaceId, id: value.skill.id, path: filePath })
      if (current === generation && request === fileVersion)
        preview.value = result
    }
    catch {
      if (current === generation && request === fileVersion)
        failed.value = true
    }
    finally {
      if (current === generation && request === fileVersion)
        loading.value = false
    }
  }

  async function load(node: ExplorerNode) {
    const value = target.value
    if (!value)
      return
    const current = generation
    try {
      const children = await readNodes(value, String(node.key), current)
      if (current === generation) {
        nodes.value = replaceChildren(nodes.value, node.key!, children)
        treeFailed.value = false
      }
    }
    catch {
      if (current === generation)
        treeFailed.value = true
    }
  }

  watch(() => target.value ? JSON.stringify([target.value.spaceId, target.value.skill.id, target.value.skill.filePath, target.value.skill.revision]) : null, (_key, _previous, onCleanup) => {
    const value = target.value
    const current = ++generation
    onCleanup(() => {
      generation += 1
    })
    nodes.value = []
    expandedKeys.value = []
    path.value = ''
    preview.value = null
    failed.value = false
    treeFailed.value = false
    loading.value = false
    if (!value)
      return
    void readNodes(value, '', current).then((entries) => {
      if (current === generation)
        nodes.value = entries
    }).catch(() => {
      if (current === generation)
        treeFailed.value = true
    })
    void open(value.skill.filePath.split(/[\\/]/).at(-1) ?? 'SKILL.md')
  }, { immediate: true, flush: 'sync' })

  return { nodes, expandedKeys, path, preview, loading, failed, treeFailed, open, load }
}
