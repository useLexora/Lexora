<script setup lang="ts">
import type { LocalArtifact } from '@buddy-shared/artifacts/artifactApi'
import type { DropdownOption, DropdownProps } from 'naive-ui'
import type { ArtifactAction } from '../../state/artifacts/createArtifactActions'
import type { BuddyLocale } from '@/i18n/buddyI18n'
import { Copy20Regular, Folder20Regular, FolderOpen20Regular, Info16Regular, MoreHorizontal20Regular, Open20Regular, TextQuote20Regular } from '@vicons/fluent'
import { NButton, NDropdown, NTooltip } from 'naive-ui'
import { computed, h, shallowRef, useId, useTemplateRef } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import { formatArtifactFileSize } from '@/modules/tasks/model/artifacts/artifactPresentation'
import { FileIcon, FolderIcon } from '@/shared/ui/file-icon'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'
import { useArtifactActions } from './artifactActionsContext'

const props = defineProps<{
  artifact: LocalArtifact
  language: BuddyLocale
  compact?: boolean
}>()
const emit = defineEmits<{
  openArtifact: [artifact: LocalArtifact]
}>()
const { t } = useBuddyI18n(() => props.language)
const actions = useArtifactActions()
const nameId = useId()
const card = useTemplateRef<HTMLElement>('card')
const busy = shallowRef(false)
const menuOpen = shallowRef(false)
const contextMenuOpen = shallowRef(false)
const hoveredHint = shallowRef<string | null>(null)
const focusedHint = shallowRef<string | null>(null)
const contextPosition = shallowRef({ x: 0, y: 0 })
const failedPreviewUrl = shallowRef<string | null>(null)
const previewUrl = computed(() => props.artifact.kind === 'file' && props.artifact.mimeType.startsWith('image/')
  ? `lexora-artifact://preview/${encodeURIComponent(props.artifact.artifactId)}?v=${encodeURIComponent(props.artifact.updatedAt)}`
  : null)
const previewable = computed(() => previewUrl.value !== null && failedPreviewUrl.value !== previewUrl.value)
const detail = computed(() => props.artifact.kind === 'directory'
  ? props.artifact.path
  : `${formatArtifactFileSize(props.artifact.sizeBytes)} · ${props.artifact.path}`)
