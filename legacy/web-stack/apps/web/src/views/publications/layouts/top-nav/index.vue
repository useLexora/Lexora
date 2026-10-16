<script setup lang="ts">
import type { ResolvedPublicationNavItem } from '../../utils/publicationRendering'
import type { PublicationTopNavProps } from './typing'
import type { SvgIconCategoryValue } from '@/components/svg-icon/typing'
import { normalizePublicationHref } from '@haohaoxue/lexora-shared/document'
import { onBeforeUnmount, onMounted, shallowRef } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { SvgIcon } from '@/components/svg-icon'
import { ElMessage } from '@/utils/element-plus'
import { getPublicationUnpublishedMessage } from '../../utils/publicationRendering'

const props = defineProps<PublicationTopNavProps>()
const router = useRouter()
const { t } = useI18n()
const isMobileMenuOpen = shallowRef(false)
const isAtTop = shallowRef(true)
const navIconAliases: Record<string, { category: SvgIconCategoryValue, icon: string }> = {
  github: { category: 'brand', icon: 'brand-github' },
  link: { category: 'ui', icon: 'link' },
  docs: { category: 'nav', icon: 'docs' },
  document: { category: 'nav', icon: 'docs' },
}

function syncTopState() {
  isAtTop.value = window.scrollY <= 0
}

onMounted(() => {
  syncTopState()
  window.addEventListener('scroll', syncTopState, { passive: true })
})

onBeforeUnmount(() => {
  window.removeEventListener('scroll', syncTopState)
})

