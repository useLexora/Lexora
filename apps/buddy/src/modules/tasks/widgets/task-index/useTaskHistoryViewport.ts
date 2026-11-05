import type { NVirtualList } from 'naive-ui'
import type { Ref } from 'vue'
import type { TaskHistoryAnchor } from './taskHistoryViewport'
import type { TaskHistoryRow } from './taskPinnedItems'
import { nextTick, onBeforeUnmount, onMounted, watch } from 'vue'
import { captureTaskHistoryAnchor, resolveNearbyTaskHistoryScopes, resolveTaskHistoryAnchorOffset } from './taskHistoryViewport'

export function useTaskHistoryViewport(options: {
  list: Readonly<Ref<InstanceType<typeof NVirtualList> | null>>
  rows: () => readonly TaskHistoryRow[]
  active: () => boolean
  anchor: () => TaskHistoryAnchor | null
  recordAnchor: (anchor: TaskHistoryAnchor | null) => void
  ensureScope: (spaceId: string | null) => Promise<void>
  isSpaceExpanded: (spaceId: string) => boolean
}) {
  let mounted = false
  let version = 0
  let pendingAnchor = options.anchor()

  function ensureVisibleScopes() {
    const container = options.list.value?.getScrollContainer()
    if (!container || !mounted || !options.active() || container.clientHeight === 0)
      return
    for (const spaceId of resolveNearbyTaskHistoryScopes({
      rows: options.rows(),
      scrollTop: container.scrollTop,
      height: container.clientHeight,
      isSpaceExpanded: options.isSpaceExpanded,
    })) {
      void options.ensureScope(spaceId)
    }
  }

  function recordAnchor() {
    const container = options.list.value?.getScrollContainer()
    if (container && options.active() && !pendingAnchor)
      options.recordAnchor(captureTaskHistoryAnchor(options.rows(), container.scrollTop))
  }

  function handleScroll() {
    recordAnchor()
    ensureVisibleScopes()
  }

  function handleUserIntent() {
    version += 1
    pendingAnchor = null
  }

  async function restore(anchor: TaskHistoryAnchor | null, previousRows: readonly TaskHistoryRow[] = []) {
    const request = ++version
    await nextTick()
    if (!mounted || !options.active() || request !== version)
      return
    const offset = resolveTaskHistoryAnchorOffset(options.rows(), anchor, previousRows)
    if (offset !== null) {
      options.list.value?.scrollTo({ top: offset })
      pendingAnchor = null
    }
    recordAnchor()
    ensureVisibleScopes()
  }

  watch([options.rows, options.active], ([, active], [previousRows, wasActive]) => {
    if (!mounted || !active)
      return
    const container = options.list.value?.getScrollContainer()
    const anchor = !wasActive ? options.anchor() : pendingAnchor ?? (container ? captureTaskHistoryAnchor(previousRows, container.scrollTop) : options.anchor())
    void restore(anchor, !wasActive || pendingAnchor ? [] : previousRows)
  })

  onMounted(() => {
    mounted = true
    void restore(pendingAnchor)
  })

  onBeforeUnmount(() => {
    recordAnchor()
    mounted = false
    version += 1
  })

  async function revealRow(rowKey: string) {
    handleUserIntent()
    await nextTick()
    if (!mounted || !options.rows().some(row => row.key === rowKey))
      return
    options.list.value?.scrollTo({ key: rowKey, debounce: false })
    await nextTick()
    recordAnchor()
    ensureVisibleScopes()
  }

  return { ensureVisibleScopes, handleScroll, handleUserIntent, revealRow }
}
