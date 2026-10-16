<script setup lang="ts">
import type { PluginRelease, Publisher } from '@uselexora/lexora-contracts/community'
import { NAlert, NButton, NCollapse, NCollapseItem, NEmpty, NInput, NSkeleton } from 'naive-ui'
import { reactive, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import LoginPanel from '@/components/login-panel.vue'
import { useResource } from '@/composables/use-resource'
import { useSession } from '@/composables/use-session'
import { api, errorMessage } from '@/utils/axios'

const { t } = useI18n()
const { session } = useSession()
const reasons = reactive<Record<string, string>>({})
const busy = ref('')
const actionError = ref('')
const { data, error, loading, reload } = useResource(() => session.value.user?.admin ? session.value.user.id : '', async (id, signal) => id ? (await api.get<(PluginRelease & { publisher: Publisher })[]>('/reviews', { signal })).data : [])
async function review(id: string, action: 'publish' | 'reject') {
  actionError.value = ''
  if (!reasons[id]?.trim()) {
    actionError.value = t('invalidInput')
    return
  }
  busy.value = id
  try {
    await api.post(`/reviews/${id}`, { action, reason: reasons[id].trim() })
    reload()
  }
  catch (cause) {
    actionError.value = errorMessage(cause)
  }
  finally {
    busy.value = ''
  }
}
</script>

<template>
  <LoginPanel v-if="!session.user" />
  <NEmpty v-else-if="!session.user.admin" :description="t('adminRequired')" />
  <section v-else class="form-page">
    <h1>{{ t('reviews') }}</h1><p class="muted mt-3 mb-7">
      {{ t('reviewHint') }}
    </p>
    <NAlert v-if="error || actionError" type="error" :closable="false" class="mb-6">
      {{ error || actionError }} <NButton text @click="reload">
        {{ t('retry') }}
      </NButton>
    </NAlert>
    <NSkeleton v-if="loading" :repeat="5" text />
    <NEmpty v-else-if="!data?.length" :description="t('noReviews')" />
    <article v-for="release in data" :key="release.id" class="panel mb-6">
      <h2>{{ release.manifest.name }} · {{ release.manifest.version }}</h2><p class="muted mt-2">
        @{{ release.publisher.handle }} · {{ release.manifest.id }}
      </p>
      <div class="flex flex-wrap gap-5 my-5">
        <a :href="release.repository" target="_blank" rel="noopener noreferrer">{{ t('github') }} ↗</a><a :href="release.artifact.url" target="_blank" rel="noopener noreferrer">{{ t('download') }} ↗</a>
      </div>
      <p class="prose text-xs">
        SHA-256: {{ release.artifact.sha256 }}<br>{{ t('bytes') }}: {{ release.artifact.size }}
      </p>
      <NCollapse class="my-5">
        <NCollapseItem :title="t('reviewManifest')" name="manifest">
          <pre class="prose">{{ JSON.stringify(release.manifest, null, 2) }}</pre>
        </NCollapseItem>
      </NCollapse>
      <NInput v-model:value="reasons[release.id]" type="textarea" :autosize="{ minRows: 2 }" :input-props="{ 'aria-label': t('reason') }" :placeholder="t('reason')" maxlength="1000" />
      <div class="mt-5 flex gap-3">
        <NButton type="primary" :loading="busy === release.id" :disabled="!!busy" @click="review(release.id, 'publish')">
          {{ t('approve') }}
        </NButton><NButton :disabled="!!busy" @click="review(release.id, 'reject')">
          {{ t('reject') }}
        </NButton>
      </div>
    </article>
  </section>
</template>