function handleNavClick(item: ResolvedPublicationNavItem, event: MouseEvent) {
  if (item.disabled) {
    event.preventDefault()
    ElMessage.info(getPublicationUnpublishedMessage())
    return
  }

  const safeHref = normalizePublicationHref(item.href)

  if (!safeHref) {
    event.preventDefault()
    return
  }

  if (
    item.external
    || event.metaKey
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

function handleMobileNavClick(item: ResolvedPublicationNavItem, event: MouseEvent) {
  handleNavClick(item, event)

  if (!event.defaultPrevented || !item.disabled) {
    isMobileMenuOpen.value = false
  }
}

function resolveNavHref(item: ResolvedPublicationNavItem) {
  return normalizePublicationHref(item.href) ?? undefined
}

function toggleMobileMenu() {
  isMobileMenuOpen.value = !isMobileMenuOpen.value
}

function resolveNavIconAlias(icon: string | null) {
  const normalizedIcon = icon?.trim()

  if (!normalizedIcon) {
    return null
  }

  return navIconAliases[normalizedIcon] ?? navIconAliases[normalizedIcon.toLowerCase()] ?? null
}

function isNavIconImageSource(icon: string | null) {
  const source = icon?.trim() ?? ''

  return source.startsWith('/') || /^https?:\/\//i.test(source)
}

function resolveNavLabel(item: ResolvedPublicationNavItem) {
  return item.label?.trim() || item.ariaLabel
}

function hasVisibleNavLabel(item: ResolvedPublicationNavItem) {
  return Boolean(item.label?.trim())
}
</script>

<template>
  <header
    class="publication-top-nav"
    :class="{
      'is-home': props.home,
      'is-top': props.home && isAtTop,
      'is-scrolled': props.home && !isAtTop,
      'is-screen-open': isMobileMenuOpen,
    }"
  >
    <div class="publication-top-nav__surface" aria-hidden="true" />
    <div class="publication-top-nav__container">
      <RouterLink class="publication-top-nav__brand inline-flex min-w-0 items-center gap-2 text-main no-underline" :to="`/s/${props.site.id}`">
        <img
          v-if="props.site.logoUrl"
          class="publication-top-nav__logo h-6 w-6 flex-[0_0_auto] object-contain"
          :src="props.site.logoUrl"
          alt=""
        >
        <span v-else class="publication-top-nav__fallback-logo inline-flex h-6 w-6 flex-[0_0_auto] items-center justify-center rounded-md text-sm font-700">
          {{ props.site.title.slice(0, 1) }}
        </span>
        <span class="overflow-hidden text-base font-600 leading-[1.4] text-ellipsis whitespace-nowrap">{{ props.site.title }}</span>
      </RouterLink>

      <nav
        v-if="props.navItems.length"
        class="publication-top-nav__links inline-flex min-w-0 items-center justify-end gap-5 max-[720px]:hidden"
        :aria-label="t('docs.publicReader.topNavigation')"
      >
        <template
          v-for="item in props.navItems"
          :key="item.id"
        >
          <ElDropdown
            v-if="item.children.length"
            trigger="hover"
            popper-class="publication-top-nav__dropdown-popper"
          >
            <button
              class="publication-top-nav__trigger"
              type="button"
              :aria-label="item.ariaLabel"
              :title="item.ariaLabel"
            >
              <span v-if="item.icon" class="publication-top-nav__item-icon">
                <img
                  v-if="isNavIconImageSource(item.icon)"
                  :src="item.icon"
                  alt=""
                >
                <SvgIcon
                  v-else-if="resolveNavIconAlias(item.icon)"
                  :category="resolveNavIconAlias(item.icon)?.category"
                  :icon="resolveNavIconAlias(item.icon)?.icon ?? ''"
                  size="1rem"
                />
                <span v-else>{{ item.icon }}</span>
              </span>
              <span v-if="hasVisibleNavLabel(item)">{{ item.label }}</span>
              <SvgIcon category="ui" icon="chevron-down" size="0.72rem" />
            </button>

            <template #dropdown>
              <ElDropdownMenu class="publication-top-nav__dropdown-menu">
                <template
                  v-for="child in item.children"
                  :key="child.id"
                >
                  <ElDropdownItem
                    class="publication-top-nav__dropdown-item"
                  >
                    <a
                      class="publication-top-nav__dropdown-link"
                      :class="{ 'is-disabled': child.disabled, 'is-icon-only': !hasVisibleNavLabel(child) }"
                      :href="resolveNavHref(child)"
                      :aria-label="child.ariaLabel"
                      :title="child.ariaLabel"
                      :target="child.external && child.openInNewTab ? '_blank' : undefined"
                      :rel="child.external && child.openInNewTab ? 'noopener noreferrer' : undefined"
                      @click="handleNavClick(child, $event)"
                    >
                      <span v-if="child.icon" class="publication-top-nav__item-icon">
                        <img
                          v-if="isNavIconImageSource(child.icon)"
                          :src="child.icon"
                          alt=""
                        >
                        <SvgIcon
                          v-else-if="resolveNavIconAlias(child.icon)"
                          :category="resolveNavIconAlias(child.icon)?.category"
                          :icon="resolveNavIconAlias(child.icon)?.icon ?? ''"
                          size="1rem"
                        />
                        <span v-else>{{ child.icon }}</span>
                      </span>
                      <span v-if="hasVisibleNavLabel(child)">{{ child.label }}</span>
                    </a>
                  </ElDropdownItem>
                </template>
              </ElDropdownMenu>
            </template>
          </ElDropdown>

          <a
            v-else
            class="publication-top-nav__link text-[13px] font-semibold leading-[1.4] text-secondary no-underline whitespace-nowrap"
            :class="{ 'is-disabled': item.disabled, 'is-icon-only': !hasVisibleNavLabel(item) }"
            :href="resolveNavHref(item)"
            :aria-label="item.ariaLabel"
            :title="item.ariaLabel"
            :target="item.external && item.openInNewTab ? '_blank' : undefined"
            :rel="item.external && item.openInNewTab ? 'noopener noreferrer' : undefined"
            @click="handleNavClick(item, $event)"
          >
            <span v-if="item.icon" class="publication-top-nav__item-icon">
              <img
                v-if="isNavIconImageSource(item.icon)"
                :src="item.icon"
                alt=""
              >
              <SvgIcon
                v-else-if="resolveNavIconAlias(item.icon)"
                :category="resolveNavIconAlias(item.icon)?.category"
                :icon="resolveNavIconAlias(item.icon)?.icon ?? ''"
                size="1rem"
              />
              <span v-else>{{ item.icon }}</span>
            </span>
            <span v-if="hasVisibleNavLabel(item)">{{ item.label }}</span>
          </a>
        </template>
      </nav>

      <button
        v-if="props.navItems.length"
        class="publication-top-nav__menu-button hidden h-8 w-8 flex-[0_0_auto] items-center justify-center rounded-md border-none bg-transparent p-0 text-secondary max-[720px]:inline-flex"
        type="button"
        :aria-label="t('docs.publicReader.openSiteNavigation')"
        :aria-expanded="isMobileMenuOpen"
        @click="toggleMobileMenu"
      >
        <SvgIcon category="ui" icon="sidebar-open" size="1rem" />
      </button>
    </div>

    <nav
      v-if="props.navItems.length"
      class="publication-top-nav__mobile-menu"
      :class="{ 'is-open': isMobileMenuOpen }"
      :aria-label="t('docs.publicReader.mobileTopNavigation')"
    >
      <template
        v-for="item in props.navItems"
        :key="`mobile-${item.id}`"
      >
        <div v-if="item.children.length" class="publication-top-nav__mobile-group">
          <div class="publication-top-nav__mobile-group-label">
            <span v-if="item.icon" class="publication-top-nav__item-icon">
              <img
                v-if="isNavIconImageSource(item.icon)"
                :src="item.icon"
                alt=""
              >
              <SvgIcon
                v-else-if="resolveNavIconAlias(item.icon)"
                :category="resolveNavIconAlias(item.icon)?.category"
                :icon="resolveNavIconAlias(item.icon)?.icon ?? ''"
                size="1rem"
              />
              <span v-else>{{ item.icon }}</span>
            </span>
            <span>{{ resolveNavLabel(item) }}</span>
          </div>
          <template
            v-for="child in item.children"
            :key="`mobile-child-${child.id}`"
          >
            <a
              class="publication-top-nav__mobile-link is-child"
              :class="{ 'is-disabled': child.disabled, 'is-icon-only': !hasVisibleNavLabel(child) }"
              :href="resolveNavHref(child)"
              :aria-label="child.ariaLabel"
              :title="child.ariaLabel"
              :target="child.external && child.openInNewTab ? '_blank' : undefined"
              :rel="child.external && child.openInNewTab ? 'noopener noreferrer' : undefined"
              @click="handleMobileNavClick(child, $event)"
            >
              <span v-if="child.icon" class="publication-top-nav__item-icon">
                <img
                  v-if="isNavIconImageSource(child.icon)"
                  :src="child.icon"
                  alt=""
                >
                <SvgIcon
                  v-else-if="resolveNavIconAlias(child.icon)"
                  :category="resolveNavIconAlias(child.icon)?.category"
                  :icon="resolveNavIconAlias(child.icon)?.icon ?? ''"
                  size="1rem"
                />
                <span v-else>{{ child.icon }}</span>
              </span>
              <span v-if="hasVisibleNavLabel(child)">{{ child.label }}</span>
            </a>
          </template>
        </div>

        <a
          v-else
          class="publication-top-nav__mobile-link"
          :class="{ 'is-disabled': item.disabled, 'is-icon-only': !hasVisibleNavLabel(item) }"
          :href="resolveNavHref(item)"
          :aria-label="item.ariaLabel"
          :title="item.ariaLabel"
          :target="item.external && item.openInNewTab ? '_blank' : undefined"
          :rel="item.external && item.openInNewTab ? 'noopener noreferrer' : undefined"
          @click="handleMobileNavClick(item, $event)"
        >
          <span v-if="item.icon" class="publication-top-nav__item-icon">
            <img
              v-if="isNavIconImageSource(item.icon)"
              :src="item.icon"
              alt=""
            >
            <SvgIcon
              v-else-if="resolveNavIconAlias(item.icon)"
              :category="resolveNavIconAlias(item.icon)?.category"
              :icon="resolveNavIconAlias(item.icon)?.icon ?? ''"
              size="1rem"
            />
            <span v-else>{{ item.icon }}</span>
          </span>
          <span v-if="hasVisibleNavLabel(item)">{{ item.label }}</span>
        </a>
      </template>
    </nav>

    <div class="publication-top-nav__divider" aria-hidden="true">
      <div class="publication-top-nav__divider-line" />
    </div>
    <div class="publication-top-nav__mask" aria-hidden="true" />
  </header>
</template>

<style scoped lang="scss">
.publication-top-nav {
  position: sticky;
  top: 0;
  z-index: 30;
  background: transparent;
  transition: background-color 0.25s;
}

.publication-top-nav__surface {
  position: absolute;
  inset: 0;
  z-index: 0;
  background: var(--publication-c-bg);
  opacity: 1;
  pointer-events: none;
  transition: opacity 0.25s, background-color 0.5s;
}

.publication-top-nav.is-home.is-top:not(.is-screen-open) .publication-top-nav__surface {
  opacity: 0;
}

@supports ((backdrop-filter: blur(12px)) or (-webkit-backdrop-filter: blur(12px))) {
  .publication-top-nav__surface {
    background: color-mix(in srgb, var(--publication-c-bg) 86%, transparent);
    -webkit-backdrop-filter: saturate(180%) blur(12px);
    backdrop-filter: saturate(180%) blur(12px);
  }
}

.publication-top-nav__container {
  position: relative;
  z-index: 2;
  display: flex;
  width: 100%;
  max-width: var(--publication-layout-max-width);
  height: var(--publication-nav-height);
  align-items: center;
  justify-content: space-between;
  gap: 1.25rem;
  margin: 0 auto;
  padding: 0 1.5rem;
}

.publication-top-nav__divider {
  position: absolute;
  right: 0;
  bottom: 0;
  left: 0;
  z-index: 2;
  width: 100%;
  height: 1px;
  pointer-events: none;
}

.publication-top-nav__divider-line {
  width: 100%;
  height: 1px;
  background: var(--publication-c-gutter);
  opacity: 1;
  transition: opacity 0.5s, background-color 0.5s;
}

.publication-top-nav.is-home.is-top:not(.is-screen-open) .publication-top-nav__divider-line {
  opacity: 0;
}

.publication-top-nav__mask {
  position: absolute;
  top: 100%;
  right: 0;
  left: 0;
  z-index: 1;
  height: 2.25rem;
  background: linear-gradient(
    to bottom,
    color-mix(in srgb, var(--publication-c-bg) 92%, transparent),
    transparent
  );
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.25s;
}

.publication-top-nav.is-home.is-scrolled .publication-top-nav__mask {
  opacity: 1;
}

.publication-top-nav__brand {
  min-height: calc(var(--publication-nav-height) - 1px);
}

.publication-top-nav__fallback-logo {
  background: var(--publication-c-brand-soft);
  color: var(--publication-c-brand-1);
}

.publication-top-nav__link {
  display: inline-flex;
  min-height: 2rem;
  align-items: center;
  gap: 0.375rem;
  border-radius: 0.375rem;
  outline: none;

  &:hover {
    color: var(--publication-c-brand-1);
  }

  &:focus-visible {
    color: var(--publication-c-brand-1);
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--publication-c-brand-1) 28%, transparent);
  }

  &.is-icon-only {
    width: 2rem;
    justify-content: center;
  }

  &.is-disabled {
    color: var(--publication-c-text-3);
    cursor: not-allowed;
  }
}

