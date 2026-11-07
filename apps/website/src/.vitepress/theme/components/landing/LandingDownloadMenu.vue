<script setup lang="ts">
import type { DownloadArchitecture, DownloadFormat, DownloadRelease, DownloadSystem } from './landingDownloads'
import { computed, onMounted, onUnmounted, ref, shallowRef } from 'vue'
import { releasesUrl, repositoryUrl } from '../../../productLinks'
import { detectDownloadSystem, matchDownloadAsset, parseDownloadRelease } from './landingDownloads'
import LandingIcon from './LandingIcon.vue'

interface MenuItemConfig {
  title: string
  desc: string
  format: string
}

const props = defineProps<{
  label: string
  english: boolean
  content: {
    currentOs: string
    linuxHint: string
    allReleases: string
    windows: MenuItemConfig
    macOS: MenuItemConfig
    linuxDeb: MenuItemConfig
    linuxArch: MenuItemConfig
  }
}>()

const isOpen = ref(false)
const menuRef = shallowRef<HTMLElement | null>(null)
const triggerRef = shallowRef<HTMLButtonElement | null>(null)
const detectedSystem = shallowRef<DownloadSystem>('unknown')

const fallbackRelease: DownloadRelease = {
  tag: 'v0.20.0',
  version: '0.20.0',
  publishedAt: '2026-03-01T00:00:00Z',
  url: `${repositoryUrl}/releases/tag/v0.20.0`,
  assets: [
    {
      system: 'windows',
      architecture: 'x64',
      format: 'nsis',
      name: 'Lexora-Buddy-0.20.0-windows-x64.exe',
      url: `${repositoryUrl}/releases/download/v0.20.0/Lexora-Buddy-0.20.0-windows-x64.exe`,
      size: 158 * 1024 * 1024,
    },
    {
      system: 'macos',
      architecture: 'arm64',
      format: 'dmg',
      name: 'Lexora-Buddy-0.20.0-macos-arm64.dmg',
      url: `${repositoryUrl}/releases/download/v0.20.0/Lexora-Buddy-0.20.0-macos-arm64.dmg`,
      size: 173 * 1024 * 1024,
    },
    {
      system: 'linux',
      architecture: 'x64',
      format: 'deb',
      name: 'Lexora-Buddy-0.20.0-linux-amd64.deb',
      url: `${repositoryUrl}/releases/download/v0.20.0/Lexora-Buddy-0.20.0-linux-amd64.deb`,
      size: 137 * 1024 * 1024,
    },
    {
      system: 'linux',
      architecture: 'x64',
      format: 'pacman',
      name: 'Lexora-Buddy-0.20.0-arch-x86_64.pkg.tar.zst',
      url: `${repositoryUrl}/releases/download/v0.20.0/Lexora-Buddy-0.20.0-arch-x86_64.pkg.tar.zst`,
      size: 162 * 1024 * 1024,
    },
  ],
}

const currentRelease = shallowRef<DownloadRelease>(fallbackRelease)

const platformItems = computed(() => {
  const configs = [
    {
      id: 'windows',
      title: props.content.windows.title,
      desc: props.content.windows.desc,
      formatBadge: props.content.windows.format,
      system: 'windows' as DownloadSystem,
      architecture: 'x64' as DownloadArchitecture,
      format: 'nsis' as DownloadFormat,
      fallbackUrl: `${repositoryUrl}/releases/download/v0.20.0/Lexora-Buddy-0.20.0-windows-x64.exe`,
      isRecommended: detectedSystem.value === 'windows',
    },
    {
      id: 'macos',
      title: props.content.macOS.title,
      desc: props.content.macOS.desc,
      formatBadge: props.content.macOS.format,
      system: 'macos' as DownloadSystem,
      architecture: 'arm64' as DownloadArchitecture,
      format: 'dmg' as DownloadFormat,
      fallbackUrl: `${repositoryUrl}/releases/download/v0.20.0/Lexora-Buddy-0.20.0-macos-arm64.dmg`,
      isRecommended: detectedSystem.value === 'macos',
    },
    {
      id: 'linux-deb',
      title: props.content.linuxDeb.title,
      desc: props.content.linuxDeb.desc,
      formatBadge: props.content.linuxDeb.format,
      system: 'linux' as DownloadSystem,
      architecture: 'x64' as DownloadArchitecture,
      format: 'deb' as DownloadFormat,
      fallbackUrl: `${repositoryUrl}/releases/download/v0.20.0/Lexora-Buddy-0.20.0-linux-amd64.deb`,
      isRecommended: false,
    },
    {
      id: 'linux-arch',
      title: props.content.linuxArch.title,
      desc: props.content.linuxArch.desc,
      formatBadge: props.content.linuxArch.format,
      system: 'linux' as DownloadSystem,
      architecture: 'x64' as DownloadArchitecture,
      format: 'pacman' as DownloadFormat,
      fallbackUrl: `${repositoryUrl}/releases/download/v0.20.0/Lexora-Buddy-0.20.0-arch-x86_64.pkg.tar.zst`,
      isRecommended: false,
    },
  ]

  return configs.map((cfg) => {
    const matched = matchDownloadAsset(currentRelease.value, cfg.system, cfg.architecture, cfg.format)
    return {
      ...cfg,
      url: matched?.url ?? cfg.fallbackUrl,
    }
  })
})

