<script setup lang="ts">
import type { SidebarPanelBrand, SidebarPanelItem } from '../typing'
import { useI18n } from 'vue-i18n'
import { useRoute } from 'vue-router'
import SessionUserMenu from '@/layouts/components/session-user-menu'

const props = defineProps<{
  brand: SidebarPanelBrand
  items: SidebarPanelItem[]
}>()

const route = useRoute()
const { t } = useI18n({ useScope: 'global' })
const repositoryUrl = 'https://github.com/haohaoxue-site/Lexora'

function getItemStateClass(isActive: boolean) {
  return isActive ? 'active' : 'idle'
}

function isNavigationItemActive(item: SidebarPanelItem) {
  const routeName = route.name ?? ''
  return routeName === item.name
    || route.matched.some(matchedRoute => matchedRoute.name === item.name)
    || (item.name === 'home' && routeName === 'chat')
}

function getItemIconSrc(item: SidebarPanelItem, isActive: boolean) {
  return isActive ? item.activeIcon ?? item.icon : item.icon
}
</script>

<template>
  <aside class="sidebar-panel flex h-[var(--app-shell-height)] w-[var(--sidebar-panel-rail-width)] shrink-0 flex-col overflow-hidden">
    <div class="sidebar-panel__brand-wrap flex h-[var(--sidebar-panel-brand-height)] shrink-0 items-center justify-center border-b px-3">
      <RouterLink
        :to="props.brand.to"
        class="sidebar-panel__brand-link flex h-11 w-11 items-center justify-center rounded-lg"
        :aria-label="t('navigation.workspace.home')"
      >
        <img
          :src="props.brand.iconSrc"
          alt=""
          aria-hidden="true"
          class="sidebar-panel__brand-image block h-full w-full rounded-lg object-cover"
        >
      </RouterLink>
    </div>

    <ElScrollbar class="min-h-0 flex-1">
      <nav class="sidebar-panel__nav flex flex-col items-center gap-1.5 px-3 py-4">
        <RouterLink
          v-for="item in props.items"
          :key="item.name"
          v-slot="{ href, navigate }"
          :to="item.to"
          custom
        >
          <a
            :href="href"
            :aria-label="item.label"
            :title="item.label"
            class="sidebar-panel__nav-item flex h-11 w-11 items-center justify-center rounded-lg"
            :class="getItemStateClass(isNavigationItemActive(item))"
            @click="navigate"
          >
            <div class="sidebar-panel__nav-icon flex h-9 w-9 items-center justify-center" :class="getItemStateClass(isNavigationItemActive(item))">
              <SvgIcon
                :category="item.iconCategory"
                :icon="getItemIconSrc(item, isNavigationItemActive(item))"
                size="2.25rem"
                class="sidebar-panel__nav-icon-image"
              />
            </div>
            <span class="sr-only">{{ item.label }}</span>
          </a>
        </RouterLink>
      </nav>
    </ElScrollbar>

    <nav class="sidebar-panel__external-nav shrink-0 border-t px-3 py-3" :aria-label="t('navigation.projectLinks')">
      <a
        :href="repositoryUrl"
        target="_blank"
        rel="noopener noreferrer"
        class="sidebar-panel__external-link mx-auto flex h-11 w-11 items-center justify-center overflow-hidden rounded-lg"
        :aria-label="t('navigation.repository')"
        title="GitHub"
      >
        <span class="sidebar-panel__external-icon flex h-9 w-9 shrink-0 items-center justify-center">
          <SvgIcon category="brand" icon="brand-github" size="20px" />
        </span>
      </a>
    </nav>

    <footer class="sidebar-panel__footer flex shrink-0 justify-center border-t px-3 py-3.5">
      <SessionUserMenu />
    </footer>
  </aside>
</template>

<style scoped lang="scss">
.sidebar-panel {
  border-right: 1px solid color-mix(in srgb, var(--brand-border-base) 74%, transparent);
  background: var(--brand-bg-sidebar);

  .sidebar-panel__brand-wrap {
    border-bottom: 1px solid color-mix(in srgb, var(--brand-border-base) 70%, transparent);
  }

  .sidebar-panel__brand-link {
    text-decoration: none;

    &:focus-visible {
      outline: none;
      box-shadow: 0 0 0 2px color-mix(in srgb, var(--brand-primary) 18%, transparent);
    }
  }

  .sidebar-panel__nav-item {
    --sidebar-panel-row-bg: transparent;
    --sidebar-panel-indicator-opacity: 0;
    --sidebar-panel-indicator-scale: 0.72;

    position: relative;
    color: var(--brand-text-secondary);
    text-decoration: none;
    transition: color 0.2s ease, background-color 0.2s ease;

    &::before,
    &::after {
      position: absolute;
      content: '';
      pointer-events: none;
    }

    &::before {
      top: 0.5rem;
      bottom: 0.5rem;
      left: -0.75rem;
      z-index: 2;
      width: 3px;
      background: var(--brand-primary);
      opacity: var(--sidebar-panel-indicator-opacity);
      transform: scaleY(var(--sidebar-panel-indicator-scale));
      transform-origin: center;
      transition:
        opacity var(--sidebar-panel-row-transition),
        transform var(--sidebar-panel-row-transition);
    }

    &::after {
      inset: 0;
      z-index: 0;
      background: var(--sidebar-panel-row-bg);
      opacity: 1;
      border-radius: 0.5rem;
      transition: background-color 0.18s ease;
    }

    &:focus-visible {
      outline: 2px solid color-mix(in srgb, var(--brand-primary) 20%, transparent);
      outline-offset: -2px;
    }

    &.active {
      --sidebar-panel-indicator-opacity: 1;
      --sidebar-panel-indicator-scale: 1;
      --sidebar-panel-row-bg: color-mix(in srgb, var(--brand-primary) 10%, var(--brand-bg-surface));

      color: var(--brand-text-primary);
    }

    &.idle {
      &:hover {
        --sidebar-panel-row-bg: color-mix(in srgb, var(--brand-bg-surface) 92%, transparent);
        color: var(--brand-text-primary);
      }
    }
  }

  .sidebar-panel__nav-icon {
    z-index: 1;
    transition: color 0.2s ease;

    &.active {
      border-radius: 0.5rem;
      background: color-mix(in srgb, var(--brand-primary) 8%, var(--brand-bg-surface));
    }
  }

  .sidebar-panel__nav-label {
    z-index: 1;
  }

  .sidebar-panel__external-link {
    color: var(--brand-text-primary);
    text-decoration: none;
    transition:
      color 0.2s ease,
      background 0.2s ease;

    &:hover {
      color: var(--brand-text-primary);
      background: color-mix(in srgb, var(--brand-bg-surface) 92%, transparent);
    }

    &:focus-visible {
      outline: none;
      box-shadow: 0 0 0 2px color-mix(in srgb, var(--brand-primary) 20%, transparent);
    }
  }

  .sidebar-panel__footer {
    border-top: 1px solid color-mix(in srgb, var(--brand-border-base) 70%, transparent);
  }
}
</style>
