<script setup lang="ts">
import type { BuddyCreate, LocalBuddy } from '@buddy-shared/buddies/buddyApi'
import { NAlert, NModal } from 'naive-ui'
import { computed, shallowRef } from 'vue'
import { useDesktopUi } from '@/shared/ui/desktopUiContext'
import { useBuddiesContext } from '../buddiesContext'
import { buddyLabels } from '../buddyLabels'
import BuddyProfileEditor from './BuddyProfileEditor.vue'

const props = defineProps<{ show: boolean, buddy?: LocalBuddy, initialKind?: LocalBuddy['kind'] }>()
const emit = defineEmits<{ 'update:show': [value: boolean], 'saved': [buddy: LocalBuddy] }>()
const { api, ready } = useBuddiesContext()
const { language } = useDesktopUi()
const labels = computed(() => buddyLabels(language.value))
const busy = shallowRef(false)

function save(input: BuddyCreate, original?: LocalBuddy) {
  return original
    ? api.update({ ...input, buddyId: original.id, expectedRevision: original.revision })
    : api.create(input)
}

async function reload() {
  return props.buddy ? api.get(props.buddy.id) : undefined
}

function saved(buddy: LocalBuddy) {
  busy.value = false
  emit('saved', buddy)
  emit('update:show', false)
}
</script>

<template>
  <NModal :show="show" preset="card" :title="buddy ? labels.edit : labels.add" :bordered="false" :mask-closable="false" :close-on-esc="!busy" :closable="!busy" class="buddy-profile-dialog w-[min(560px,calc(100vw-40px))] max-h-[calc(100dvh-40px)]" content-class="flex flex-col min-h-0 overflow-hidden !p-0" data-testid="buddy-profile-dialog" @update:show="emit('update:show', $event)">
    <NAlert v-if="buddy?.deletedAt" class="mx-6 mb-4" :show-icon="false">
      {{ labels.deleted }}
    </NAlert>
    <BuddyProfileEditor v-if="show" :buddy="buddy" :initial-kind="initialKind" :language="language" :disabled="!ready || !!buddy?.deletedAt" :save="save" :reload="reload" @busy="busy = $event" @saved="saved" @cancel="emit('update:show', false)" />
  </NModal>
</template>