function toggleMenu() {
  isOpen.value = !isOpen.value
}

function handlePointerDown(event: PointerEvent) {
  if (!isOpen.value)
    return
  const target = event.target as Node | null
  if (menuRef.value && !menuRef.value.contains(target)) {
    isOpen.value = false
  }
}

function handleKeyDown(event: KeyboardEvent) {
  if (event.key === 'Escape' && isOpen.value) {
    isOpen.value = false
    triggerRef.value?.focus()
  }
}

onMounted(() => {
  if (typeof window !== 'undefined') {
    detectedSystem.value = detectDownloadSystem({
      userAgent: navigator.userAgent,
      platform: navigator.platform,
      maxTouchPoints: navigator.maxTouchPoints,
      userAgentData: (navigator as unknown as { userAgentData?: { platform?: string, mobile?: boolean } }).userAgentData,
    })

    document.addEventListener('pointerdown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)

    fetch('https://api.github.com/repos/useLexora/Lexora/releases/latest', {
      headers: { Accept: 'application/vnd.github.v3+json' },
      signal: AbortSignal.timeout(4000),
    })
      .then(res => res.ok ? res.json() : null)
      .then((data) => {
        if (!data)
          return
        const parsed = parseDownloadRelease(data)
        if (parsed)
          currentRelease.value = parsed
      })
      .catch(() => {})
  }
})

onUnmounted(() => {
  if (typeof window !== 'undefined') {
    document.removeEventListener('pointerdown', handlePointerDown)
    document.removeEventListener('keydown', handleKeyDown)
  }
})
</script>

<template>
  <div ref="menuRef" class="download-dropdown-wrap">
    <button
      ref="triggerRef"
      type="button"
      class="site-button gold-button download-trigger"
      :class="{ 'is-open': isOpen }"
      :aria-expanded="isOpen"
      aria-haspopup="dialog"
      :aria-label="label"
      @click="toggleMenu"
    >
      <span>{{ label }}</span>
      <LandingIcon name="down" class="arrow-icon" :class="{ 'is-open': isOpen }" />
    </button>

    <Transition name="panel-fade">
      <div
        v-if="isOpen"
        class="download-panel"
        role="dialog"
        :aria-label="label"
      >
        <p v-if="detectedSystem === 'linux'" class="download-hint">
          {{ content.linuxHint }}
        </p>
        <div class="download-list">
          <a
            v-for="item in platformItems"
            :key="item.id"
            :href="item.url"
            class="download-item"
            :class="{ 'is-recommended': item.isRecommended }"
            target="_blank"
            rel="noreferrer"
          >
            <div class="item-icon-box">
              <!-- Windows -->
              <svg v-if="item.id === 'windows'" width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                <path d="M0 3.449L9.75 2.1v9.451H0m10.949-9.602L24 0v11.4H10.949M0 12.6h9.75v9.451L0 20.699M10.949 12.6H24V24l-13.051-1.802" />
              </svg>
              <!-- macOS -->
              <svg v-else-if="item.id === 'macos'" width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                <path d="M18.71 19.5c-.83 1.24-1.71 2.45-3.05 2.47-1.34.03-1.77-.79-3.29-.79-1.53 0-2 .77-3.27.82-1.31.05-2.3-1.32-3.14-2.53C4.25 17 2.94 12.45 4.7 9.39c.87-1.52 2.43-2.48 4.12-2.51 1.28-.02 2.5.87 3.29.87.78 0 2.26-1.07 3.81-.91.65.03 2.47.26 3.64 1.98-.09.06-2.17 1.28-2.15 3.81.03 3.02 2.65 4.03 2.68 4.04-.03.07-.42 1.44-1.38 2.83M15.97 6.42c.62-.75 1.04-1.8 0.93-2.85-.9.04-1.98.6-2.61 1.34-.56.65-1.04 1.71-.91 2.74 1 .08 2.02-.51 2.59-1.23z" />
              </svg>
              <!-- Ubuntu / Debian (Linux 企鹅轮廓) -->
              <svg v-else-if="item.id === 'linux-deb'" width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 2C9.5 2 7.8 3.8 7.8 6.5c0 1.2.3 2.3.8 3.2C7.4 10.8 6.5 12.3 6.5 14c0 2.2 1.4 4 3.4 4.6-.2.6-.4 1.2-.4 1.9 0 .8.6 1.5 1.5 1.5h2c.9 0 1.5-.7 1.5-1.5 0-.7-.2-1.3-.4-1.9 2-.6 3.4-2.4 3.4-4.6 0-1.7-.8-3.2-2-4.3.5-.9.8-2 .8-3.2C16.2 3.8 14.5 2 12 2zm0 2.2c1.3 0 2.2 1.1 2.2 2.3 0 .7-.3 1.4-.8 1.8-.4.3-.9.5-1.4.5s-1-.2-1.4-.5c-.5-.4-.8-1.1-.8-1.8 0-1.2.9-2.3 2.2-2.3z" />
              </svg>
              <!-- Arch Linux -->
              <svg v-else width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 2L2 22h4.5l2.2-4.5c.8.6 1.8 1 3.3 1 1.4 0 2.4-.4 3.2-1l2.3 4.5H22L12 2zm0 6.5l3.2 6.8c-.8.5-1.9.7-3.2.7-1.3 0-2.3-.2-3.1-.7L12 8.5z" />
              </svg>
            </div>

            <div class="item-info">
              <div class="name-row">
                <span class="item-title">{{ item.title }}</span>
                <span v-if="item.isRecommended" class="recommended-tag">
                  {{ content.currentOs }}
                </span>
              </div>
              <div class="item-desc">{{ item.desc }}</div>
            </div>

            <div class="item-action">
              <span class="format-badge">{{ item.formatBadge }}</span>
              <LandingIcon name="down" class="download-arrow-sub" />
            </div>
          </a>
        </div>

        <div class="panel-footer">
          <a :href="releasesUrl" target="_blank" rel="noreferrer" class="footer-link">
            <span>{{ content.allReleases }} <span class="tag-hint">({{ currentRelease.tag }})</span></span>
            <LandingIcon name="external" />
          </a>
        </div>
      </div>
    </Transition>
  </div>
</template>

<style scoped>
.download-dropdown-wrap {
  position: relative;
  display: inline-block;
}

.download-trigger {
  min-height: 56px;
  padding-inline: 27px;
  font-size: 15px;
  border: none;
  cursor: pointer;
  user-select: none;
  transform: none !important;
  transition: background-color 0.15s ease;
}

.download-trigger:hover,
.download-trigger:active,
.download-trigger:focus-visible {
  transform: none !important;
}

.download-trigger.is-open {
  background: #ffe3a8;
}

.arrow-icon {
  width: 17px;
  height: 17px;
  display: inline-block;
  flex-shrink: 0;
  transform-origin: center center;
  transition: transform 0.2s cubic-bezier(0.16, 1, 0.3, 1);
  will-change: transform;
}

.arrow-icon.is-open {
  transform: rotate(180deg);
}

.download-panel {
  position: absolute;
  top: calc(100% + 10px);
  left: 0;
  z-index: 50;
  width: 372px;
  max-width: calc(100vw - 32px);
  padding: 6px;
  border-radius: 12px;
  background: rgba(18, 30, 66, 0.96);
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
  border: 1px solid rgba(255, 255, 255, 0.14);
  box-shadow:
    0 24px 48px -10px rgba(4, 9, 24, 0.7),
    0 4px 16px -2px rgba(4, 9, 24, 0.35),
    inset 0 1px 0 rgba(255, 255, 255, 0.1);
  color: var(--crew-paper);
  font-family: var(--site-font);
  box-sizing: border-box;
  transform: translateZ(0);
  backface-visibility: hidden;
}

.download-hint {
  margin: 0;
  padding: 10px 12px;
  color: rgba(200, 213, 245, 0.85);
  font-size: 12px;
  line-height: 1.5;
}

.download-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.download-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 9px 12px;
  border-radius: 8px;
  border: 1px solid transparent;
  text-decoration: none;
  color: var(--crew-paper);
  transition: background-color 0.14s ease, border-color 0.14s ease;
}

