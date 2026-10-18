<script setup lang="ts">
import type { FeatureGuide, FeatureGuideId } from '@buddy-shared/onboarding/featureDiscovery'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { ArrowRight20Regular, Play20Regular, Search20Regular } from '@vicons/fluent'
import { NButton, NInput, NPagination, NTooltip } from 'naive-ui'
import { rcompare } from 'semver'
import { computed, shallowRef, watch } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'

const props = defineProps<{ features: readonly FeatureGuide[], unread: readonly FeatureGuide[], busy: boolean, language: BuddyLocale }>()
const emit = defineEmits<{ visit: [id: FeatureGuideId], startRelease: [version: string] }>()
const { t } = useBuddyI18n(() => props.language)
const search = shallowRef('')
const selected = shallowRef('')
const page = shallowRef(1)
const pageSize = 8
const filtered = computed(() => {
  const query = search.value.trim().toLocaleLowerCase()
  return props.features.filter(feature => `${feature.version} ${t(`discovery.${feature.id}.title`)} ${t(`discovery.${feature.id}.description`)}`.toLocaleLowerCase().includes(query))
})
const releases = computed(() => [...new Set(filtered.value.map(feature => feature.version))].sort(rcompare).map(version => ({
  version,
  features: filtered.value.filter(feature => feature.version === version),
  count: props.features.filter(feature => feature.version === version).length,
  unread: props.unread.filter(feature => feature.version === version).length,
})))
const current = computed(() => releases.value.find(release => release.version === selected.value))
const items = computed(() => current.value?.features.slice((page.value - 1) * pageSize, page.value * pageSize) ?? [])
watch(releases, (values) => {
  if (!values.some(release => release.version === selected.value))
    selected.value = values[0]?.version ?? ''
}, { immediate: true })
watch([selected, search], () => page.value = 1)
</script>

<template>
  <div class="feature-release-browser grid min-h-0 gap-4">
    <NInput v-model:value="search" clearable :placeholder="t('discovery.search')" :input-props="{ 'aria-label': t('discovery.search') }">
      <template #prefix>
        <DesktopIcon :component="Search20Regular" :size="16" class="text-muted" />
      </template>
    </NInput>
    <div v-if="releases.length" class="feature-release-columns grid min-h-0 grid-cols-[136px_minmax(0,1fr)] gap-5">
      <nav class="max-h-[52vh] overflow-y-auto border-r border-r-solid border-r-border pr-3" :aria-label="t('discovery.versions')">
        <button
          v-for="release in releases" :key="release.version" type="button"
          class="mb-1 flex w-full cursor-pointer items-center justify-between gap-2 rounded-micro border-0 px-3 py-2.5 text-left text-[13px] focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-accent"
          :class="selected === release.version ? 'bg-accent-surface text-accent-text' : 'bg-transparent text-muted hover:bg-subtle hover:text-fg'"
          :aria-current="selected === release.version ? 'true' : undefined"
          @click="selected = release.version"
        >
          <span>v{{ release.version }}</span>
          <span v-if="release.unread" class="text-[11px] tabular-nums" :aria-label="t('discovery.unread', { count: release.unread })">{{ release.unread }}</span>
        </button>
      </nav>
      <section v-if="current" class="grid min-h-0 content-start gap-4">
        <header class="grid gap-3 border-b border-b-solid border-b-border pb-5">
          <div class="flex flex-wrap items-center justify-between gap-4">
            <div class="grid gap-1">
              <h2 class="m-0 text-[20px] font-600 leading-tight text-fg">
                v{{ current.version }}
              </h2>
              <span class="text-[12px] text-muted">{{ t('discovery.featureCount', { count: current.count }) }}</span>
            </div>
            <NButton type="primary" :disabled="busy" @click="emit('startRelease', current.version)">
              <template #icon>
                <DesktopIcon :component="Play20Regular" :size="18" />
              </template>
              {{ t('discovery.startRelease') }}
            </NButton>
          </div>
          <p class="m-0 text-[12px] leading-relaxed text-muted">
            {{ t('discovery.tourDescription') }}
          </p>
        </header>
        <div :key="selected + search + page" class="max-h-[45vh] overflow-y-auto pr-2">
          <article v-for="feature in items" :key="feature.id" :data-feature="feature.id" class="flex items-start gap-3 border-b border-b-solid border-b-border py-3 first:pt-0 last:border-0 last:pb-0">
            <div class="grid min-w-0 flex-1 gap-1.5">
              <div class="flex flex-wrap items-center gap-2">
                <h3 class="m-0 text-[13px] font-500 text-fg">
                  {{ t(`discovery.${feature.id}.title`) }}
                </h3>
                <span v-if="unread.some(item => item.id === feature.id)" class="text-[11px] text-accent-text">
                  {{ t('discovery.new') }}
                </span>
              </div>
              <p class="m-0 text-[12px] leading-relaxed text-muted">
                {{ t(`discovery.${feature.id}.description`) }}
              </p>
            </div>
            <NTooltip>
              <template #trigger>
                <NButton class="buddy-icon-button flex-none" quaternary size="small" :disabled="busy" :aria-label="t('discovery.visitFeature', { name: t(`discovery.${feature.id}.title`) })" @click="emit('visit', feature.id)">
                  <DesktopIcon :component="ArrowRight20Regular" :size="18" />
                </NButton>
              </template>
              {{ t('discovery.visit') }}
            </NTooltip>
          </article>
        </div>
        <NPagination v-if="current.features.length > pageSize" v-model:page="page" :page-size="pageSize" :item-count="current.features.length" :page-slot="5" size="small" />
      </section>
    </div>
    <p v-else class="m-0 py-8 text-center text-[13px] text-muted">
      {{ t(search ? 'discovery.noResults' : 'discovery.empty') }}
    </p>
  </div>
</template>

<style scoped lang="scss">
.feature-release-columns {
  @media (max-width: 640px) {
    grid-template-columns: 104px minmax(0, 1fr);
    gap: 12px;
  }
}
</style>