.publication-top-nav__trigger {
  display: inline-flex;
  min-height: 2rem;
  align-items: center;
  gap: 0.375rem;
  border: 0;
  border-radius: 0.375rem;
  background: transparent;
  color: var(--publication-c-text-2);
  cursor: pointer;
  font-size: 0.8125rem;
  font-weight: 600;
  line-height: 1.4;
  outline: none;
  padding: 0;
  white-space: nowrap;

  &:hover {
    color: var(--publication-c-brand-1);
  }

  &:focus-visible {
    color: var(--publication-c-brand-1);
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--publication-c-brand-1) 28%, transparent);
  }
}

.publication-top-nav__item-icon {
  display: inline-flex;
  width: 1.25rem;
  height: 1.25rem;
  align-items: center;
  justify-content: center;
  flex: 0 0 auto;
  font-size: 1rem;
  line-height: 1;

  img {
    display: block;
    max-width: 1.25rem;
    max-height: 1.25rem;
    object-fit: contain;
  }
}

.publication-top-nav__dropdown-link {
  display: flex;
  min-height: 2rem;
  width: max-content;
  min-width: 6.5rem;
  max-width: min(20rem, calc(100vw - 3rem));
  align-items: center;
  gap: 0.5rem;
  border-radius: 0.375rem;
  padding: 0 0.75rem;
  color: var(--publication-c-text-2);
  font-size: 0.875rem;
  font-weight: 500;
  line-height: 1.45;
  outline: none;
  text-decoration: none;

  &:hover {
    color: var(--publication-c-brand-1);
  }

  &:focus-visible {
    color: var(--publication-c-brand-1);
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--publication-c-brand-1) 28%, transparent);
  }

  &.is-icon-only {
    min-width: 2rem;
    justify-content: center;
  }

  &.is-disabled {
    color: var(--publication-c-text-3);
    cursor: not-allowed;
  }

  > span:last-child {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
}

