<script setup lang="ts">
import type { LocalArtifact } from '@buddy-shared/artifacts/artifactApi'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { ChevronRight20Regular, DocumentMultiple20Regular } from '@vicons/fluent'
import { shallowRef, useId } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import BuddyArtifactCollection from '@/modules/tasks/widgets/artifacts/BuddyArtifactCollection.vue'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'
import BuddyChatDisclosure from './BuddyChatDisclosure.vue'

const props = defineProps<{
  artifacts: ReadonlyArray<LocalArtifact>
  language: BuddyLocale
}>()
const emit = defineEmits<{
  openArtifact: [artifactId: string]
}>()

const { t } = useBuddyI18n(() => props.language)
const open = shallowRef(true)
const bodyId = useId()
</script>

<template>
  <section class="buddy-chat-turn-outputs grid w-full min-w-0 gap-[var(--buddy-chat-gap-tight)]" data-testid="chat-turn-outputs">
    <button
      class="buddy-chat-turn-outputs__heading buddy-chat-activity-row justify-self-start"
      type="button" :aria-expanded="open" :aria-controls="bodyId"
      @click="open = !open"
    >
      <DesktopIcon :component="DocumentMultiple20Regular" class="buddy-chat-activity-row__icon" aria-hidden="true" />
      <span>{{ t('desktop.chat.turnOutputs') }}</span>
      <span class="text-muted text-[length:var(--buddy-chat-caption-font-size)] tabular-nums">{{ artifacts.length }}</span>
      <DesktopIcon :component="ChevronRight20Regular" class="buddy-chat-activity-row__chevron" :class="{ 'is-open': open }" aria-hidden="true" />
    </button>
    <BuddyChatDisclosure>
      <BuddyArtifactCollection
        v-if="open" :id="bodyId"
        :artifacts="artifacts"
        :language="language"
        @open-artifact="emit('openArtifact', $event)"
      />
    </BuddyChatDisclosure>
  </section>
</template>

<style scoped lang="scss">
@use './chatActivityRow' as activity;

@include activity.header;
</style>