const overlayTheme = { color: 'rgb(from var(--buddy-surface-raised) r g b / 1)' }
const menuTheme: DropdownProps['themeOverrides'] = {
  ...overlayTheme,
  fontSizeSmall: 'var(--buddy-chat-caption-font-size)',
  optionHeightSmall: '28px',
  optionIconSizeSmall: '14px',
}
const renderMenuLabel: DropdownProps['renderLabel'] = option => h('span', { class: 'flex items-center justify-between gap-2 whitespace-nowrap' }, [
  option.label as string,
  option.disabledReason ? h(DesktopIcon, { component: Info16Regular, size: 14 }) : null,
])
const renderMenuOption: DropdownProps['renderOption'] = ({ node, option }) => {
  const reason = option.disabledReason
  if (!option.disabled || typeof reason !== 'string')
    return node
  const key = String(option.key)
  return h(NTooltip, {
    trigger: 'manual',
    show: (menuOpen.value || contextMenuOpen.value) && (hoveredHint.value === key || focusedHint.value === key),
    placement: 'right',
    themeOverrides: overlayTheme,
  }, {
    trigger: () => h('div', {
      'class': 'buddy-artifact-menu__hint rounded-micro focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-focus focus-visible:outline-offset-[-2px]',
      'tabindex': 0,
      'role': 'group',
      'aria-label': option.label as string,
      'aria-description': reason,
      'aria-disabled': 'true',
      'onMouseenter': () => hoveredHint.value = key,
      'onMouseleave': () => hoveredHint.value = null,
      'onFocus': () => focusedHint.value = key,
      'onBlur': () => focusedHint.value = null,
      'onKeydown': (event: KeyboardEvent) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          event.stopPropagation()
          return
        }
        handleKeydown(event)
      },
    }, [node]),
    default: () => h('span', { class: 'block max-w-56 text-[12px] leading-relaxed' }, reason),
  })
}
const menuOptions = computed<DropdownOption[]>(() => [
  {
    key: 'reference',
    label: t('desktop.artifacts.reference'),
    disabledReason: !actions?.canReference(props.artifact) ? t('desktop.artifacts.referenceUnavailable') : undefined,
    icon: () => h(DesktopIcon, { component: TextQuote20Regular }),
    disabled: busy.value || !actions?.canReference(props.artifact),
  },
  {
    key: 'locate',
    label: t('desktop.artifacts.locate'),
    disabledReason: !actions?.canLocate(props.artifact) ? t('desktop.artifacts.locateUnavailable') : undefined,
    icon: () => h(DesktopIcon, { component: Folder20Regular }),
    disabled: busy.value || !actions?.canLocate(props.artifact),
  },
  { key: 'reveal', label: t('desktop.artifacts.reveal'), icon: () => h(DesktopIcon, { component: FolderOpen20Regular }), disabled: busy.value || !actions },
  { key: 'copyPath', label: t('desktop.artifacts.copyPath'), icon: () => h(DesktopIcon, { component: Copy20Regular }), disabled: busy.value || !actions },
])
function closeMenus() {
  menuOpen.value = false
  contextMenuOpen.value = false
  hoveredHint.value = null
  focusedHint.value = null
}
async function selectAction(action: string) {
  closeMenus()
  if (!actions || busy.value || !menuOptions.value.some(option => option.key === action && !option.disabled))
    return
  busy.value = true
  try {
    await actions.execute(action as ArtifactAction, props.artifact)
  }
  finally {
    busy.value = false
  }
}
function openContextMenu(event: MouseEvent) {
  menuOpen.value = false
  contextPosition.value = { x: event.clientX, y: event.clientY }
  contextMenuOpen.value = true
}
function handleKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    closeMenus()
    return
  }
  if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10'))
    return
  event.preventDefault()
  event.stopPropagation()
  const rect = card.value?.getBoundingClientRect()
  if (rect) {
    menuOpen.value = false
    contextPosition.value = { x: rect.left, y: rect.bottom }
    contextMenuOpen.value = true
  }
}
</script>

