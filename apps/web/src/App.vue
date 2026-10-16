<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { RouterLink, RouterView, useRoute } from 'vue-router'
import { useSession } from '@/composables/use-session'
import { useTheme } from '@/composables/use-theme'
import { errorMessage } from '@/utils/axios'

const { t, locale } = useI18n()
const { session, refresh, signOut } = useSession()
const { dark, toggle } = useTheme()
const route = useRoute()
const error = ref('')
watch(locale, (value) => {
  document.documentElement.lang = value
  localStorage.setItem('lexora.locale', value)
  document.title = `Lexora · ${t('community')}`
}, { immediate: true })
async function load() {
  try {
    await refresh()
    error.value = ''
  }
  catch (cause) {
    error.value = errorMessage(cause)
  }
}
async function logout() {
  try {
    await signOut()
  }
  catch (cause) {
    error.value = errorMessage(cause)
  }
}
onMounted(load)
</script>

<template>
  <header class="site-header">
    <div class="shell header-inner">
      <RouterLink to="/" class="brand" aria-label="Lexora Plugins">
        <img src="/favicon.png" alt="" width="34" height="34">
        <span>Lexora<span class="brand-section">Plugins</span></span>
      </RouterLink>
      <nav class="site-nav" :aria-label="t('community')">
        <RouterLink to="/" class="nav-explore">
          {{ t('explore') }}
        </RouterLink>
        <RouterLink to="/publish">
          {{ t('publish') }}
        </RouterLink>
        <RouterLink v-if="session.user?.admin" to="/reviews">
          {{ t('reviews') }}
        </RouterLink>
        <button class="icon-button" type="button" :aria-label="t('language')" @click="locale = locale === 'zh-CN' ? 'en-US' : 'zh-CN'">
          {{ locale === 'zh-CN' ? 'EN' : '中文' }}
        </button>
        <button class="icon-button theme-button" type="button" :aria-label="t('theme')" @click="toggle">
          {{ dark ? '☀' : '☾' }}
        </button>
        <RouterLink to="/account" class="button button-small">
          {{ session.user ? t('account') : t('login') }}
        </RouterLink>
        <button v-if="session.user" class="icon-button" type="button" @click="logout">
          {{ t('logout') }}
        </button>
      </nav>
    </div>
  </header>
  <main class="shell main-content">
    <div v-if="error && (session.user || ['/account', '/publish', '/reviews'].includes(route.path))" role="alert" class="notice mb-6">
      {{ error }} <button class="text-button" @click="load">
        {{ t('retry') }}
      </button>
    </div>
    <RouterView />
  </main>
  <footer class="shell site-footer">
    <span class="footer-brand">Lexora</span><span>{{ t('footer') }}</span>
    <a href="https://github.com/useLexora/plugins" target="_blank" rel="noopener noreferrer">GitHub</a>
  </footer>
</template>

<style scoped lang="scss">
.site-header { border-bottom: 1px solid var(--line); }
.header-inner { display: flex; align-items: center; justify-content: space-between; gap: 20px; min-height: 86px; }
.brand { display: flex; align-items: center; gap: 12px; white-space: nowrap; font-family: var(--display-font); font-size: 25px; font-weight: 650; letter-spacing: -.8px; }
.brand-section { margin-left: 10px; color: var(--muted); font-size: 16px; font-weight: 450; letter-spacing: 0; }
.site-nav { display: flex; align-items: center; gap: 24px; font-size: 13px; }
.site-nav > a:not(.button):hover { color: var(--accent); }
.main-content { flex: 1; padding-block: 40px 80px; }
.site-footer { display: flex; align-items: center; gap: 24px; padding-block: 28px; border-top: 1px solid var(--line); font-size: 12px; color: var(--muted); }
.site-footer > a { margin-left: auto; }
.footer-brand { font: 600 22px var(--display-font); color: var(--ink); }
@media (max-width: 700px) { .header-inner { flex-wrap: wrap; padding-block: 18px; gap: 16px; } .site-nav { gap: 16px; flex-wrap: wrap; } .brand-section { font-size: 14px; } .nav-explore { display: none; } .main-content { padding-block: 24px 48px; } .site-footer { flex-wrap: wrap; gap: 12px; } }
</style>
