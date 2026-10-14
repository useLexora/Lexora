<script setup lang="ts">
import type { ChatAgentPanelGroup } from '../../model/transcript/chatAgentActivities'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { ChevronRight20Regular, ChevronUp20Regular, PanelRight20Regular } from '@vicons/fluent'
import { computed, shallowRef, useId, useTemplateRef } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'
import BuddyChatDisclosure from './BuddyChatDisclosure.vue'

const props = defineProps<{
  group: ChatAgentPanelGroup
  language: BuddyLocale
}>()

const { t } = useBuddyI18n(() => props.language)
const open = shallowRef(false)
const grouped = computed(() => props.group.nodes.length > 1)
const actorLabel = computed(() => t(props.group.actor === 'mixed'
  ? 'desktop.chat.panelActorMixed'
  : props.group.actor === 'harness' ? 'desktop.chat.panelActorSystem' : 'desktop.chat.panelActorUser'))
const header = useTemplateRef<HTMLButtonElement>('header')
const bodyId = useId()

function collapseFromBottom() {
  header.value?.focus({ preventScroll: true })
  header.value?.scrollIntoView({ block: 'nearest', behavior: 'instant' })
  open.value = false
}
</script>

<template>
  <section class="buddy-chat-panel-group min-w-0" :data-panel-id="group.id" :class="{ 'is-open': open, 'is-grouped': grouped }">
    <button v-if="grouped" ref="header" class="buddy-chat-panel-group__header buddy-chat-activity-row min-w-0" type="button" :aria-expanded="open" :aria-controls="bodyId" @click="open = !open">
      <DesktopIcon :component="PanelRight20Regular" class="buddy-chat-activity-row__icon" aria-hidden="true" />
      <span class="buddy-chat-activity-row__label">{{ actorLabel }} · {{ t('desktop.chat.panelOperationCount', { count: group.nodes.length }) }}</span>
      <DesktopIcon :component="ChevronRight20Regular" class="buddy-chat-activity-row__chevron" :class="{ 'is-open': open }" aria-hidden="true" />
    </button>
    <BuddyChatDisclosure>
      <div v-if="open || !grouped" :id="bodyId" class="buddy-chat-panel-group__content min-w-0">
        <p v-for="node in group.nodes" :key="node.id" class="flex items-center gap-[6px] my-[4px] mx-0 text-[length:var(--buddy-chat-meta-font-size)] leading-[var(--buddy-chat-meta-line-height)] text-[var(--buddy-chat-process-color)]" data-testid="context-panel-operation">
          <DesktopIcon :component="PanelRight20Regular" class="w-[16px] h-[16px] flex-none" aria-hidden="true" />
          <span>{{ t(node.actor === 'harness' ? 'desktop.chat.panelActorSystem' : 'desktop.chat.panelActorUser') }} · {{ t(node.action === 'open' ? 'desktop.chat.panelOpened' : 'desktop.chat.panelClosed') }}</span>
        </p>
        <button v-if="grouped && group.nodes.length > 8" class="buddy-chat-panel-group__collapse buddy-chat-activity-row flex mt-[4px] text-muted text-[length:var(--buddy-chat-caption-font-size)]" type="button" @click="collapseFromBottom">
          <DesktopIcon :component="ChevronUp20Regular" class="buddy-chat-activity-row__icon" aria-hidden="true" />
          {{ t('desktop.chat.activityCollapse') }}
        </button>
      </div>
    </BuddyChatDisclosure>
  </section>
</template>

<style scoped lang="scss">
@use './chatActivityRow' as activity;

@include activity.header;

.is-grouped > .buddy-chat-panel-group__content {
  margin-block: 4px;
  padding-inline-start: var(--buddy-chat-activity-indent);
}
</style>
