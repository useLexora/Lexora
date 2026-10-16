<script setup lang="ts">
import type { PluginRelease, Provider } from '@uselexora/lexora-contracts/community'
import type { FormInst } from 'naive-ui'
import { publisherInputSchema } from '@uselexora/lexora-contracts/community'
import { NAlert, NButton, NEmpty, NForm, NFormItem, NInput, NSkeleton, NTag } from 'naive-ui'
import { reactive, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import LoginPanel from '@/components/login-panel.vue'
import { useResource } from '@/composables/use-resource'
import { useSession } from '@/composables/use-session'
import { api, errorMessage } from '@/utils/axios'

const { t } = useI18n()
const { session, refresh, signIn } = useSession()
const form = ref<FormInst>()
const fields = reactive({ handle: '', displayName: '' })
const error = ref('')
const saved = ref(false)
const busy = ref(false)
const labels = { 'github': 'GitHub', 'google': 'Google', 'linux-do': 'LINUX DO' }
watch(() => session.value.user, (user) => {
  fields.handle = user?.publisher?.handle ?? ''
  fields.displayName = user?.publisher?.displayName ?? user?.name ?? ''
}, { immediate: true })
const releases = useResource(() => session.value.user?.id ?? '', async (id, signal) => id ? (await api.get<PluginRelease[]>('/publisher/releases', { signal })).data : [])
async function save() {
  saved.value = false
  error.value = ''
  if (!await form.value?.validate().then(() => true).catch(() => false))
    return
  if (!publisherInputSchema.safeParse(fields).success) {
    error.value = t('invalidInput')
    return
  }
  busy.value = true
  try {
    await api.post('/publisher', fields)
    await refresh()
    saved.value = true
  }
  catch (cause) {
    error.value = errorMessage(cause)
  }
  finally {
    busy.value = false
  }
}
async function link(provider: Provider) {
  error.value = ''
  try {
    await signIn(provider, true)
  }
  catch (cause) {
    error.value = errorMessage(cause)
  }
}
</script>

<template>
  <LoginPanel v-if="!session.user" />
  <div v-else class="form-page">
    <h1 class="mb-7">
      {{ t('account') }}
    </h1>
    <NAlert v-if="error" type="error" :title="error" :closable="false" class="mb-5" />
    <NAlert v-if="saved" type="success" :title="t('saved')" class="mb-5" />
    <section class="panel mb-6">
      <h2 class="mb-5">
        {{ t('identity') }}
      </h2>
      <NForm ref="form" :model="fields" label-placement="top" @submit.prevent="save">
        <NFormItem :label="t('handle')" path="handle" :label-props="{ for: 'publisher-handle' }" :rule="[{ required: true, pattern: /^[a-z0-9]+(?:-[a-z0-9]+)*$/, min: 3, max: 40, message: t('handleHint'), trigger: 'blur' }]">
          <NInput v-model:value="fields.handle" :input-props="{ id: 'publisher-handle' }" :disabled="!!session.user.publisher" maxlength="40" />
        </NFormItem>
        <p class="muted text-xs mb-5">
          {{ t('handleHint') }}
        </p>
        <NFormItem :label="t('displayName')" path="displayName" :label-props="{ for: 'publisher-name' }" :rule="[{ required: true, whitespace: true, max: 80, message: t('invalidInput'), trigger: 'blur' }]">
          <NInput v-model:value="fields.displayName" :input-props="{ id: 'publisher-name' }" maxlength="80" />
        </NFormItem>
        <NButton type="primary" attr-type="submit" :loading="busy">
          {{ t('save') }}
        </NButton>
      </NForm>
    </section>
    <section class="panel mb-6">
      <h2 class="mb-5">
        {{ t('accounts') }}
      </h2><div v-for="provider in session.providers" :key="provider" class="flex items-center justify-between py-3">
        <span>{{ labels[provider] }}</span><NTag v-if="session.user.accounts.some(account => account.provider === provider)" type="default">
          {{ t('linked') }}
        </NTag><NButton v-else @click="link(provider)">
          {{ t('link') }}
        </NButton>
      </div>
    </section>
    <section class="panel">
      <h2 class="mb-5">
        {{ t('myReleases') }}
      </h2>
      <NAlert v-if="releases.error.value" type="error" :closable="false">
        {{ releases.error.value }} <NButton text @click="releases.reload">
          {{ t('retry') }}
        </NButton>
      </NAlert>
      <NSkeleton v-else-if="releases.loading.value" :repeat="3" text />
      <NEmpty v-else-if="!releases.data.value?.length" :description="t('noReleases')" />
      <article v-for="release in releases.data.value" :key="release.id" class="py-4">
        <div class="flex flex-wrap justify-between gap-3">
          <span>{{ release.manifest.name }} · {{ release.manifest.version }}</span><NTag type="default">
            {{ t(release.status) }}
          </NTag>
        </div><p v-if="release.reviewReason" class="muted text-sm mt-2">
          {{ release.reviewReason }}
        </p>
      </article>
    </section>
  </div>
</template>
