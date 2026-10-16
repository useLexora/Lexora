<script setup lang="ts">
import type { PublicationHomePageProps } from './typing'
import { normalizePublicationHref } from '@haohaoxue/lexora-shared/document'
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'

const props = defineProps<PublicationHomePageProps>()
const router = useRouter()
const { t } = useI18n()
const featureGridClass = computed(() => {
  const length = props.home.features.length

  if (length === 2) {
    return 'publication-home-page__features--grid-2'
  }

  if (length === 3) {
    return 'publication-home-page__features--grid-3'
  }

  if (length > 3 && length % 3 === 0) {
    return 'publication-home-page__features--grid-6'
  }

  if (length > 3) {
    return 'publication-home-page__features--grid-4'
  }

  return null
})

function handleActionClick(href: string, event: MouseEvent) {
  const safeHref = normalizePublicationHref(href)

  if (!safeHref) {
    event.preventDefault()
    return
  }

  if (
    event.metaKey
    || event.ctrlKey
    || event.shiftKey
    || event.altKey
    || event.button !== 0
    || !safeHref.startsWith('/')
  ) {
    return
  }

  event.preventDefault()
  void router.push(safeHref)
}

function resolveActionHref(href: string) {
  return normalizePublicationHref(href) ?? undefined
}

function isMediaIconSource(value: string | null | undefined) {
  const source = value?.trim() ?? ''

  return source.startsWith('/') || /^https?:\/\//i.test(source)
}
</script>

<template>
  <main class="publication-home-page">
    <section
      class="publication-home-page__hero"
      :class="{ 'publication-home-page__hero--has-image': props.home.hero.imageUrl || props.site.logoUrl }"
    >
      <div class="publication-home-page__hero-container">
        <div class="publication-home-page__hero-copy">
          <h1 class="publication-home-page__heading">
            <span v-if="props.home.hero.name" class="publication-home-page__name">
              {{ props.home.hero.name }}
            </span>
            <span class="publication-home-page__text">
              {{ props.home.hero.text || props.site.title }}
            </span>
          </h1>

          <p v-if="props.home.hero.tagline || props.site.description" class="publication-home-page__tagline">
            {{ props.home.hero.tagline || props.site.description }}
          </p>

          <div v-if="props.home.actions.length" class="publication-home-page__actions">
            <a
              v-for="action in props.home.actions"
              :key="`${action.label}-${action.href}`"
              class="publication-home-page__action"
              :class="`is-${action.theme}`"
              :href="resolveActionHref(action.href)"
              @click="handleActionClick(action.href, $event)"
            >
              {{ action.label }}
            </a>
          </div>
        </div>

        <div v-if="props.home.hero.imageUrl || props.site.logoUrl" class="publication-home-page__visual">
          <div class="publication-home-page__image-container">
            <div class="publication-home-page__image-bg" aria-hidden="true" />
            <img
              class="publication-home-page__hero-image"
              :src="props.home.hero.imageUrl || props.site.logoUrl || ''"
              alt=""
            >
          </div>
        </div>
      </div>
    </section>

    <section
      v-if="props.home.features.length"
      class="publication-home-page__features"
      :aria-label="t('docs.publicReader.features')"
    >
      <div class="publication-home-page__features-container">
        <div class="publication-home-page__features-items">
          <div
            v-for="feature in props.home.features"
            :key="feature.title"
            class="publication-home-page__feature-item"
            :class="featureGridClass"
          >
            <article class="publication-home-page__feature">
              <span v-if="feature.icon" class="publication-home-page__feature-icon">
                <img
                  v-if="isMediaIconSource(feature.icon)"
                  :src="feature.icon"
                  alt=""
                >
                <span v-else>{{ feature.icon }}</span>
              </span>
              <h2 class="publication-home-page__feature-title">
                {{ feature.title }}
              </h2>
              <p v-if="feature.details" class="publication-home-page__feature-details">
                {{ feature.details }}
              </p>
            </article>
          </div>
        </div>
      </div>
    </section>

    <footer
      v-if="props.home.footer.message || props.home.footer.copyright"
      class="publication-home-page__footer"
    >
      <p v-if="props.home.footer.message" class="publication-home-page__footer-text">
        {{ props.home.footer.message }}
      </p>
      <p v-if="props.home.footer.copyright" class="publication-home-page__footer-text">
        {{ props.home.footer.copyright }}
      </p>
    </footer>
  </main>
</template>

<style scoped lang="scss">
.publication-home-page {
  display: flex;
  min-height: calc(100vh - var(--publication-nav-height));
  flex-direction: column;
}

