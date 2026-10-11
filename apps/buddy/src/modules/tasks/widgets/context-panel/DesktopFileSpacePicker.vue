<script setup lang="ts">
import type { LocalSpace } from '@buddy-shared/spaces/spaceApi'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { NModal } from 'naive-ui'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import DesktopSpaceIcon from '../space/DesktopSpaceIcon.vue'

const props = defineProps<{
  spaces: readonly LocalSpace[]
  language: BuddyLocale
}>()
const emit = defineEmits<{ select: [spaceId: string] }>()
const show = defineModel<boolean>('show', { required: true })
const { t } = useBuddyI18n(() => props.language)

function select(spaceId: string) {
  emit('select', spaceId)
  show.value = false
}
</script>

<template>
  <NModal
    v-model:show="show"
    preset="card"
    :style="{ width: 'min(28rem, calc(100vw - 2rem))' }"
    :content-style="{ padding: '0 16px 16px' }"
  >
    <template #header>
      {{ t('desktop.context.selectFileSpace') }}
    </template>
    <div class="desktop-file-space-picker grid max-h-[min(24rem,_60vh)] gap-1 overflow-y-auto" data-testid="file-space-picker">
      <button
        v-for="space in spaces"
        :key="space.id"
        class="desktop-file-space-picker__space flex min-w-0 items-center gap-3 border-0 rounded-icon bg-transparent py-[0.625rem] px-3 text-fg text-left cursor-pointer hover:bg-hover ui-focus-ring"
        type="button"
        @click="select(space.id)"
      >
        <DesktopSpaceIcon :icon="space.icon" :icon-color="space.iconColor" :size="20" />
        <span class="grid min-w-0 gap-[0.2rem] [overflow-wrap:anywhere]">
          <span>{{ space.name }}</span>
          <span class="text-muted text-[0.75rem]">{{ space.primaryDirectory?.root }}</span>
        </span>
      </button>
      <div v-if="!spaces.length" class="py-4 px-3 text-muted">
        {{ t('desktop.context.noFileSpaces') }}
      </div>
    </div>
  </NModal>
</template>
