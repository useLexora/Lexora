<script setup lang="ts">
import type { LocalBuddy } from '@buddy-shared/buddies/buddyApi'
import type { BuddyProfileFormOptions } from '../state/useBuddyProfileForm'
import { NButton, NInput } from 'naive-ui'
import { computed, useId, watch } from 'vue'
import DesktopSegmentedControl from '@/shared/ui/segmented-control/DesktopSegmentedControl.vue'
import { buddyLabels } from '../buddyLabels'
import { useBuddyProfileForm } from '../state/useBuddyProfileForm'
import BuddyAvatarPicker from './BuddyAvatarPicker.vue'

const props = defineProps<BuddyProfileFormOptions & { language: string }>()
const emit = defineEmits<{ saved: [buddy: LocalBuddy], busy: [value: boolean], cancel: [] }>()
const labels = computed(() => buddyLabels(props.language))
const id = useId()
const { kind, name, description, avatar, customAvatar, busy, reading, error, disabled, canSave, selectAvatar, uploadAvatar, reload, save } = useBuddyProfileForm(props, buddy => emit('saved', buddy))
const kindOptions = computed(() => [{ value: 'actor' as const, label: labels.value.actor }, { value: 'npc' as const, label: labels.value.npc }])
const kindHint = computed(() => kind.value === 'actor' ? labels.value.actorHint : labels.value.npcHint)

watch(() => busy.value || reading.value, value => emit('busy', value), { flush: 'sync' })
</script>

<template>
  <form class="flex min-h-0 w-full flex-1 flex-col" @submit.prevent="save">
    <div class="flex min-h-0 flex-col gap-5 overflow-y-auto px-6 pb-6">
      <div v-if="!buddy" class="flex flex-col gap-2">
        <div class="flex flex-wrap items-center justify-between gap-3">
          <span class="text-[13px] font-600 text-fg">{{ labels.kind }}</span>
          <DesktopSegmentedControl v-model="kind" :options="kindOptions" :disabled="disabled" />
        </div>
        <p class="m-0 text-[13px] leading-relaxed text-muted">
          {{ kindHint }}
        </p>
      </div>
      <div>
        <BuddyAvatarPicker :kind="kind" :buddy-id="buddy?.id" :avatar="avatar" :custom-avatar="customAvatar" :language="language" :disabled="disabled" @select="selectAvatar" @upload="uploadAvatar" />
        <p v-if="error === 'invalidImage'" class="m-0 mt-2 text-[13px] leading-relaxed text-danger" role="alert">
          {{ labels.invalidImage }}
        </p>
      </div>
      <div class="flex flex-col gap-2">
        <label :for="`${id}-name`" class="text-[13px] font-600 text-fg">{{ labels.name }}</label>
        <NInput v-model:value="name" :input-props="{ id: `${id}-name` }" :placeholder="labels.nameHint" :maxlength="80" :disabled="disabled" show-count />
      </div>
      <div class="flex flex-col gap-2">
        <div class="flex items-center gap-2">
          <label :for="`${id}-description`" class="text-[13px] font-600 text-fg">{{ labels.description }}</label>
          <span class="text-[12px] text-muted">{{ labels.optional }}</span>
        </div>
        <NInput v-model:value="description" :input-props="{ id: `${id}-description` }" type="textarea" :placeholder="labels.descriptionHint" :maxlength="500" :autosize="{ minRows: 2, maxRows: 4 }" :disabled="disabled" show-count />
      </div>
    </div>
    <footer class="flex shrink-0 flex-wrap items-center justify-end gap-2 border-t-1 border-t-solid border-t-border px-6 py-4">
      <p v-if="error && error !== 'invalidImage'" class="m-0 mb-2 w-full text-danger text-[13px] leading-relaxed" role="alert">
        {{ labels[error] }}
      </p>
      <NButton v-if="error === 'conflict'" :disabled="disabled" @click="reload">
        {{ labels.reload }}
      </NButton>
      <NButton :disabled="busy || reading" @click="emit('cancel')">
        {{ labels.cancel }}
      </NButton>
      <NButton attr-type="submit" type="primary" :loading="busy" :disabled="!canSave">
        {{ buddy ? labels.save : labels.create }}
      </NButton>
    </footer>
  </form>
</template>