.publication-top-nav__menu-button {
  outline: none;

  &:hover,
  &:focus-visible {
    background: var(--publication-c-brand-soft);
    color: var(--publication-c-brand-1);
  }

  &:focus-visible {
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--publication-c-brand-1) 28%, transparent);
  }
}

.publication-top-nav__mobile-menu {
  position: absolute;
  top: var(--publication-nav-height);
  left: 0;
  right: 0;
  z-index: 3;
  display: none;
  gap: 0.125rem;
  padding: 0.5rem 1rem 0.875rem;
  border-bottom: 1px solid var(--publication-c-gutter);
  background: var(--publication-c-bg);
}

.publication-top-nav__mobile-menu.is-open {
  display: grid;
}

.publication-top-nav__mobile-link {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  border-radius: 0.375rem;
  padding: 0.5rem 0.75rem;
  color: var(--publication-c-text-2);
  font-size: 0.875rem;
  font-weight: 500;
  line-height: 1.5;
  outline: none;
  text-decoration: none;

  &.is-child {
    margin-left: 1rem;
  }

  &.is-icon-only {
    width: fit-content;
    min-width: 2.5rem;
    justify-content: center;
  }

  &:hover,
  &:focus-visible {
    background: var(--publication-c-bg-soft);
    color: var(--publication-c-brand-1);
  }

  &:focus-visible {
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--publication-c-brand-1) 28%, transparent);
  }

  &.is-disabled {
    color: var(--publication-c-text-3);
    cursor: not-allowed;
  }
}

