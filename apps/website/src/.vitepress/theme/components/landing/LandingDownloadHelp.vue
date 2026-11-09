<script setup lang="ts">
import type { LandingContent } from './landingContent'
import type { DownloadSelection } from './landingDownloads'
import { computed, useId, useTemplateRef } from 'vue'
import LandingIcon from './LandingIcon.vue'

const props = defineProps<{
  download: DownloadSelection
  content: LandingContent['hero']['downloadMenu']['help']
}>()

const dialog = useTemplateRef<HTMLDialogElement>('dialog')
const id = useId()
const proxyHosts = ['ghfast.top', 'gh-proxy.com', 'gh.monlor.com']
const proxies = computed(() => proxyHosts.map(host => ({ name: host, url: `https://${host}/${props.download.url}` })))

function closeBackdrop(event: MouseEvent) {
  if (event.target !== dialog.value || !dialog.value)
    return

  const bounds = dialog.value.getBoundingClientRect()
  if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom)
    dialog.value.close()
}
</script>

<template>
  <div class="download-help">
    <button type="button" class="help-trigger" aria-haspopup="dialog" @click="dialog?.showModal()">
      {{ content.trigger }}
      <LandingIcon name="arrow" />
    </button>
    <dialog
      ref="dialog"
      class="proxy-dialog"
      :aria-labelledby="`${id}-title`"
      :aria-describedby="`${id}-description`"
      @click="closeBackdrop"
    >
      <div class="proxy-body">
        <header class="proxy-header">
          <h2 :id="`${id}-title`" class="proxy-title">
            {{ content.title }}
          </h2>
          <button type="button" class="proxy-close" :aria-label="content.close" autofocus @click="dialog?.close()">
            <LandingIcon name="close" />
          </button>
        </header>
        <p :id="`${id}-description`" class="proxy-description">
          {{ content.description }}
        </p>
        <p class="proxy-package">
          <strong>{{ download.title }}</strong>
          <span>{{ download.name }}</span>
        </p>
        <div class="proxy-options">
          <a v-for="proxy in proxies" :key="proxy.name" :href="proxy.url" class="proxy-option" target="_blank" rel="noreferrer">
            <span>{{ proxy.name }}</span>
            <LandingIcon name="external" />
          </a>
        </div>
        <p class="proxy-note">
          {{ content.note }}
        </p>
        <div class="proxy-footer">
          <a :href="download.url" target="_blank" rel="noreferrer">{{ content.direct }}<LandingIcon name="external" /></a>
          <a :href="download.releaseUrl" target="_blank" rel="noreferrer">{{ content.checksums }}<LandingIcon name="external" /></a>
        </div>
      </div>
    </dialog>
  </div>
</template>

<style scoped>
.download-help { margin-top: 10px; }
.help-trigger { display: inline-flex; align-items: center; gap: 8px; min-height: 44px; padding: 0; color: var(--crew-gold); font-size: 13px; text-align: left; cursor: pointer; }
.help-trigger:hover { text-decoration: underline; text-underline-offset: .25em; }
.help-trigger svg { width: 15px; height: 15px; flex-shrink: 0; }
.proxy-dialog { width: min(480px, calc(100vw - 32px)); max-width: none; max-height: calc(100dvh - 32px); margin: auto; padding: 0; overflow: auto; border: 1px solid var(--site-line); border-radius: 12px; background: var(--site-raised); color: var(--site-ink); box-shadow: 0 24px 64px var(--site-shadow); font-family: var(--site-font); }
.proxy-dialog::backdrop { background: #08142ccc; }
.proxy-body { padding: 24px; }
.proxy-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; margin-bottom: 12px; }
.proxy-header .proxy-title { align-self: center; font-size: 24px; line-height: 1.3; letter-spacing: -.02em; white-space: normal; }
.proxy-close { display: grid; place-items: center; width: 44px; height: 44px; margin: -8px -8px 0 0; flex-shrink: 0; border-radius: 6px; cursor: pointer; }
.proxy-close svg { width: 22px; height: 22px; }
.proxy-close:hover { color: var(--site-blue); background: var(--site-inset); }
.proxy-description, .proxy-note { color: var(--site-muted); font-size: 14px; line-height: 1.7; }
.proxy-package { display: grid; gap: 6px; margin-top: 18px; padding: 14px; border-radius: 6px; background: var(--site-inset); }
.proxy-package strong { font-size: 14px; }
.proxy-package span { font: 12px/1.6 var(--site-mono); color: var(--site-muted); overflow-wrap: anywhere; }
.proxy-options { display: grid; gap: 8px; margin-top: 18px; }
.proxy-option { display: flex; align-items: center; justify-content: space-between; gap: 12px; min-height: 48px; padding: 10px 14px; border: 1px solid var(--site-line); border-radius: 6px; color: var(--site-blue); font: 500 14px/1.5 var(--site-mono); }
.proxy-option:hover { background: var(--site-accent-soft); border-color: var(--site-blue); }
.proxy-option svg, .proxy-footer svg { width: 14px; height: 14px; flex-shrink: 0; }
.proxy-note { margin-top: 18px; font-size: 13px; }
.proxy-footer { display: flex; flex-wrap: wrap; gap: 4px 20px; margin-top: 12px; padding-top: 10px; border-top: 1px solid var(--site-line); }
.proxy-footer a { display: inline-flex; align-items: center; gap: 8px; min-height: 44px; color: var(--site-blue); font-size: 13px; }
.proxy-footer a:hover { text-decoration: underline; }
.download-help .proxy-dialog :focus-visible { outline: 2px solid var(--site-blue); outline-offset: 3px; }
@media (max-width: 760px) {
  .proxy-body { padding: 20px; }
  .proxy-header .proxy-title { font-size: 22px; }
}
</style>
