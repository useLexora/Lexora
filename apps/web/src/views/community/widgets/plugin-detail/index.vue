<script setup lang="ts">
import type { PluginDetail } from '@uselexora/lexora-contracts/community'
import { useI18n } from 'vue-i18n'
import { RouterLink, useRoute } from 'vue-router'
import { useResource } from '@/composables/use-resource'
import { api } from '@/utils/axios'

const route = useRoute()
const { t } = useI18n()
const { data, loading, error, reload } = useResource(() => String(route.params.id), async (id, signal) => (await api.get<PluginDetail>(`/plugins/${encodeURIComponent(id)}`, { signal })).data)
</script>

<template>
  <RouterLink to="/" class="muted">
    ← {{ t('back') }}
  </RouterLink>
  <div v-if="loading" class="skeleton mt-8" role="status" :aria-label="t('loading')" />
  <div v-else-if="error" role="alert" class="notice mt-8">
    {{ error }} <button class="text-button" @click="reload">
      {{ t('retry') }}
    </button>
  </div>
  <template v-else-if="data">
    <div class="mt-8 mb-8">
      <h1>{{ data.release.manifest.name }}</h1><p class="muted mt-3">
        {{ data.release.manifest.description }}
      </p><p class="mt-3">
        {{ data.publisher.displayName }} <span class="muted">@{{ data.publisher.handle }}</span>
      </p>
    </div>
    <div class="detail-grid">
      <section class="panel">
        <h2>{{ t('history') }}</h2>
        <article v-for="release in data.releases" :key="release.id" class="release-entry">
          <div class="flex items-center justify-between gap-4">
            <h3>v{{ release.manifest.version }}</h3><time class="muted text-xs">{{ release.publishedAt?.slice(0, 10) }}</time>
          </div>
          <p class="prose mt-3">
            {{ release.notes || t('noNotes') }}
          </p>
        </article>
      </section>
      <aside class="panel self-start">
        <a :href="data.release.artifact.url" target="_blank" rel="noopener noreferrer" class="download-link">{{ t('download') }} ↗</a>
        <p class="muted text-xs mt-3 mb-6">
          {{ t('externalDownload') }}
        </p>
        <dl class="facts">
          <dt>{{ t('version') }}</dt><dd>{{ data.release.manifest.version }}</dd><dt>{{ t('size') }}</dt><dd>{{ (data.release.artifact.size / 1024 / 1024).toFixed(2) }} MB</dd><dt>{{ t('compatibility') }}</dt><dd>{{ data.release.manifest.engines.lexora }}</dd>
        </dl>
        <a :href="data.release.repository" target="_blank" rel="noopener noreferrer" class="block mt-6">{{ t('github') }} ↗</a>
        <div class="mt-6">
          <details>
            <summary>{{ t('sha256') }}</summary>
            <code class="checksum">{{ data.release.artifact.sha256 }}</code>
          </details><details>
            <summary>{{ t('reviewManifest') }}</summary>
            <pre class="prose">{{ JSON.stringify(data.release.manifest, null, 2) }}</pre>
          </details>
        </div>
      </aside>
    </div>
  </template>
</template>

<style scoped lang="scss">
.detail-grid { display: grid; grid-template-columns: minmax(0, 1fr) 320px; gap: 24px; }
.release-entry { padding-top: 24px; margin-top: 24px; border-top: 1px solid var(--line); }
.facts { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin: 0; font-size: 13px; }
.facts dt { color: var(--muted); }.facts dd { margin: 0; text-align: right; overflow-wrap: anywhere; }
.download-link { display: block; text-align: center; padding: 10px; border-radius: 6px; color: var(--canvas); background: var(--accent); font-weight: 500; }
.checksum { overflow-wrap: anywhere; font-size: 12px; }
@media (max-width: 760px) { .detail-grid { grid-template-columns: 1fr; } aside { grid-row: 1; } }
details { border-top: 1px solid var(--line); padding-block: 14px; }
summary { cursor: pointer; margin-bottom: 10px; }
</style>