.download-item:hover {
  background: rgba(255, 255, 255, 0.08);
}

.download-item.is-recommended {
  background: rgba(242, 204, 128, 0.08);
  border-color: rgba(242, 204, 128, 0.2);
}

.download-item.is-recommended:hover {
  background: rgba(242, 204, 128, 0.14);
  border-color: rgba(242, 204, 128, 0.35);
}

.item-icon-box {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border-radius: 7px;
  background: rgba(255, 255, 255, 0.06);
  color: rgba(200, 213, 245, 0.85);
  flex-shrink: 0;
  transition: color 0.14s ease, background-color 0.14s ease;
}

.download-item:hover .item-icon-box {
  background: rgba(255, 255, 255, 0.12);
  color: #ffffff;
}

.download-item.is-recommended .item-icon-box {
  color: var(--crew-gold);
  background: rgba(242, 204, 128, 0.12);
}

.item-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 1;
  min-width: 0;
}

.name-row {
  display: flex;
  align-items: center;
  gap: 6px;
}

.item-title {
  font-size: 13.5px;
  font-weight: 600;
  color: #ffffff;
  line-height: 1.25;
}

.item-desc {
  font-size: 11.5px;
  color: rgba(200, 213, 245, 0.65);
  line-height: 1.25;
}

.recommended-tag {
  display: inline-flex;
  align-items: center;
  padding: 1px 6px;
  border-radius: 4px;
  background: rgba(242, 204, 128, 0.16);
  color: var(--crew-gold);
  border: 1px solid rgba(242, 204, 128, 0.32);
  font-size: 10px;
  font-weight: 500;
  line-height: 1.3;
  white-space: nowrap;
}