.publication-top-nav__mobile-group {
  display: grid;
  gap: 0.125rem;
}

.publication-top-nav__mobile-group-label {
  display: flex;
  min-height: 2rem;
  align-items: center;
  gap: 0.5rem;
  padding: 0.375rem 0.75rem;
  color: var(--publication-c-text-3);
  font-size: 0.75rem;
  font-weight: 700;
  line-height: 1.4;

  &.is-child {
    margin-left: 1rem;
  }
}

:global(.publication-top-nav__dropdown-popper) {
  --el-dropdown-menu-box-shadow: 0 12px 32px rgb(0 0 0 / 10%);
}

:global(.publication-top-nav__dropdown-popper .el-scrollbar__wrap) {
  overflow-x: hidden;
}

:global(.publication-top-nav__dropdown-popper .el-dropdown-menu) {
  width: max-content;
  min-width: 8rem;
  max-width: min(20rem, calc(100vw - 1.5rem));
  padding: 0.75rem;
  border: 1px solid var(--publication-c-gutter);
  border-radius: 0.75rem;
  overflow: hidden;
}

:global(.publication-top-nav__dropdown-popper .el-dropdown-menu__item) {
  border-radius: 0.375rem;
  padding: 0;
  width: max-content;
  max-width: 100%;
}

:global(.publication-top-nav__dropdown-popper .el-dropdown-menu__item:not(.is-disabled):focus) {
  background: var(--publication-c-bg-soft);
}

@media (min-width: 768px) {
  .publication-top-nav__container {
    padding: 0 2rem;
  }
}

@media (min-width: 721px) {
  .publication-top-nav__mobile-menu {
    display: none;
  }
}

@media (min-width: 960px) {
  .publication-top-nav {
    position: fixed;
    right: 0;
    left: 0;
    width: 100%;
  }

  .publication-top-nav__brand {
    width: calc(var(--publication-sidebar-width) - 2rem);
  }
}

@media (max-width: 720px) {
  .publication-top-nav__container {
    padding: 0 1rem;
  }
}
</style>
