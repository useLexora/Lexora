import type { ApplicationLogAnchor, ApplicationLogApi, ApplicationLogExportResult, ApplicationLogPage, ApplicationLogQuery, ApplicationLogRecord } from '@buddy-shared/diagnostics/applicationLog'
import { applicationLogKey } from '@buddy-shared/diagnostics/applicationLog'
import { onScopeDispose, shallowRef, watch } from 'vue'

export function useApplicationLogs(api: ApplicationLogApi) {
  const launch = shallowRef('current')
  const category = shallowRef<NonNullable<ApplicationLogQuery['category']>>('all')
  const level = shallowRef<NonNullable<ApplicationLogQuery['level']>>('all')
  const search = shallowRef('')
  const settledSearch = shallowRef('')
  const live = shallowRef(true)
  const page = shallowRef<ApplicationLogPage | null>(null)
  const selected = shallowRef<ApplicationLogRecord | null>(null)
  const loading = shallowRef(false)
  const failed = shallowRef(false)
  const exporting = shallowRef(false)
  const requestedPage = shallowRef(1)
  const anchor = shallowRef<ApplicationLogAnchor | undefined>()
  const viewKey = shallowRef(0)
  let revision = 0
  let disposed = false
  let active: { key: string, promise: Promise<void>, passive: boolean } | null = null

  function request(passive = false): Promise<void> {
    const input: ApplicationLogQuery = { launch: launch.value, category: category.value, level: level.value, search: settledSearch.value, page: requestedPage.value, anchor: live.value ? undefined : anchor.value }
    const key = JSON.stringify(input)
    if (active?.key === key)
      return active.promise
    const requestRevision = ++revision
    loading.value = true
    const promise = api.query(input).then((result) => {
      if (disposed || requestRevision !== revision)
        return
      page.value = result
      requestedPage.value = result.page
      anchor.value = result.anchor ?? undefined
      failed.value = false
      if (selected.value) {
        const updated = result.records.find(record => applicationLogKey(record) === applicationLogKey(selected.value!))
        if (updated)
          selected.value = updated
      }
    }).catch(() => {
      if (!disposed && requestRevision === revision)
        failed.value = true
    }).finally(() => {
      if (!disposed && requestRevision === revision) {
        loading.value = false
        active = null
      }
    })
    active = { key, promise, passive }
    return promise
  }

  function refresh(): Promise<void> {
    return request()
  }

  function pause(): void {
    live.value = false
    if (active?.passive) {
      revision++
      active = null
      loading.value = false
    }
  }

  watch(search, (value, _previous, onCleanup) => {
    const timer = setTimeout(() => {
      settledSearch.value = value.trim()
    }, 250)
    onCleanup(() => clearTimeout(timer))
  })
  watch([launch, category, level, settledSearch], () => {
    requestedPage.value = 1
    anchor.value = undefined
    viewKey.value++
    selected.value = null
    void refresh()
  }, { immediate: true })

  function changePage(nextPage: number): void {
    if (!page.value || loading.value || nextPage === page.value.page)
      return
    pause()
    selected.value = null
    requestedPage.value = nextPage
    viewKey.value++
    void refresh()
  }

  function follow(): void {
    live.value = true
    requestedPage.value = 1
    anchor.value = undefined
    viewKey.value++
    selected.value = null
    void refresh()
  }

  function select(record: ApplicationLogRecord): void {
    pause()
    selected.value = selected.value && applicationLogKey(selected.value) === applicationLogKey(record) ? null : record
  }

  async function exportDiagnostics(): Promise<ApplicationLogExportResult> {
    if (disposed || exporting.value)
      return { status: 'canceled' }
    exporting.value = true
    try {
      const result = await api.exportDiagnostics({ launch: launch.value })
      return disposed ? { status: 'canceled' } : result
    }
    catch (error) {
      if (disposed)
        return { status: 'canceled' }
      throw error
    }
    finally {
      exporting.value = false
    }
  }

  const timer = setInterval(() => {
    if (live.value && requestedPage.value === 1 && !loading.value && globalThis.document?.visibilityState !== 'hidden')
      void request(true)
  }, 2000)
  onScopeDispose(() => {
    disposed = true
    revision++
    clearInterval(timer)
  })

  return { launch, category, level, search, live, page, selected, loading, failed, exporting, viewKey, refresh, pause, changePage, follow, select, exportDiagnostics }
}