.publication-home-page__hero {
  margin-top: calc(var(--publication-nav-height) * -1);
  padding: calc(var(--publication-nav-height) + 3rem) 1.5rem 3rem;
}

.publication-home-page__hero-container {
  display: flex;
  flex-direction: column;
  max-width: 72rem;
  margin: 0 auto;
}

.publication-home-page__hero-copy {
  position: relative;
  z-index: 1;
  order: 2;
  min-width: 0;
}

.publication-home-page__hero--has-image .publication-home-page__hero-container {
  text-align: center;
}

.publication-home-page__heading {
  display: flex;
  flex-direction: column;
  margin: 0;
}

.publication-home-page__name,
.publication-home-page__text {
  width: fit-content;
  max-width: 24.5rem;
  color: var(--publication-c-text-1);
  font-size: 2rem;
  font-weight: 700;
  letter-spacing: 0;
  line-height: 2.5rem;
  white-space: pre-wrap;
}

.publication-home-page__name {
  background: linear-gradient(120deg, #bd34fe 30%, #41d1ff);
  background-clip: text;
  color: transparent;
  -webkit-text-fill-color: transparent;
}

.publication-home-page__hero--has-image {
  .publication-home-page__name,
  .publication-home-page__text {
    margin: 0 auto;
  }
}

.publication-home-page__tagline {
  max-width: 24.5rem;
  margin: 0;
  padding-top: 0.5rem;
  color: var(--publication-c-text-2);
  font-size: 1.125rem;
  font-weight: 500;
  line-height: 1.75rem;
  white-space: pre-wrap;
}

.publication-home-page__hero--has-image .publication-home-page__tagline {
  margin: 0 auto;
}

.publication-home-page__actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem;
  padding-top: 1.5rem;
}

.publication-home-page__hero--has-image .publication-home-page__actions {
  justify-content: center;
}

.publication-home-page__action {
  display: inline-flex;
  min-height: 2.5rem;
  align-items: center;
  justify-content: center;
  border-radius: 0.75rem;
  padding: 0 1.125rem;
  font-size: 0.875rem;
  font-weight: 600;
  line-height: 1.5;
  text-decoration: none;

  &.is-brand {
    background: var(--publication-c-brand-1);
    color: var(--publication-c-bg);
  }

  &.is-alt {
    background: var(--publication-c-bg-soft);
    color: var(--publication-c-text-1);
  }

  &:hover,
  &:focus-visible {
    color: var(--publication-c-brand-1);
  }

  &.is-brand:hover,
  &.is-brand:focus-visible {
    background: var(--publication-c-brand-2);
    color: var(--publication-c-bg);
  }
}

.publication-home-page__visual {
  order: 1;
  margin: -4.75rem -1.5rem -3rem;
}

.publication-home-page__image-container {
  position: relative;
  width: 20rem;
  height: 20rem;
  margin: 0 auto;
}

