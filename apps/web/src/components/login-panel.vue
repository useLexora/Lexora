<script setup lang="ts">
import type { Provider } from '@uselexora/lexora-contracts/community'
import { NAlert, NButton, NEmpty } from 'naive-ui'
import { ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useSession } from '@/composables/use-session'
import { errorMessage } from '@/utils/axios'

const { t } = useI18n()
const { session, signIn } = useSession()
const error = ref('')
const busy = ref<Provider>()
const labels = { 'github': 'GitHub', 'google': 'Google', 'linux-do': 'LINUX DO' }
async function login(provider: Provider) {
  busy.value = provider
  error.value = ''
  try {
    await signIn(provider)
  }
  catch (cause) {
    error.value = errorMessage(cause)
    busy.value = undefined
  }
}
</script>

<template>
  <section class="panel form-page">
    <h1>{{ t('loginTitle') }}</h1><p class="muted mt-3 mb-6">
      {{ t('loginHint') }}
    </p>
    <NAlert v-if="error" type="error" :title="error" :closable="false" class="mb-5" />
    <NEmpty v-if="!session.providers.length" :description="t('unavailable')" />
    <div v-else class="flex flex-wrap gap-3">
      <NButton v-for="provider in session.providers" :key="provider" :loading="busy === provider" :disabled="!!busy" @click="login(provider)">
        {{ labels[provider] }}
      </NButton>
    </div>
  </section>
</template>
