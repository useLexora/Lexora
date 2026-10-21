<script setup lang="ts">
import type { LocalSpace } from '@buddy-shared/spaces/spaceApi'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { getActiveSpaceDirectories } from '@buddy-shared/spaces/spaceApi'
import { NModal } from 'naive-ui'
import { computed } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import DesktopSpaceIcon from '../space/DesktopSpaceIcon.vue'

const props = defineProps<{
  spaces: readonly LocalSpace[]
  language: BuddyLocale
}>()
const emit = defineEmits<{ select: [spaceId: string, directoryId: string] }>()
const show = defineModel<boolean>('show', { required: true })
const { t } = useBuddyI18n(() => props.language)

const directories = computed(() => props.spaces.flatMap(space => getActiveSpaceDirectories(space).map(directory => ({ space, directory }))))

function select(spaceId: string, directoryId: string) {
  emit('select', spaceId, directoryId)
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
        v-for="{ space, directory } in directories"
        :key="directory.id"
        class="desktop-file-space-picker__space flex min-w-0 items-center gap-3 border-0 rounded-icon bg-transparent py-[0.625rem] px-3 text-fg text-left cursor-pointer hover:bg-hover ui-focus-ring"
        type="button"
        @click="select(space.id, directory.id)"
      >
        <DesktopSpaceIcon :icon="space.icon" :icon-color="space.iconColor" :size="20" />
        <span class="grid min-w-0 gap-[0.2rem] [overflow-wrap:anywhere]">
          <span>{{ space.name }}</span>
          <span class="text-muted text-[0.75rem]">{{ directory.root }}</span>
        </span>
      </button>
      <div v-if="!directories.length" class="py-4 px-3 text-muted">
        {{ t('desktop.context.noFileSpaces') }}
      </div>
    </div>
  </NModal>
</template>