.publication-home-page__image-bg {
  position: absolute;
  top: 50%;
  left: 50%;
  z-index: 0;
  width: 12rem;
  height: 12rem;
  border-radius: 50%;
  background-image: linear-gradient(
    -45deg,
    color-mix(in srgb, var(--publication-c-brand-1) 52%, #bd34fe) 50%,
    color-mix(in srgb, var(--publication-c-brand-2) 54%, #47caff) 50%
  );
  filter: blur(44px);
  opacity: 0.88;
  pointer-events: none;
  transform: translate(-50%, -50%);
}

.publication-home-page__hero-image {
  position: absolute;
  top: 50%;
  left: 50%;
  z-index: 1;
  width: 100%;
  height: 100%;
  max-width: 12rem;
  max-height: 12rem;
  filter: drop-shadow(-2px 4px 6px rgb(0 0 0 / 20%));
  object-fit: contain;
  transform: translate(-50%, -50%);
}

.publication-home-page__features {
  padding: 0 1.5rem;
  position: relative;
}

.publication-home-page__features-container {
  max-width: 72rem;
  margin: 0 auto;
}

.publication-home-page__features-items {
  display: flex;
  flex-wrap: wrap;
  margin: -0.5rem;
}

.publication-home-page__feature-item {
  width: 100%;
  padding: 0.5rem;
}

.publication-home-page__feature {
  min-width: 0;
  height: 100%;
  padding: 1.5rem;
  border: 1px solid var(--publication-c-bg-soft);
  border-radius: 0.75rem;
  background: var(--publication-c-bg-soft);
}

.publication-home-page__feature-icon {
  display: inline-flex;
  width: 3rem;
  height: 3rem;
  align-items: center;
  justify-content: center;
  margin-bottom: 1.25rem;
  border-radius: 0.375rem;
  background: var(--publication-c-brand-soft);
  font-size: 1.5rem;

  img {
    display: block;
    max-width: calc(100% - 0.75rem);
    max-height: calc(100% - 0.75rem);
    object-fit: contain;
  }
}

.publication-home-page__feature-title {
  margin: 0;
  color: var(--publication-c-text-1);
  font-size: 1rem;
  font-weight: 600;
  line-height: 1.5rem;
}

.publication-home-page__feature-details {
  margin: 0;
  padding-top: 0.5rem;
  color: var(--publication-c-text-2);
  font-size: 0.875rem;
  font-weight: 500;
  line-height: 1.5rem;
}

.publication-home-page__footer {
  display: grid;
  gap: 0.25rem;
  margin-top: auto;
  padding: 1.75rem 1rem;
  border-top: 1px solid var(--publication-c-gutter);
  color: var(--publication-c-text-3);
  text-align: center;
}

.publication-home-page__footer-text {
  margin: 0;
  font-size: 0.8125rem;
  line-height: 1.625;
}

@media (min-width: 640px) {
  .publication-home-page__hero {
    padding: calc(var(--publication-nav-height) + 5rem) 3rem 4rem;
  }

  .publication-home-page__name,
  .publication-home-page__text {
    max-width: 36rem;
    font-size: 3rem;
    line-height: 3.5rem;
  }

  .publication-home-page__tagline {
    max-width: 36rem;
    padding-top: 0.75rem;
    font-size: 1.25rem;
    line-height: 2rem;
  }

  .publication-home-page__actions {
    padding-top: 2rem;
  }

  .publication-home-page__visual {
    margin: -6.75rem -1.5rem -3rem;
  }

  .publication-home-page__image-container {
    width: 24.5rem;
    height: 24.5rem;
  }

  .publication-home-page__image-bg {
    width: 16rem;
    height: 16rem;
    filter: blur(56px);
  }

  .publication-home-page__hero-image {
    max-width: 16rem;
    max-height: 16rem;
  }

  .publication-home-page__features {
    padding: 0 3rem;
  }

  .publication-home-page__feature-item.publication-home-page__features--grid-2,
  .publication-home-page__feature-item.publication-home-page__features--grid-4,
  .publication-home-page__feature-item.publication-home-page__features--grid-6 {
    width: calc(100% / 2);
  }
}

@media (min-width: 768px) {
  .publication-home-page__feature-item.publication-home-page__features--grid-2,
  .publication-home-page__feature-item.publication-home-page__features--grid-4 {
    width: calc(100% / 2);
  }

  .publication-home-page__feature-item.publication-home-page__features--grid-3,
  .publication-home-page__feature-item.publication-home-page__features--grid-6 {
    width: calc(100% / 3);
  }
}

@media (min-width: 960px) {
  .publication-home-page__hero {
    padding: calc(var(--publication-nav-height) + 5rem) 4rem 4rem;
  }

  .publication-home-page__hero-container {
    flex-direction: row;
  }

  .publication-home-page__hero-copy {
    order: 1;
    flex-grow: 1;
    flex-shrink: 0;
    width: calc((100% / 3) * 2);
  }

  .publication-home-page__hero--has-image {
    .publication-home-page__hero-container {
      text-align: left;
    }

    .publication-home-page__hero-copy {
      max-width: 37rem;
    }

    .publication-home-page__name,
    .publication-home-page__text,
    .publication-home-page__tagline {
      margin: 0;
    }

    .publication-home-page__actions {
      justify-content: flex-start;
    }
  }

  .publication-home-page__name,
  .publication-home-page__text {
    font-size: 3.5rem;
    line-height: 4rem;
  }

  .publication-home-page__tagline {
    font-size: 1.5rem;
    line-height: 2.25rem;
  }

  .publication-home-page__visual {
    order: 2;
    flex-grow: 1;
    min-height: 100%;
    margin: 0;
  }

  .publication-home-page__image-container {
    display: flex;
    width: 100%;
    height: 100%;
    align-items: center;
    justify-content: center;
    transform: translate(-2rem, -2rem);
  }

  .publication-home-page__hero-image {
    max-width: 20rem;
    max-height: 20rem;
  }

  .publication-home-page__image-bg {
    width: 20rem;
    height: 20rem;
    filter: blur(68px);
  }

  .publication-home-page__features {
    padding: 0 4rem;
  }

  .publication-home-page__feature-item.publication-home-page__features--grid-4 {
    width: calc(100% / 4);
  }
}
</style>