<template>
  <div
    ref="card"
    class="buddy-artifact-collection__item relative grid overflow-hidden min-w-0 border-1 border-solid border-border rounded-micro bg-raised text-inherit text-left hover:border-accent hover:bg-accent-subtle focus-within:border-accent"
    :class="[compact ? 'is-compact' : 'h-[88px] grid-cols-[40px_minmax(0,1fr)] items-center gap-2 p-3', { 'is-directory': artifact.kind === 'directory' }]"
    @contextmenu.stop.prevent="openContextMenu"
    @keydown="handleKeydown"
  >
    <button
      type="button"
      class="buddy-artifact-collection__trigger absolute inset-0 z-1 border-0 rounded-micro bg-transparent p-0 cursor-pointer focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-focus focus-visible:outline-offset-[-2px]"
      :aria-labelledby="nameId"
      @click.stop="emit('openArtifact', artifact)"
    />
    <div
      class="buddy-artifact-collection__preview pointer-events-none grid items-center overflow-hidden text-muted"
      :class="[
        { 'is-contain': artifact.mimeType === 'image/svg+xml' },
        compact ? 'border-b-1 border-b-solid border-b-border bg-accent-subtle' : 'h-10 w-10 rounded-micro',
        compact && !previewable ? 'grid-cols-[minmax(0,1fr)] justify-items-start pl-1 pr-[56px]' : 'justify-items-center',
      ]"
    >
      <FolderIcon v-if="artifact.kind === 'directory'" class="buddy-artifact-collection__directory-icon h-7 w-7 object-contain" />
      <img
        v-else-if="previewable"
        :alt="artifact.name"
        class="buddy-artifact-collection__image"
        loading="lazy"
        draggable="false"
        :src="previewUrl ?? undefined"
        @error="failedPreviewUrl = previewUrl"
      >
      <FileIcon v-else :name="artifact.name" size="medium" />
    </div>
    <div
      class="buddy-artifact-collection__actions pointer-events-none absolute z-2 flex items-center border-1 border-solid border-border rounded-micro bg-[rgb(from_var(--buddy-surface-raised)_r_g_b_/_0.96)] p-[1px] text-muted opacity-0 transition-opacity duration-120 motion-reduce:transition-none"
      :class="[compact ? 'top-1 right-1' : 'top-2 right-2', { 'is-open': menuOpen || contextMenuOpen }]"
    >
      <NButton
        class="buddy-icon-button buddy-artifact-collection__open focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-focus"
        quaternary size="tiny"
        :aria-label="t('desktop.artifacts.open')"
        @click.stop="emit('openArtifact', artifact)"
        @pointerdown.stop
      >
        <DesktopIcon :component="Open20Regular" :size="14" />
      </NButton>
      <NDropdown
        v-model:show="menuOpen" trigger="click" placement="bottom-end" size="small" :options="menuOptions" :theme-overrides="menuTheme"
        :render-label="renderMenuLabel" :render-option="renderMenuOption"
        @select="selectAction" @update:show="contextMenuOpen = false"
      >
        <NButton
          class="buddy-icon-button buddy-artifact-collection__more focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-focus"
          quaternary size="tiny"
          :aria-label="t('desktop.artifacts.more')" aria-haspopup="menu" :aria-expanded="menuOpen"
          @click.stop @pointerdown.stop
        >
          <DesktopIcon :component="MoreHorizontal20Regular" :size="14" />
        </NButton>
      </NDropdown>
    </div>
    <div class="buddy-artifact-collection__meta pointer-events-none grid min-w-0 gap-2">
      <span :id="nameId" class="buddy-artifact-collection__name overflow-hidden text-strong text-[length:var(--buddy-chat-meta-font-size)] leading-[18px] text-ellipsis whitespace-nowrap">{{ artifact.name }}</span>
      <span class="buddy-artifact-collection__detail overflow-hidden text-muted text-[length:var(--buddy-chat-caption-font-size)] leading-[16px] text-ellipsis whitespace-nowrap">{{ detail }}</span>
    </div>
    <NDropdown
      :show="contextMenuOpen" trigger="manual" placement="bottom-start" size="small"
      :x="contextPosition.x" :y="contextPosition.y" :options="menuOptions" :theme-overrides="menuTheme"
      :render-label="renderMenuLabel" :render-option="renderMenuOption"
      @select="selectAction" @clickoutside="closeMenus" @update:show="contextMenuOpen = $event"
    />
  </div>
</template>

<style scoped lang="scss">
.buddy-artifact-collection__item:is(:hover, :focus-within) .buddy-artifact-collection__actions,
.buddy-artifact-collection__actions.is-open {
  pointer-events: auto;
  opacity: 1;
}

@media (hover: none) {
  .buddy-artifact-collection__actions {
    pointer-events: auto;
    opacity: 1;
  }
}

.buddy-artifact-collection__preview {
  .buddy-artifact-collection__image {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: cover;
  }

  &.is-contain .buddy-artifact-collection__image {
    object-fit: contain;
    padding: 0.5rem;
  }
}

.buddy-artifact-collection__item.is-compact {
  flex: 0 1 96px;
  width: 96px;
  max-width: 96px;
  height: 68px;
  grid-template-rows: 40px minmax(0, 1fr);

  .buddy-artifact-collection__preview {
    height: auto;

    :deep(.buddy-file-icon),
    .buddy-artifact-collection__directory-icon {
      width: 1.75rem;
      max-width: 100%;
      height: 1.75rem;
    }
  }

  .buddy-artifact-collection__meta {
    grid-template-columns: minmax(0, 1fr);
    padding: 3px 6px;
  }

  .buddy-artifact-collection__name {
    font-size: 10px;
  }

  .buddy-artifact-collection__detail {
    display: none;
  }
}
</style>
