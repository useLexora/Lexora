<script setup lang="ts">
import type { LocalSkill } from '@buddy-shared/skills/skillApi'
import { NAlert, NSpin, useMessage } from 'naive-ui'
import { computed, nextTick, shallowRef, useTemplateRef, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import { resolveLocalChatErrorMessage } from '@/shared/lib/localChatError'
import { DESKTOP_ROUTE_NAMES, desktopRouteLocations } from '@/shared/navigation/desktopRoutes'
import { useDesktopUi } from '@/shared/ui/desktopUiContext'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'
import SkillIcon from '@/shared/ui/icon/SkillIcon.vue'
import { useSkillsContext } from '../skillsContext'
import { useSkillsManager } from '../state/useSkillsManager'
import DesktopSkillDetail from './DesktopSkillDetail.vue'
import DesktopSkillImport from './DesktopSkillImport.vue'
import DesktopSkillList from './DesktopSkillList.vue'
import DesktopSkillsToolbar from './DesktopSkillsToolbar.vue'

const context = useSkillsContext()
const message = useMessage()
const creating = shallowRef(false)
const { language } = useDesktopUi()
const { t } = useBuddyI18n(language)
const route = useRoute()
const router = useRouter()
const scope = computed(() => typeof route.query.space === 'string' ? route.query.space : null)
const category = computed(() => scope.value || route.query.scope === 'space' ? 'space' as const : 'global' as const)
const hasScope = computed(() => category.value === 'global' || !!scope.value)
const manager = useSkillsManager({ ...context, language }, scope, hasScope)
const { catalog, detail, selectedSkill, detailLoading, detailError, preview, busy, loading, error, inspect, closeDetail, startPreview, closePreview, install, setEnabled, remove, reveal } = manager
const scopeLabel = computed(() => scope.value ? context.spaces.value.find(space => space.id === scope.value)?.name ?? t('desktop.skills.spaces') : t('skill.source.global'))
const lastSpace = shallowRef<string | null>(null)
const search = shallowRef('')
const importOpen = shallowRef(false)
const updating = shallowRef<LocalSkill | null>(null)
const list = useTemplateRef<InstanceType<typeof DesktopSkillList>>('list')
const pendingLocation = shallowRef<LocalSkill | null>(null)
const sourceByScope = shallowRef<Record<string, LocalSkill['source']>>({})
const source = computed({
  get: () => sourceByScope.value[scope.value ?? 'global'] ?? 'directory',
  set: (value: LocalSkill['source']) => sourceByScope.value = { ...sourceByScope.value, [scope.value ?? 'global']: value },
})
watch(scope, (id) => {
  if (id)
    lastSpace.value = id
}, { immediate: true })
const filtered = computed(() => !!search.value.trim())
const visibleSkills = computed(() => (catalog.value?.skills ?? []).filter(skill => `${skill.name} ${skill.description}`.toLowerCase().includes(search.value.trim().toLowerCase())))
const related = computed(() => (catalog.value?.skills ?? []).filter(skill => selectedSkill.value?.shadowedBy ? skill.id === selectedSkill.value.shadowedBy : skill.shadowedBy === selectedSkill.value?.id))
const diagnostics = computed(() => catalog.value?.diagnostics.filter(item => item.code !== 'SKILL_NAME_COLLISION') ?? [])
watch([scope, category], () => {
  importOpen.value = false
  updating.value = null
  pendingLocation.value = null
})

function changeCategory(value: 'global' | 'space') {
  if (value === 'global')
    void router.replace(desktopRouteLocations.skills())
  else if (lastSpace.value && context.spaces.value.some(space => space.id === lastSpace.value && !space.revokedAt))
    void router.replace(desktopRouteLocations.skills(lastSpace.value))
  else void router.replace({ name: DESKTOP_ROUTE_NAMES.settingsSkills, query: { scope: 'space' } })
}

function openImport(skill: LocalSkill | null = null) {
  closePreview()
  updating.value = skill
  error.value = null
  importOpen.value = true
}

async function create() {
  if (!hasScope.value || creating.value)
    return
  creating.value = true
  try {
    await context.startCreation(scope.value, t('desktop.skills.creationPrompt'))
  }
  catch (reason) {
    message.error(reason instanceof Error && reason.message === 'SKILL_UNAVAILABLE' ? t('desktop.skills.creatorUnavailable') : resolveLocalChatErrorMessage(reason, language.value))
  }
  finally {
    creating.value = false
  }
}

async function locate(skill: LocalSkill) {
  search.value = ''
  if (selectedSkill.value) {
    pendingLocation.value = skill
    closeDetail()
    return
  }
  await nextTick()
  await list.value?.reveal(skill)
}

async function installSelected(candidateIds: readonly string[]) {
  const previous = catalog.value
  const spaceId = scope.value
  await install(candidateIds)
  if (spaceId && scope.value === spaceId && catalog.value !== previous && !preview.value && !error.value)
    source.value = 'space'
}

async function afterDetailClosed() {
  const skill = pendingLocation.value
  pendingLocation.value = null
  if (skill)
    await locate(skill)
}
</script>

<template>
  <div class="skills-manager">
    <DesktopSkillsToolbar v-model:search="search" :language="language" :category="category" :space-id="scope" :spaces="context.spaces.value" :disabled="busy || importOpen || creating" @category="changeCategory" @space="router.replace(desktopRouteLocations.skills($event))" @install="openImport()" @create="create" />
    <NAlert v-if="error && !importOpen" type="error" :show-icon="false">
      {{ error }}
    </NAlert>
    <div v-if="!hasScope" class="skills-manager__empty">
      <DesktopIcon :component="SkillIcon" :size="30" />
      <p>{{ t('desktop.skills.chooseSpace') }}</p>
    </div>
    <template v-else>
      <NSpin :show="loading && !catalog">
        <DesktopSkillList v-if="catalog" ref="list" v-model:source="source" :skills="visibleSkills" :catalog="catalog.skills" :language="language" :in-space="category === 'space'" :filtered="filtered" :busy="busy" @inspect="inspect" @locate="locate" @enable="setEnabled" />
        <div v-else class="skills-manager__empty" />
      </NSpin>
      <details v-if="diagnostics.length" class="skills-manager__diagnostics">
        <summary>{{ t('desktop.skills.diagnostics', { count: diagnostics.length }) }}</summary>
        <p v-for="(item, index) in diagnostics" :key="index">
          {{ t('desktop.skills.invalidHint') }}<br><code>{{ item.path }}</code>
        </p>
      </details>
    </template>
    <DesktopSkillImport v-model:show="importOpen" :language="language" :scope-label="scopeLabel" :preview="preview" :busy="busy" :error="error" :origin="updating?.origin ?? null" :update-name="updating?.name ?? null" @preview="source => startPreview(source, updating?.id)" @discard="closePreview" @install="installSelected" />
    <DesktopSkillDetail :selected="selectedSkill" :detail="detail" :loading="detailLoading" :error="detailError" :busy="busy" :space-id="scope" :related="related" @close="closeDetail" @closed="afterDetailClosed" @update="openImport" @remove="remove" @reveal="reveal" @global="changeCategory('global')" @locate="locate" />
  </div>
</template>

<style scoped>
.skills-manager { display: grid; gap: 1rem; }
.skills-manager__empty { display: grid; min-height: 10rem; justify-items: center; place-content: center; gap: 0.65rem; padding: 2rem 1rem; color: var(--buddy-text-secondary); text-align: center; }
.skills-manager__empty p { margin: 0; font-size: 0.8rem; }
.skills-manager__diagnostics { font-size: 0.75rem; color: var(--buddy-text-secondary); overflow-wrap: anywhere; }
.skills-manager__diagnostics summary { cursor: pointer; }
</style>