.item-action {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}

.format-badge {
  font-family: var(--site-mono);
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: 0.04em;
  padding: 2px 5px;
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.08);
  color: rgba(200, 213, 245, 0.75);
  transition: color 0.14s ease, background-color 0.14s ease;
}

.download-item:hover .format-badge {
  background: rgba(255, 255, 255, 0.15);
  color: #ffffff;
}

.download-arrow-sub {
  width: 14px;
  height: 14px;
  color: rgba(200, 213, 245, 0.4);
  transform: translateY(-2px);
  opacity: 0;
  transition: opacity 0.14s ease, transform 0.14s ease, color 0.14s ease;
}

.download-item:hover .download-arrow-sub {
  opacity: 1;
  transform: translateY(0);
  color: var(--crew-gold);
}

.panel-footer {
  margin-top: 4px;
  padding-top: 5px;
  border-top: 1px solid rgba(255, 255, 255, 0.08);
}

.footer-link {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 8px 12px;
  border-radius: 6px;
  font-size: 12px;
  font-weight: 500;
  color: rgba(200, 213, 245, 0.8);
  text-decoration: none;
  transition: background-color 0.14s ease, color 0.14s ease;
}

.footer-link:hover {
  background: rgba(255, 255, 255, 0.06);
  color: var(--crew-gold);
}

.tag-hint {
  font-family: var(--site-mono);
  font-size: 11px;
  opacity: 0.75;
}

.footer-link svg {
  width: 13px;
  height: 13px;
}

/* Transitions: 极简纯粹的垂直平滑微位移与淡入淡出，完全消除形变缩放带来的文字抖动 */
.panel-fade-enter-active {
  transition: opacity 0.14s ease-out, transform 0.14s ease-out;
}

.panel-fade-leave-active {
  transition: opacity 0.1s ease-in, transform 0.1s ease-in;
}

.panel-fade-enter-from {
  opacity: 0;
  transform: translateY(-4px);
}

.panel-fade-leave-to {
  opacity: 0;
  transform: translateY(-2px);
}

@media (max-width: 760px) {
  .download-trigger {
    min-height: 50px;
    font-size: 14px;
    padding-inline: 21px;
  }
  .download-panel {
    width: 320px;
    padding: 5px;
  }
}
</style>
