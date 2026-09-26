<script setup lang="ts">
import { extensionAuthorSchema } from '@buddy-shared/extensions/extensionIdentity'
import { NButton, NInput } from 'naive-ui'
import { computed, shallowRef } from 'vue'

const props = defineProps<{ author: string, language: string, save: (author: string) => Promise<boolean> }>()
const emit = defineEmits<{ saved: [] }>()
const author = shallowRef(props.author)
const saving = shallowRef(false)
const failed = shallowRef(false)
const en = computed(() => props.language === 'en-US')
const valid = computed(() => extensionAuthorSchema.safeParse(author.value.trim()).success)
async function save() {
  if (!valid.value || saving.value)
    return
  saving.value = true
  try {
    failed.value = !await props.save(author.value.trim())
    if (!failed.value)
      emit('saved')
  }
  catch { failed.value = true }
  finally { saving.value = false }
}
</script>

<template>
  <form class="extension-authoring-settings" @submit.prevent="save">
    <label for="plugin-author">{{ en ? 'Default author signature' : '默认作者署名' }}</label>
    <NInput v-model:value="author" :input-props="{ id: 'plugin-author' }" :status="valid ? undefined : 'error'" :placeholder="en ? 'Optional' : '可选，留空表示未署名'" :disabled="saving" />
    <p>{{ en ? 'Used for new plugins. Each plugin can have its own signature; existing plugins keep theirs.' : '用于新建插件。每个插件可以单独署名，已有插件的署名保持不变。' }}</p>
    <p v-if="!valid" role="alert">
      {{ en ? 'Use a single line of at most 80 characters, without control characters.' : '请使用不超过 80 个字符的单行署名，不含控制字符。' }}
    </p>
    <p v-if="failed" role="alert">
      {{ en ? 'Could not save. Try again.' : '保存失败，请重试。' }}
    </p>
    <NButton attr-type="submit" type="primary" :disabled="!valid" :loading="saving">
      {{ en ? 'Save' : '保存' }}
    </NButton>
  </form>
</template>

<style scoped>
.extension-authoring-settings { display: grid; gap: 12px; }
.extension-authoring-settings p { margin: 0; color: var(--buddy-text-secondary); line-height: 1.6; }
.extension-authoring-settings [role=alert] { color: var(--buddy-status-danger-text); }
.extension-authoring-settings :deep(.n-button) { justify-self: end; }
</style>
