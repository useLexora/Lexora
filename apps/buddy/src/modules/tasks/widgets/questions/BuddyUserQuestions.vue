<script setup lang="ts">
import type { UserQuestionsController } from '../../state/runs/useUserQuestions'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { ChevronLeft16Regular, ChevronRight16Regular } from '@vicons/fluent'
import { NButton } from 'naive-ui'
import { computed } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'
import BuddyUserQuestionCard from './BuddyUserQuestionCard.vue'

const props = defineProps<{ controller: UserQuestionsController, language: BuddyLocale, compact?: boolean }>()
const emit = defineEmits<{ open: [] }>()
const { t } = useBuddyI18n(() => props.language)
const { pending, selected, drafts, expandedIds, selectedQuestionIds, resolvingIds, errors, loadError, ready } = props.controller
const selectedIndex = computed(() => pending.value.findIndex(request => request.id === selected.value?.id))
function navigate(offset: number) {
  const request = pending.value[(selectedIndex.value + offset + pending.value.length) % pending.value.length]
  if (request)
    props.controller.select(request.id)
}
</script>

<template>
  <section v-if="pending.length || loadError" class="buddy-user-questions flex min-h-0 min-w-0 flex-col gap-2" :aria-label="t('questions.toolLabel')">
    <p v-if="loadError" class="m-0 text-sm text-muted" role="status">
      {{ t('questions.loadFailed') }} <NButton text size="small" @click="controller.refresh()">
        {{ t('questions.retry') }}
      </NButton>
    </p>
    <BuddyUserQuestionCard
      v-if="selected"
      :key="selected.id"
      :request="selected"
      :answers="drafts.get(selected.id) ?? []"
      :question-id="selectedQuestionIds.get(selected.id)"
      :language="language"
      :expanded="!compact && expandedIds.has(selected.id)"
      :busy="resolvingIds.has(selected.id)"
      :error="errors.has(selected.id)"
      :ready="ready"
      @toggle="compact ? emit('open') : controller.toggleExpanded(selected.id)"
      @change="controller.updateAnswer(selected.id, $event)"
      @select-question="controller.selectQuestion(selected.id, $event)"
      @resolve="controller.resolve(selected.id, $event)"
    >
      <template v-if="pending.length > 1" #navigation>
        <div class="flex shrink-0 items-center gap-1 pr-2" data-testid="question-request-navigation">
          <NButton class="buddy-icon-button" quaternary size="tiny" :aria-label="t('questions.previousRequest')" @click="navigate(-1)">
            <template #icon>
              <DesktopIcon :component="ChevronLeft16Regular" :size="16" />
            </template>
          </NButton>
          <span class="whitespace-nowrap text-xs text-muted tabular-nums">{{ selectedIndex + 1 }} / {{ pending.length }}</span>
          <NButton class="buddy-icon-button" quaternary size="tiny" :aria-label="t('questions.nextRequest')" @click="navigate(1)">
            <template #icon>
              <DesktopIcon :component="ChevronRight16Regular" :size="16" />
            </template>
          </NButton>
        </div>
      </template>
    </BuddyUserQuestionCard>
  </section>
</template>
