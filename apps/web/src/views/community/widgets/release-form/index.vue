<script setup lang="ts">
import type { FormInst } from 'naive-ui'
import { releaseInputSchema } from '@uselexora/lexora-contracts/community'
import { NAlert, NButton, NEmpty, NForm, NFormItem, NInput, NInputNumber } from 'naive-ui'
import { reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { RouterLink } from 'vue-router'
import LoginPanel from '@/components/login-panel.vue'
import { useSession } from '@/composables/use-session'
import { api, errorMessage } from '@/utils/axios'

const { t } = useI18n()
const { session } = useSession()
const form = ref<FormInst>()
const fields = reactive({ manifest: '', repository: '', url: '', sha256: '', size: 1, notes: '' })
const busy = ref(false)
const error = ref('')
const success = ref(false)
async function submit() {
  error.value = ''
  success.value = false
  if (!await form.value?.validate().then(() => true).catch(() => false))
    return
  let input
  try {
    input = releaseInputSchema.parse({ manifest: JSON.parse(fields.manifest), repository: fields.repository, artifact: { url: fields.url, sha256: fields.sha256, size: fields.size }, notes: fields.notes })
  }
  catch {
    error.value = t('invalidInput')
    return
  }
  busy.value = true
  try {
    await api.post('/releases', input)
    success.value = true
  }
  catch (cause) {
    error.value = errorMessage(cause)
  }
  finally {
    busy.value = false
  }
}
</script>

<template>
  <LoginPanel v-if="!session.user" />
  <NEmpty v-else-if="!session.user.publisher" :description="t('publisherNeeded')">
    <RouterLink to="/account">
      <NButton type="primary">
        {{ t('identity') }}
      </NButton>
    </RouterLink>
  </NEmpty>
  <section v-else class="form-page">
    <h1>{{ t('publish') }}</h1><p class="muted mt-3 mb-7">
      {{ t('publishHint') }}
    </p>
    <NAlert v-if="error" type="error" :title="error" :closable="false" class="mb-5" />
    <NAlert v-if="success" type="success" :title="t('submitted')" :closable="false" class="mb-5" />
    <NForm ref="form" :model="fields" label-placement="top" class="panel" @submit.prevent="submit">
      <NFormItem :label="t('manifest')" path="manifest" :label-props="{ for: 'release-manifest' }" :rule="[{ required: true, message: t('missingManifest'), trigger: 'blur' }]">
        <NInput v-model:value="fields.manifest" :input-props="{ id: 'release-manifest' }" type="textarea" :autosize="{ minRows: 10, maxRows: 20 }" :placeholder="t('manifestHint')" maxlength="200000" />
      </NFormItem>
      <p class="muted text-xs mb-6">
        {{ t('namespaceHint') }}
      </p>
      <NFormItem :label="t('github')" path="repository" :label-props="{ for: 'release-repository' }" :rule="[{ required: true, pattern: /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/, message: t('invalidInput'), trigger: 'blur' }]">
        <NInput v-model:value="fields.repository" :input-props="{ id: 'release-repository' }" placeholder="https://github.com/owner/repository" />
      </NFormItem>
      <NFormItem :label="t('artifactUrl')" path="url" :label-props="{ for: 'release-url' }" :rule="[{ required: true, type: 'url', message: t('invalidInput'), trigger: 'blur' }]">
        <NInput v-model:value="fields.url" :input-props="{ id: 'release-url' }" />
      </NFormItem>
      <NFormItem :label="t('sha256')" path="sha256" :label-props="{ for: 'release-sha256' }" :rule="[{ required: true, pattern: /^[a-f0-9]{64}$/, message: t('invalidInput'), trigger: 'blur' }]">
        <NInput v-model:value="fields.sha256" :input-props="{ id: 'release-sha256' }" maxlength="64" />
      </NFormItem>
      <NFormItem :label="t('bytes')" path="size" :label-props="{ for: 'release-size' }">
        <NInputNumber v-model:value="fields.size" :input-props="{ id: 'release-size' }" :min="1" :max="16777216" :precision="0" />
      </NFormItem>
      <NFormItem :label="t('notes')">
        <NInput v-model:value="fields.notes" type="textarea" :autosize="{ minRows: 4 }" maxlength="4000" />
      </NFormItem>
      <NButton type="primary" attr-type="submit" :loading="busy" :disabled="success">
        {{ t('submit') }}
      </NButton>
    </NForm>
  </section>
</template>
