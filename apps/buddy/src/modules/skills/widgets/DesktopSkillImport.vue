<script setup lang="ts">
import type { SkillInstallPreview, SkillOrigin } from '@buddy-shared/skills/skillApi'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { NAlert, NButton, NCheckbox, NInput, NModal, NSelect } from 'naive-ui'
import { computed, shallowRef, watch } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'

const props = defineProps<{
  language: BuddyLocale
  scopeLabel: string
  preview: SkillInstallPreview | null
  busy: boolean
  error: string | null
  updateName: string | null
  origin: SkillOrigin | null
}>()
const emit = defineEmits<{
  preview: [source: SkillOrigin | 'directory']
  install: [ids: readonly string[]]
  discard: [previewId: string | null]
}>()
const show = defineModel<boolean>('show', { required: true })
const { t } = useBuddyI18n(() => props.language)
const kind = shallowRef<'directory' | 'github'>('directory')
const location = shallowRef('')
const ref = shallowRef('')
const subdirectory = shallowRef('')
const selected = shallowRef<string[]>([])
const sourceOptions = computed(() => (['directory', 'github'] as const).map(value => ({ value, label: t(`desktop.skills.import.${value}`) })))
watch(show, (value) => {
  if (value) {
    kind.value = props.origin?.kind === 'github' ? 'github' : 'directory'
    location.value = props.origin?.kind === 'github' ? props.origin.location : ''
    ref.value = props.origin?.ref ?? ''
    subdirectory.value = props.origin?.subdirectory ?? ''
  }
})
watch(() => props.preview, (value, previous) => {
  selected.value = value?.candidates.filter(candidate => !candidate.blocked).map(candidate => candidate.id) ?? []
  if (previous && !value && !props.error)
    show.value = false
}, { immediate: true })

function select(id: string, enabled: boolean) {
  selected.value = enabled ? [...selected.value, id] : selected.value.filter(value => value !== id)
}

function requestPreview() {
  emit('preview', kind.value === 'github'
    ? { kind: 'github', location: location.value.trim(), ...(ref.value.trim() ? { ref: ref.value.trim() } : {}), ...(subdirectory.value.trim() ? { subdirectory: subdirectory.value.trim() } : {}) }
    : kind.value)
}

function close() {
  if (props.busy)
    return
  show.value = false
  emit('discard', props.preview?.id ?? null)
}
</script>

<template>
  <NModal :show="show" preset="card" class="skill-import" :style="{ width: 'min(38rem, calc(100vw - 3rem))' }" :title="updateName ? t('desktop.skills.updateTitle', { name: updateName }) : t('desktop.skills.install')" :mask-closable="!busy" :close-on-esc="!busy" :closable="!busy" @close="close" @update:show="value => !value && close()">
    <div class="skill-import__body">
      <p class="skill-import__scope">
        {{ t('desktop.skills.installScope', { name: scopeLabel }) }}
      </p>
      <NAlert v-if="error" type="error" :show-icon="false">
        {{ error }}
      </NAlert>
      <template v-if="!preview">
        <label class="skill-import__field">
          <span>{{ t('desktop.skills.source') }}</span>
          <NSelect v-model:value="kind" :options="sourceOptions" :disabled="busy" :aria-label="t('desktop.skills.source')" />
        </label>
        <template v-if="kind === 'github'">
          <label class="skill-import__field">
            <span>{{ t('desktop.skills.repository') }}</span>
            <NInput v-model:value="location" placeholder="owner/repository" :disabled="busy" :input-props="{ 'aria-label': t('desktop.skills.repository') }" />
          </label>
          <div class="skill-import__columns">
            <label class="skill-import__field">
              <span>{{ t('desktop.skills.ref') }}</span>
              <NInput v-model:value="ref" :disabled="busy" placeholder="HEAD" :input-props="{ 'aria-label': t('desktop.skills.ref') }" />
            </label>
            <label class="skill-import__field">
              <span>{{ t('desktop.skills.subdirectory') }}</span>
              <NInput v-model:value="subdirectory" :disabled="busy" placeholder="skills/example" :input-props="{ 'aria-label': t('desktop.skills.subdirectory') }" />
            </label>
          </div>
        </template>
        <p class="skill-import__hint">
          {{ t('desktop.skills.importHint') }}
        </p>
      </template>
      <template v-else>
        <p class="skill-import__location">
          {{ preview.source.location }}
        </p>
        <p v-if="preview.source.commit" class="skill-import__hint">
          {{ t('desktop.skills.commit') }} · {{ preview.source.commit.slice(0, 12) }}
        </p>
        <div v-for="candidate in preview.candidates" :key="candidate.id" class="skill-import__candidate">
          <NCheckbox :checked="selected.includes(candidate.id)" :disabled="busy || candidate.blocked" @update:checked="select(candidate.id, $event)">
            <strong>{{ candidate.name }}</strong>
          </NCheckbox>
          <p>{{ candidate.description }}</p>
          <small>{{ t('desktop.skills.packageSize', { count: candidate.fileCount, size: Math.ceil(candidate.bytes / 1024) }) }}</small>
          <span v-if="candidate.blocked" class="skill-import__warning">{{ t('desktop.skills.nameBlocked') }}</span>
          <span v-else-if="candidate.replacesId" class="skill-import__warning">{{ t('desktop.skills.replaces') }}</span>
        </div>
        <NAlert v-if="!preview.candidates.length" type="warning" :show-icon="false">
          {{ t('desktop.skills.noCandidates') }}
        </NAlert>
        <p v-if="preview.diagnostics.length" class="skill-import__hint">
          {{ t('desktop.skills.invalidCandidates', { count: preview.diagnostics.length }) }}
        </p>
      </template>
    </div>
    <template #footer>
      <div class="skill-import__actions">
        <NButton :disabled="busy" @click="close">
          {{ t('common.cancel') }}
        </NButton>
        <NButton v-if="!preview" type="primary" :loading="busy" :disabled="kind === 'github' && !location.trim()" @click="requestPreview">
          {{ t(kind === 'github' ? 'desktop.skills.preview' : 'desktop.skills.chooseSource') }}
        </NButton>
        <NButton v-else type="primary" :loading="busy" :disabled="!selected.length" @click="emit('install', selected)">
          {{ t(updateName ? 'desktop.skills.confirmUpdate' : 'desktop.skills.confirmInstall', { count: selected.length }) }}
        </NButton>
      </div>
    </template>
  </NModal>
</template>

<style scoped>
.skill-import__body { display: grid; gap: 1rem; max-height: 65vh; overflow-y: auto; }
.skill-import__body p { margin: 0; }
.skill-import__scope { color: var(--buddy-text-primary); font-weight: 600; }
.skill-import__field { display: grid; gap: 0.4rem; }
.skill-import__field > span, .skill-import__hint, .skill-import__candidate small { color: var(--buddy-text-secondary); font-size: 0.78rem; }
.skill-import__columns { display: grid; grid-template-columns: 1fr 1fr; gap: 0.8rem; }
.skill-import__candidate { display: grid; gap: 0.35rem; padding: 0.8rem 0; border-bottom: 1px solid var(--buddy-border-subtle); }
.skill-import__candidate p { color: var(--buddy-text-secondary); line-height: 1.6; }
.skill-import__location { overflow-wrap: anywhere; font-size: 0.8rem; }
.skill-import__warning { font-size: 0.75rem; color: var(--buddy-text-primary); }
.skill-import__actions { display: flex; justify-content: flex-end; gap: 0.6rem; }
</style>
