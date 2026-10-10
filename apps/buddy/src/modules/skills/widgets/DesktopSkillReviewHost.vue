<script setup lang="ts">
import type { SkillInstallPreview } from '@buddy-shared/skills/skillApi'
import { useMessage } from 'naive-ui'
import { computed, onScopeDispose, shallowRef } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import { resolveLocalChatErrorMessage } from '@/shared/lib/localChatError'
import { useDesktopUi } from '@/shared/ui/desktopUiContext'
import { useSkillsContext } from '../skillsContext'
import DesktopSkillImport from './DesktopSkillImport.vue'

const { api, spaces } = useSkillsContext()
const { language } = useDesktopUi()
const { t } = useBuddyI18n(language)
const message = useMessage()
const reviews = shallowRef<readonly SkillInstallPreview[]>([])
const review = computed(() => reviews.value[0] ?? null)
const busy = shallowRef(false)
const error = shallowRef<string | null>(null)
const scopeLabel = computed(() => review.value?.spaceId ? spaces.value.find(space => space.id === review.value?.spaceId)?.name ?? t('desktop.skills.spaces') : t('skill.source.global'))

function cancel(id: string | null) {
  if (!id || busy.value || !reviews.value.some(item => item.id === id))
    return
  reviews.value = reviews.value.filter(item => item.id !== id)
  error.value = null
  void api.discard(id).catch(() => {})
}

onScopeDispose(api.onReview((next) => {
  if (!reviews.value.some(item => item.id === next.id))
    reviews.value = [...reviews.value, next]
}))
onScopeDispose(() => {
  for (const item of reviews.value)
    void api.discard(item.id).catch(() => {})
})

async function install(candidateIds: readonly string[]) {
  const current = review.value
  if (!current || busy.value)
    return
  busy.value = true
  error.value = null
  try {
    await api.install({ previewId: current.id, candidateIds })
    reviews.value = reviews.value.filter(item => item.id !== current.id)
    message.success(t('desktop.skills.installed'))
  }
  catch (reason) {
    error.value = resolveLocalChatErrorMessage(reason, language.value)
  }
  finally {
    busy.value = false
  }
}
</script>

<template>
  <DesktopSkillImport v-if="review" :key="review.id" :show="true" :language="language" :scope-label="scopeLabel" :preview="review" :busy="busy" :error="error" :origin="null" :update-name="review.candidates.find(candidate => candidate.replacesId)?.name ?? null" @discard="cancel" @install="install" />
</template>
