<script setup lang="ts">
import type { LocalBuddy } from '@buddy-shared/buddies/buddyApi'
import { Add20Regular } from '@vicons/fluent'
import { NButton, NSkeleton, NTag } from 'naive-ui'
import { computed, shallowRef } from 'vue'
import { RouterLink, useRouter } from 'vue-router'
import { desktopRouteLocations } from '@/shared/navigation/desktopRoutes'
import { useDesktopUi } from '@/shared/ui/desktopUiContext'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'
import DesktopWorkspaceSidebarIdentity from '@/shared/ui/workspace-sidebar/DesktopWorkspaceSidebarIdentity.vue'
import { useBuddiesContext } from '../buddiesContext'
import { buddyLabels } from '../buddyLabels'
import BuddyAvatar from './BuddyAvatar.vue'
import BuddyProfileDialog from './BuddyProfileDialog.vue'

defineProps<{ buddyId: string }>()
const { ready, buddies, catalog, failed, refresh } = useBuddiesContext()
const { language, appSidebarCollapsed } = useDesktopUi()
const labels = computed(() => buddyLabels(language.value))
const router = useRouter()
const groups = computed(() => [
  { kind: 'actor' as const, label: labels.value.actors, buddies: buddies.value.filter(buddy => buddy.kind === 'actor') },
  { kind: 'npc' as const, label: labels.value.npcs, buddies: buddies.value.filter(buddy => buddy.kind === 'npc') },
])
const creatingKind = shallowRef<LocalBuddy['kind']>('actor')
const creating = shallowRef(false)
function create(kind: LocalBuddy['kind']) {
  creatingKind.value = kind
  creating.value = true
}

async function created(buddy: LocalBuddy) {
  await refresh()
  await router.push(desktopRouteLocations.buddies(buddy.id))
}
</script>

<template>
  <nav class="desktop-buddies-sidebar flex w-workspace-sidebar h-full min-h-0 flex-none flex-col border-r-1 border-r-solid border-r-border bg-workspace-sidebar" :aria-label="labels.title" data-testid="buddy-list">
    <header class="flex h-region-header flex-none items-center px-3 border-b-1 border-b-solid border-b-border">
      <DesktopWorkspaceSidebarIdentity :label="labels.title" :visible="appSidebarCollapsed" />
    </header>
    <div class="min-h-0 flex-1 overflow-y-auto px-[0.7rem] py-[0.9rem]">
      <div v-if="failed" role="alert" class="px-[0.65rem] text-[12px] text-muted">
        <p>{{ labels.listFailed }}</p>
        <NButton size="small" @click="refresh">
          {{ labels.retry }}
        </NButton>
      </div>
      <section v-for="group in groups" :key="group.kind" class="mb-4">
        <div class="flex items-center justify-between mb-1.5">
          <h2 class="m-0 px-[0.65rem] text-muted text-sidebar-section [font-weight:var(--buddy-sidebar-section-font-weight)]">
            {{ group.label }}
          </h2>
          <NButton quaternary size="small" class="buddy-icon-button size-7" :aria-label="`${labels.add} · ${group.label}`" :disabled="!ready" @click="create(group.kind)">
            <template #icon>
              <DesktopIcon :component="Add20Regular" />
            </template>
          </NButton>
        </div>
        <div class="flex flex-col gap-1">
          <RouterLink
            v-for="buddy in group.buddies"
            :key="buddy.id"
            :to="desktopRouteLocations.buddies(buddy.id)"
            :aria-current="buddy.id === buddyId ? 'page' : undefined"
            class="ui-focus-ring transition-state-colors flex items-center gap-3 rounded-[0.45rem] px-[0.65rem] py-2.5 decoration-none"
            :class="buddy.id === buddyId ? 'bg-nav-selected text-nav-foreground hover:bg-nav-selected-hover active:bg-nav-pressed' : 'text-fg hover:bg-nav-hover active:bg-nav-pressed'"
          >
            <BuddyAvatar :buddy-id="buddy.id" :src="buddy.avatar" class="size-9" />
            <span class="min-w-0 flex-1">
              <span class="block truncate text-sidebar-item font-600">{{ buddy.name }}</span>
              <span class="block mt-0.5 text-[11px] text-muted">{{ buddy.enabled ? (buddy.kind === 'actor' ? labels.actor : labels.npc) : labels.paused }}</span>
            </span>
            <NTag v-if="catalog?.defaultBuddyId === buddy.id" size="small" :bordered="false" class="shrink-0">
              {{ labels.default }}
            </NTag>
          </RouterLink>
        </div>
      </section>
      <NSkeleton v-if="ready && !failed && !buddies.length" :height="64" />
      <p v-if="!ready" role="status" class="px-[0.65rem] text-[12px] text-muted">
        {{ labels.unavailable }}
      </p>
    </div>
    <BuddyProfileDialog v-model:show="creating" :initial-kind="creatingKind" @saved="created" />
  </nav>
</template>
