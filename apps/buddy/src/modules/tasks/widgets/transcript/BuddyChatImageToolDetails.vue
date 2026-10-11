<script setup lang="ts">
import type { BuddyToolPresentation } from '@buddy-shared/runs/runEventPresentation'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { computed } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'

const props = defineProps<{
  language: BuddyLocale
  presentation: Extract<BuddyToolPresentation, { card: 'image' }>
}>()

const { t } = useBuddyI18n(() => props.language)
const outputs = computed(() => props.presentation.artifactIds.map(artifactId => ({
  artifactId,
  url: `lexora-artifact://preview/${encodeURIComponent(artifactId)}`,
})))
const referenceLabel = computed(() => {
  const reference = props.presentation.reference
  if (!reference)
    return null
  return reference.mode === 'latest'
    ? t('desktop.chat.processToolImageReferenceLatest')
    : t('desktop.chat.processToolImageReferenceCount', {
        count: reference.resourceIds.length,
      })
})
</script>

<template>
  <div class="buddy-chat-image-tool-details grid gap-[var(--buddy-chat-gap-block)]">
    <section v-if="presentation.prompt" class="buddy-chat-image-tool-details__section min-w-0 overflow-hidden border-1 border-solid border-border rounded-micro bg-raised">
      <header>{{ t('desktop.chat.processToolInput') }}</header>
      <p>{{ presentation.prompt }}</p>
      <small v-if="referenceLabel">{{ referenceLabel }}</small>
    </section>
    <section v-if="outputs.length" class="buddy-chat-image-tool-details__section is-output min-w-0 overflow-hidden border-1 border-solid border-border rounded-micro bg-raised">
      <header>{{ t('desktop.chat.processToolOutput') }}</header>
      <figure
        v-for="output in outputs"
        :key="output.artifactId"
        class="buddy-chat-image-tool-details__output grid min-w-0 grid-cols-[5rem_minmax(0,_1fr)] items-center gap-3 m-0 py-[0.625rem] px-3"
      >
        <img
          :alt="t('desktop.chat.processToolImageOutput')"
          height="112"
          loading="lazy"
          :src="output.url"
          width="160"
        >
        <figcaption>
          <span>{{ t('desktop.chat.processToolImageAddress') }}</span>
          <code>{{ output.url }}</code>
        </figcaption>
      </figure>
    </section>
  </div>
</template>

<style scoped lang="scss">
.buddy-chat-image-tool-details__section {
  > header {
    min-height: 1.7rem;
    border-bottom: 1px solid var(--buddy-border-subtle);
    color: var(--buddy-chat-meta-color);
    font-size: var(--buddy-chat-caption-font-size);
    font-weight: 600;
    letter-spacing: 0.02em;
    padding: 0.25rem 0.625rem;
  }

  > p {
    margin: 0;
    color: var(--buddy-chat-code-color);
    font-size: var(--buddy-chat-code-font-size);
    line-height: var(--buddy-chat-code-line-height);
    overflow-wrap: anywhere;
    padding: 0.625rem 0.75rem 0.35rem;
    white-space: pre-wrap;
  }

  > small {
    display: block;
    color: var(--buddy-text-muted);
    font-size: var(--buddy-chat-caption-font-size);
    padding: 0 0.75rem 0.625rem;
  }

  &.is-output {
    background: var(--buddy-surface-subtle);
  }
}

.buddy-chat-image-tool-details__output {
  & + & {
    border-top: 1px solid var(--buddy-border-subtle);
  }

  img {
    display: block;
    width: 5rem;
    height: 3.5rem;
    border: 1px solid var(--buddy-border-subtle);
    border-radius: var(--buddy-radius-micro);
    object-fit: cover;
  }

  figcaption {
    display: grid;
    min-width: 0;
    gap: 0.2rem;
    color: var(--buddy-chat-meta-color);
    font-size: var(--buddy-chat-caption-font-size);
  }

  code {
    overflow: hidden;
    color: var(--buddy-chat-code-color);
    font-family: var(--buddy-font-mono);
    font-size: var(--buddy-chat-code-font-size);
    overflow-wrap: anywhere;
  }
}
</style>
