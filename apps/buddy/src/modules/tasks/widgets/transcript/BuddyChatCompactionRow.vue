<script setup lang="ts">
import type { ChatCompactionDisplayNode } from '../../model/transcript/chatCompactionDisplay'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { ArrowSync20Regular } from '@vicons/fluent'
import { computed } from 'vue'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'
import { describeChatCompaction } from '../../model/transcript/chatCompactionDisplay'
import BuddyChatActivityStatus from './BuddyChatActivityStatus.vue'

const props = defineProps<{
  language: BuddyLocale
  node: ChatCompactionDisplayNode
}>()
const display = computed(() => describeChatCompaction(props.node, props.language))
</script>

<template>
  <BuddyChatActivityStatus
    class="buddy-chat-compaction" :data-compaction-id="node.id"
    :label="display.label" :active="display.active" :detail="display.detail" :warning="display.warning"
  >
    <template #icon>
      <DesktopIcon :component="ArrowSync20Regular" class="buddy-chat-activity-row__icon" aria-hidden="true" />
    </template>
  </BuddyChatActivityStatus>
</template>

<style scoped lang="scss">
@use './chatActivityRow' as activity;

.buddy-chat-activity-row__icon { @include activity.icon; }
</style>
