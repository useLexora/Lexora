import type { ExtensionStatus } from '@buddy-shared/extensions/extensionApi'
import type { WorkbenchContextSnapshot } from '@buddy-shared/workbench/workbenchContext'
import type { Ref } from 'vue'
import type { Router } from 'vue-router'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import type { DesktopNavigationEntry, DesktopPageDefinition } from '@/shared/navigation/desktopPages'
import { matchesWorkbenchContext } from '@buddy-shared/workbench/workbenchContext'
import { computed, shallowRef, watch } from 'vue'
import { extensionPageDefinitions } from '@/modules/extensions/routes'
import { resolveDesktopPageId } from '@/shared/navigation/desktopPages'

export function useDesktopPages(router: Router, installed: Readonly<Ref<ExtensionStatus[]>>, language: Readonly<Ref<BuddyLocale>>) {
  const definitions = computed(() => {
    void router.currentRoute.value
    const registered = new Map<string, DesktopPageDefinition>()
    for (const route of router.getRoutes()) {
      const definition = route.meta.desktopPageDefinition
      if (definition)
        registered.set(definition.id, definition)
    }
    for (const page of extensionPageDefinitions(installed.value)) registered.set(page.id, page)
    return [...registered.values()].sort((a, b) => a.order - b.order || a.id.localeCompare(b.id))
  })
  const current = computed(() => resolveDesktopPageId(router.currentRoute.value))
  const lastSettingsLocation = shallowRef<string>()
  watch(router.currentRoute, (route) => {
    if (resolveDesktopPageId(route) === 'lexora.settings')
      lastSettingsLocation.value = route.fullPath
  }, { immediate: true, flush: 'sync' })
  const context = computed<WorkbenchContextSnapshot>((previous) => {
    const next = {
      values: { ...definitions.value.find(page => page.id === current.value)?.context?.(router.currentRoute.value), 'page.id': current.value },
      pages: definitions.value.map(page => ({ id: page.id, title: page.title(language.value) })),
    }
    return previous && JSON.stringify(previous) === JSON.stringify(next) ? previous : next
  })
  const navigation = computed<DesktopNavigationEntry[]>(() => definitions.value.filter(page => matchesWorkbenchContext(page.when, context.value.values)).map(page => ({ id: page.id, title: page.title(language.value), location: page.id === 'lexora.settings' ? lastSettingsLocation.value ?? page.location : page.location, icon: page.icon, extensionId: page.extensionId, active: page.id === current.value })))
  return { current, context, navigation }
}
