import type { DocsControlCenterRouteName } from '@/stores/ui'
import { computed, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useUiStore } from '@/stores/ui'

export type DocsControlCenterTabName = 'publications' | 'trash'

const docsControlCenterRouteNameByTab = {
  publications: 'docs-publications',
  trash: 'docs-trash',
} as const satisfies Record<DocsControlCenterTabName, DocsControlCenterRouteName>

const docsControlCenterTabByRouteName = new Map<DocsControlCenterRouteName, DocsControlCenterTabName>(
  Object.entries(docsControlCenterRouteNameByTab).map(([tabName, routeName]) => [
    routeName,
    tabName as DocsControlCenterTabName,
  ]),
)

export function useDocsControlCenterTabs() {
  const route = useRoute()
  const router = useRouter()
  const uiStore = useUiStore()

  const activeTab = computed<DocsControlCenterTabName>({
    get() {
      return docsControlCenterTabByRouteName.get(route.name as DocsControlCenterRouteName) ?? 'publications'
    },
    set(tabName) {
      const routeName = docsControlCenterRouteNameByTab[tabName]

      uiStore.setLastDocsControlCenterRouteName(routeName)
      void router.push({
        name: routeName,
      })
    },
  })

  watch(
    () => route.name,
    (routeName) => {
      if (!docsControlCenterTabByRouteName.has(routeName as DocsControlCenterRouteName)) {
        return
      }

      uiStore.setLastDocsControlCenterRouteName(routeName as DocsControlCenterRouteName)
    },
    { immediate: true },
  )

  return {
    activeTab,
  }
}
