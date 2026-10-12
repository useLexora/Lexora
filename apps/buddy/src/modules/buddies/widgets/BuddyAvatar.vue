<script setup lang="ts">
import { BUILTIN_BUDDY_ID } from '@buddy-shared/buddies/buddyApi'
import { computed, shallowRef, watch } from 'vue'
import { BRAND_ASSET_URLS } from '@/shared/branding/brandAssets'
import fallback from '../assets/avatars/npc-slate.webp'
import { buddyNpcDefaultAvatar } from '../model/buddyDefaultAvatars'

const props = defineProps<{ src?: string | null, buddyId?: string }>()
const failed = shallowRef(false)
const defaultFailed = shallowRef(false)
const source = computed(() => {
  if (!failed.value && props.src)
    return props.src
  if (defaultFailed.value)
    return fallback
  return props.buddyId === BUILTIN_BUDDY_ID ? BRAND_ASSET_URLS.chatAvatar : buddyNpcDefaultAvatar(props.buddyId)
})
watch(() => [props.src, props.buddyId], () => {
  failed.value = false
  defaultFailed.value = false
})
function onError() {
  if (props.src && !failed.value)
    failed.value = true
  else
    defaultFailed.value = true
}
</script>

<template>
  <img :src="source" alt="" class="shrink-0 rounded-full object-cover" draggable="false" @error="onError">
</template>
