<script setup lang="ts">
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { useBuddyI18n } from '@/i18n/buddyI18n'

const props = defineProps<{ language: BuddyLocale }>()
const { t } = useBuddyI18n(() => props.language)
const sites = [{ name: 'GitHub', description: 'desktop.web.githubReading' }] as const
</script>

<template>
  <section class="desktop-web-specialized grid gap-[0.65rem]">
    <header class="grid gap-[0.3rem]">
      <h3 class="m-0 text-[0.82rem] font-600">
        {{ t('desktop.web.specialized') }}
      </h3>
      <p>{{ t('desktop.web.specializedDescription') }}</p>
    </header>
    <ul class="desktop-web-specialized__list m-0 p-0 border-1 border-solid border-border rounded-[0.65rem]">
      <li v-for="site in sites" :key="site.name" class="desktop-web-specialized__site flex items-baseline flex-wrap py-[0.85rem] px-4">
        <strong>{{ site.name }}</strong>
        <span>{{ t(site.description) }}</span>
      </li>
    </ul>
  </section>
</template>

<style scoped lang="scss">
.desktop-web-specialized p, .desktop-web-specialized__site span { margin: 0; color: var(--buddy-text-secondary); font-size: 0.75rem; line-height: 1.65; }
.desktop-web-specialized__list { list-style: none; }
.desktop-web-specialized__site { gap: 0.3rem 1.25rem; }
.desktop-web-specialized__site strong { font-size: 0.8rem; font-weight: 500; }
</style>
