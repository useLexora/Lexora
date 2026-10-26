<script setup lang="ts">
import type { LocalExecutionDetail } from '@buddy-shared/executions/executionPresentationApi'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { computed } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'

const props = defineProps<{ work: NonNullable<LocalExecutionDetail['work']>, language: BuddyLocale, completed: boolean }>()
const { t } = useBuddyI18n(() => props.language)
const verdict = computed(() => props.work.review ? t(`desktop.executions.work.${props.work.review.verdict}`) : props.completed ? t('desktop.executions.work.pending') : null)
</script>

<template>
  <section class="grid min-w-0 grid-cols-1 gap-2 text-[12px]" data-testid="execution-work">
    <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-muted">
      <span v-if="work.previousRunId">{{ t('desktop.executions.work.continuation') }}</span>
      <span>{{ t(`desktop.executions.work.${work.contextMode}`) }}</span>
      <strong v-if="verdict" :class="work.review?.verdict === 'accepted' ? 'text-success' : 'text-muted'">{{ verdict }}</strong>
    </div>
    <div v-if="work.brief?.acceptance.length" class="grid grid-cols-1 gap-1">
      <strong class="text-fg">{{ t('desktop.executions.work.criteria') }}</strong>
      <ul class="m-0 pl-4 text-muted">
        <li v-for="(criterion, index) in work.brief.acceptance" :key="index" class="whitespace-pre-wrap">
          {{ criterion }}
        </li>
      </ul>
    </div>
    <div v-if="work.submission" class="grid grid-cols-1 gap-1">
      <strong class="text-fg">{{ t('desktop.executions.work.evidence') }}</strong>
      <p class="m-0 whitespace-pre-wrap text-muted">
        {{ work.submission.summary }}
      </p>
      <ul v-if="work.submission.evidence.length" class="m-0 pl-4 text-muted">
        <li v-for="(evidence, index) in work.submission.evidence" :key="index" class="whitespace-pre-wrap">
          {{ evidence }}
        </li>
      </ul>
      <template v-if="work.submission.limitations.length">
        <strong class="text-fg">{{ t('desktop.executions.work.limitations') }}</strong>
        <ul class="m-0 pl-4 text-muted">
          <li v-for="(limitation, index) in work.submission.limitations" :key="index" class="whitespace-pre-wrap">
            {{ limitation }}
          </li>
        </ul>
      </template>
    </div>
    <div v-if="work.review" class="grid grid-cols-1 gap-1 text-muted">
      <p class="m-0 whitespace-pre-wrap">
        {{ work.review.reason }}
      </p>
      <ul v-if="work.review.evidence.length" class="m-0 pl-4">
        <li v-for="(evidence, index) in work.review.evidence" :key="index" class="whitespace-pre-wrap">
          {{ evidence }}
        </li>
      </ul>
    </div>
  </section>
</template>
