<script setup lang="ts">
import type { UploadRequestOptions } from 'element-plus'
import type {
  PublicationSiteNavigationPanelEmits,
  PublicationSiteNavigationPanelProps,
  SiteNavigationItemDraft,
} from './typing'
import type {
  PublicationNavItem,
  PublicationNavItemInput,
  PublicationPage,
} from '@/apis/document-publication'
import {
  ArrowDown,
  ArrowUp,
  Delete,
  Document,
  FolderOpened,
  HomeFilled,
  Link,
  MoreFilled,
  Plus,
  Upload,
} from '@element-plus/icons-vue'
import {
  DOCUMENT_PUBLICATION_ENTRY_STATUS,
  DOCUMENT_PUBLICATION_NAV_ITEM_EXTERNAL_TARGET,
  DOCUMENT_PUBLICATION_NAV_ITEM_INTERNAL_TARGET,
  DOCUMENT_PUBLICATION_NAV_ITEM_LABEL_MAX_LENGTH,
  DOCUMENT_PUBLICATION_NAV_ITEM_MAX_DEPTH,
  DOCUMENT_PUBLICATION_NAV_ITEM_TYPE,
  DOCUMENT_PUBLICATION_SITE_CUSTOM_MEDIA_MAX_BYTES_BY_SCOPE,
  DOCUMENT_PUBLICATION_SITE_CUSTOM_MEDIA_SCOPE,
  DOCUMENT_PUBLICATION_SITE_MEDIA_MIME_TYPES,
} from '@haohaoxue/lexora-contracts/document/publication/constants'
import { normalizePublicationHref } from '@haohaoxue/lexora-shared/document'
import { prettyBytes } from '@haohaoxue/lexora-shared/file'
import { computed, shallowRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import Empty from '@/components/empty'
import { ElMessage, ElMessageBox } from '@/utils/element-plus'

const props = withDefaults(defineProps<PublicationSiteNavigationPanelProps>(), {
  saving: false,
  uploadingCustomMediaKey: '',
})
const emits = defineEmits<PublicationSiteNavigationPanelEmits>()
const { t } = useI18n()

interface NavigationTreeNode extends SiteNavigationItemDraft {
  children?: NavigationTreeNode[]
}

const drafts = shallowRef<SiteNavigationItemDraft[]>([])
const selectedLocalId = shallowRef('')
const activeSections = computed(() =>
  [...props.sections]
    .filter(section => section.status !== DOCUMENT_PUBLICATION_ENTRY_STATUS.REMOVED)
    .sort(compareOrderedItem),
)
const selectableSections = computed(() =>
  activeSections.value.filter(section => section.status === DOCUMENT_PUBLICATION_ENTRY_STATUS.ACTIVE),
)
const activePages = computed(() =>
  [...props.pages]
    .filter(page => page.status !== DOCUMENT_PUBLICATION_ENTRY_STATUS.REMOVED)
    .sort(compareOrderedItem),
)
const selectablePages = computed(() =>
  activePages.value.filter(page => page.status === DOCUMENT_PUBLICATION_ENTRY_STATUS.ACTIVE),
)
const sectionTitleById = computed(() =>
  new Map(activeSections.value.map(section => [section.id, section.title])),
)
const pageById = computed(() =>
  new Map(activePages.value.map(page => [page.id, page])),
)
const selectedDraft = computed(() =>
  drafts.value.find(item => item.localId === selectedLocalId.value) ?? drafts.value[0] ?? null,
)
const navigationTree = computed(() => buildNavigationTree(drafts.value))
const draftByLocalId = computed(() =>
  new Map(drafts.value.map(item => [item.localId, item])),
)
const mediaAccept = DOCUMENT_PUBLICATION_SITE_MEDIA_MIME_TYPES.join(',')
const navIconMediaSizeLimitLabel = prettyBytes(DOCUMENT_PUBLICATION_SITE_CUSTOM_MEDIA_MAX_BYTES_BY_SCOPE[DOCUMENT_PUBLICATION_SITE_CUSTOM_MEDIA_SCOPE.NAV_ICON])

watch(
  () => props.navItems,
  () => {
    drafts.value = [...props.navItems]
      .sort(compareOrderedItem)
      .map(toDraft)
    selectedLocalId.value = drafts.value[0]?.localId ?? ''
  },
  { immediate: true },
)

function addInternalItem(parentId = '') {
  if (parentId && !canAddChildItem(parentId)) {
    ElMessage.warning(t('docs.publicationSite.navigation.maxDepthExceeded'))
    return
  }

  const localId = crypto.randomUUID()

  drafts.value = [
    ...drafts.value,
    {
      localId,
      id: localId,
      type: DOCUMENT_PUBLICATION_NAV_ITEM_TYPE.INTERNAL,
      label: t('docs.publicationSite.navigation.home'),
      icon: '',
      parentId,
      target: DOCUMENT_PUBLICATION_NAV_ITEM_INTERNAL_TARGET.HOME,
      targetId: '',
      url: '',
      openTarget: DOCUMENT_PUBLICATION_NAV_ITEM_EXTERNAL_TARGET.BLANK,
      order: drafts.value.length,
      status: DOCUMENT_PUBLICATION_ENTRY_STATUS.ACTIVE,
    },
  ]
  selectedLocalId.value = localId
}

function addExternalItem(parentId = '') {
  if (parentId && !canAddChildItem(parentId)) {
    ElMessage.warning(t('docs.publicationSite.navigation.maxDepthExceeded'))
    return
  }

  const localId = crypto.randomUUID()

  drafts.value = [
    ...drafts.value,
    {
      localId,
      id: localId,
      type: DOCUMENT_PUBLICATION_NAV_ITEM_TYPE.EXTERNAL,
      label: t('docs.publicationSite.navigation.externalLink'),
      icon: '',
      parentId,
      target: DOCUMENT_PUBLICATION_NAV_ITEM_INTERNAL_TARGET.HOME,
      targetId: '',
      url: 'https://',
      openTarget: DOCUMENT_PUBLICATION_NAV_ITEM_EXTERNAL_TARGET.BLANK,
      order: drafts.value.length,
      status: DOCUMENT_PUBLICATION_ENTRY_STATUS.ACTIVE,
    },
  ]
  selectedLocalId.value = localId
}

function addGroupItem() {
  const localId = crypto.randomUUID()

  drafts.value = [
    ...drafts.value,
    {
      localId,
      id: localId,
      type: DOCUMENT_PUBLICATION_NAV_ITEM_TYPE.GROUP,
      label: t('docs.publicationSite.navigation.group'),
      icon: '',
      parentId: '',
      target: DOCUMENT_PUBLICATION_NAV_ITEM_INTERNAL_TARGET.HOME,
      targetId: '',
      url: '',
      openTarget: DOCUMENT_PUBLICATION_NAV_ITEM_EXTERNAL_TARGET.BLANK,
      order: drafts.value.length,
      status: DOCUMENT_PUBLICATION_ENTRY_STATUS.ACTIVE,
    },
  ]
  selectedLocalId.value = localId
}

function patchDraft(localId: string, patch: Partial<SiteNavigationItemDraft>) {
  const currentDraft = drafts.value.find(item => item.localId === localId)
  const convertedGroupId = currentDraft?.type === DOCUMENT_PUBLICATION_NAV_ITEM_TYPE.GROUP && patch.type && patch.type !== DOCUMENT_PUBLICATION_NAV_ITEM_TYPE.GROUP ? localId : ''
  const convertedGroupParentId = convertedGroupId ? currentDraft?.parentId ?? '' : ''
  const nextDrafts = drafts.value.map((item) => {
    if (item.localId !== localId) {
      return item
    }

    const nextItem = {
      ...item,
      ...patch,
    }

    if (patch.target === DOCUMENT_PUBLICATION_NAV_ITEM_INTERNAL_TARGET.HOME) {
      nextItem.targetId = ''
    }

    if (patch.type === DOCUMENT_PUBLICATION_NAV_ITEM_TYPE.GROUP) {
      nextItem.target = DOCUMENT_PUBLICATION_NAV_ITEM_INTERNAL_TARGET.HOME
      nextItem.targetId = ''
      nextItem.url = ''
    }

    if (patch.type === DOCUMENT_PUBLICATION_NAV_ITEM_TYPE.EXTERNAL) {
      nextItem.target = DOCUMENT_PUBLICATION_NAV_ITEM_INTERNAL_TARGET.HOME
      nextItem.targetId = ''
      nextItem.url = nextItem.url || 'https://'
    }

    return nextItem
  })

  drafts.value = convertedGroupId
    ? nextDrafts.map(item => item.parentId === convertedGroupId ? { ...item, parentId: convertedGroupParentId } : item)
    : nextDrafts
}

function updateDraftType(item: SiteNavigationItemDraft, value: SiteNavigationItemDraft['type']) {
  if (value === DOCUMENT_PUBLICATION_NAV_ITEM_TYPE.GROUP && !canUseGroupType(item)) {
    ElMessage.warning(t('docs.publicationSite.navigation.groupDepthLimit'))
    return
  }

  if (value !== item.type) {
    patchDraft(item.localId, { type: value })
  }
}

function resolveSegmentedOptionStyle(active: boolean, disabled = false) {
  if (disabled) {
    return ''
  }

  return active
    ? 'background-color: var(--brand-primary) !important; color: #fff !important;'
    : 'background-color: transparent !important; color: var(--brand-text-secondary) !important;'
}

function beforeNavIconUpload(file: File) {
  if (!(DOCUMENT_PUBLICATION_SITE_MEDIA_MIME_TYPES as readonly string[]).includes(file.type)) {
    ElMessage.error(t('docs.publicationSite.validation.unsupportedImageType'))
    return false
  }

  const maxBytes = DOCUMENT_PUBLICATION_SITE_CUSTOM_MEDIA_MAX_BYTES_BY_SCOPE[DOCUMENT_PUBLICATION_SITE_CUSTOM_MEDIA_SCOPE.NAV_ICON]

  if (file.size > maxBytes) {
    ElMessage.error(t('docs.publicationSite.validation.imageTooLarge', { size: prettyBytes(maxBytes) }))
    return false
  }

  return true
}

async function handleNavIconUploadRequest(item: SiteNavigationItemDraft, options: UploadRequestOptions) {
  if (props.saving || isNavIconUploading(item) || !props.uploadCustomMedia) {
    const error = new Error(t('docs.publicationSite.validation.mediaUploading'))
    return Promise.reject(error)
  }

  const mediaUrl = await props.uploadCustomMedia(
    DOCUMENT_PUBLICATION_SITE_CUSTOM_MEDIA_SCOPE.NAV_ICON,
    item.localId,
    options.file,
  )

  if (!mediaUrl) {
    const error = new Error(t('docs.publicationSite.messages.mediaUploadFailed'))
    return Promise.reject(error)
  }

  patchDraft(item.localId, { icon: mediaUrl })
  options.onSuccess({})
  return Promise.resolve({})
}

function removeNavIcon(item: SiteNavigationItemDraft) {
  if (props.saving || isNavIconUploading(item)) {
    return
  }

  patchDraft(item.localId, { icon: '' })
}

function isNavIconUploading(item: SiteNavigationItemDraft) {
  return props.uploadingCustomMediaKey === `${DOCUMENT_PUBLICATION_SITE_CUSTOM_MEDIA_SCOPE.NAV_ICON}:${item.localId}`
}

function isUploadedMediaSource(value: string | null | undefined) {
  const source = value?.trim() ?? ''

  return source.startsWith('/') || /^https?:\/\//i.test(source)
}

function moveDraft(localId: string, direction: -1 | 1) {
  const tree = buildNavigationTree(drafts.value)
  const siblings = findSiblingNodes(tree, localId)

  if (!siblings) {
    return
  }

  const currentIndex = siblings.findIndex(item => item.localId === localId)
  const nextIndex = currentIndex + direction

  if (currentIndex < 0 || nextIndex < 0 || nextIndex >= siblings.length) {
    return
  }

  const [current] = siblings.splice(currentIndex, 1)

  if (!current) {
    return
  }

  siblings.splice(nextIndex, 0, current)
  drafts.value = normalizeDraftOrders(flattenNavigationTree(tree))
}

function normalizeDraftOrders(items: SiteNavigationItemDraft[]) {
  return items.map((item, index) => ({
    ...item,
    order: index,
  }))
}

function isDraftMoveDisabled(item: SiteNavigationItemDraft, direction: -1 | 1) {
  const siblings = findSiblingNodes(navigationTree.value, item.localId)

  if (!siblings) {
    return true
  }

  const index = siblings.findIndex(draft => draft.localId === item.localId)

  return index < 0 || index + direction < 0 || index + direction >= siblings.length
}

async function removeDraft(localId: string) {
  const currentIndex = drafts.value.findIndex(item => item.localId === localId)
  const currentDraft = drafts.value[currentIndex]

  if (currentIndex < 0 || !currentDraft) {
    return
  }

  if (drafts.value.some(item => item.parentId === localId)) {
    try {
      await ElMessageBox.confirm(
        t('docs.publicationSite.navigation.deleteMenuMessage', {
          name: resolveItemDisplayLabel(currentDraft),
        }),
        t('docs.publicationSite.navigation.deleteMenuTitle'),
        {
          confirmButtonText: t('docs.common.delete'),
          cancelButtonText: t('docs.common.cancel'),
          type: 'warning',
        },
      )
    }
    catch {
      return
    }
  }

  const descendantLocalIds = collectDescendantLocalIds(localId)
  const removedLocalIds = new Set([localId, ...descendantLocalIds])
  const nextDrafts = drafts.value
    .filter(item => !removedLocalIds.has(item.localId))
    .map((item, index) => ({
      ...item,
      order: index,
    }))

  drafts.value = nextDrafts

  if (removedLocalIds.has(selectedLocalId.value)) {
    selectedLocalId.value = nextDrafts[currentIndex]?.localId ?? nextDrafts[currentIndex - 1]?.localId ?? ''
  }
}

function toggleDraftStatus(item: SiteNavigationItemDraft) {
  patchDraft(item.localId, {
    status: item.status === DOCUMENT_PUBLICATION_ENTRY_STATUS.ACTIVE
      ? DOCUMENT_PUBLICATION_ENTRY_STATUS.HIDDEN
      : DOCUMENT_PUBLICATION_ENTRY_STATUS.ACTIVE,
  })
}

function handleCreateCommand(command: string | number | object) {
  if (command === 'group') {
    addGroupItem()
    return
  }

  if (command === 'internal') {
    addInternalItem()
    return
  }

  if (command === 'external') {
    addExternalItem()
  }
}

function saveSiteNavigationItems() {
  const items: PublicationNavItemInput[] = []
  const orderedDrafts = flattenNavigationTree(navigationTree.value)

  for (const [index, draft] of orderedDrafts.entries()) {
    const depth = resolveDraftDepth(draft.localId)

    if (depth > DOCUMENT_PUBLICATION_NAV_ITEM_MAX_DEPTH) {
      ElMessage.warning(t('docs.publicationSite.navigation.maxDepthExceeded'))
      return
    }

    if (draft.type === DOCUMENT_PUBLICATION_NAV_ITEM_TYPE.GROUP && depth >= DOCUMENT_PUBLICATION_NAV_ITEM_MAX_DEPTH) {
      ElMessage.warning(t('docs.publicationSite.navigation.groupDepthLimit'))
      return
    }

    const label = draft.label.trim()
    const icon = draft.icon.trim()
    const itemLabel = label || icon || t('docs.publicationSite.navigation.item')

    if (draft.type === DOCUMENT_PUBLICATION_NAV_ITEM_TYPE.GROUP) {
      if (!label) {
        ElMessage.warning(t('docs.publicationSite.navigation.labelRequired'))
        return
      }

      items.push({
        id: draft.id ?? draft.localId,
        type: DOCUMENT_PUBLICATION_NAV_ITEM_TYPE.GROUP,
        parentId: draft.parentId || null,
        label,
        icon: icon || null,
        order: index,
        status: draft.status,
      })
      continue
    }

    if (!label && !icon) {
      ElMessage.warning(t('docs.publicationSite.navigation.labelOrIconRequired'))
      return
    }

    if (draft.type === DOCUMENT_PUBLICATION_NAV_ITEM_TYPE.EXTERNAL) {
      const url = draft.url.trim()

      if (!url) {
        ElMessage.warning(t('docs.publicationSite.navigation.externalUrlRequired', { label: itemLabel }))
        return
      }

      const safeUrl = normalizePublicationHref(url)

      if (!safeUrl) {
        ElMessage.warning(t('docs.publicationSite.navigation.invalidUrl', { label: itemLabel }))
        return
      }

      items.push({
        id: draft.id ?? draft.localId,
        type: DOCUMENT_PUBLICATION_NAV_ITEM_TYPE.EXTERNAL,
        parentId: draft.parentId || null,
        label: label || null,
        icon: icon || null,
        url: safeUrl,
        openTarget: draft.openTarget,
        order: index,
        status: draft.status,
      })
      continue
    }

    const targetId = draft.target === DOCUMENT_PUBLICATION_NAV_ITEM_INTERNAL_TARGET.HOME
      ? null
      : draft.targetId.trim()

    if (draft.target !== DOCUMENT_PUBLICATION_NAV_ITEM_INTERNAL_TARGET.HOME && !targetId) {
      ElMessage.warning(t('docs.publicationSite.navigation.internalTargetRequired', { label: itemLabel }))
      return
    }

    if (draft.target !== DOCUMENT_PUBLICATION_NAV_ITEM_INTERNAL_TARGET.HOME) {
      const isAvailableTarget = resolveTargetOptions(draft)
        .some(option => option.value === targetId)

      if (!isAvailableTarget) {
        ElMessage.warning(t('docs.publicationSite.navigation.internalTargetUnavailable', { label: itemLabel }))
        return
      }
    }

    items.push({
      id: draft.id ?? draft.localId,
      type: DOCUMENT_PUBLICATION_NAV_ITEM_TYPE.INTERNAL,
      parentId: draft.parentId || null,
      label: label || null,
      icon: icon || null,
      target: draft.target,
      targetId,
      order: index,
      status: draft.status,
    })
  }

  emits('save', items)
}

function resolveTargetOptions(item: SiteNavigationItemDraft) {
  if (item.target === DOCUMENT_PUBLICATION_NAV_ITEM_INTERNAL_TARGET.SECTION) {
    return selectableSections.value.map(section => ({
      label: section.title,
      value: section.id,
    }))
  }

  if (item.target === DOCUMENT_PUBLICATION_NAV_ITEM_INTERNAL_TARGET.PAGE) {
    return selectablePages.value.map(page => ({
      label: resolvePageTargetLabel(page),
      value: page.id,
    }))
  }

  return []
}

function resolvePageTargetLabel(page: PublicationPage) {
  const sectionTitle = sectionTitleById.value.get(page.sectionId)

  return sectionTitle ? `${sectionTitle} / ${page.title}` : page.title
}

function resolveTypeLabel(item: SiteNavigationItemDraft) {
  if (item.type === DOCUMENT_PUBLICATION_NAV_ITEM_TYPE.GROUP) {
    return t('docs.publicationSite.navigation.group')
  }

  return item.type === DOCUMENT_PUBLICATION_NAV_ITEM_TYPE.INTERNAL
    ? t('docs.publicationSite.navigation.internalLink')
    : t('docs.publicationSite.navigation.externalLink')
}

function resolveStatusLabel(item: SiteNavigationItemDraft) {
  return item.status === DOCUMENT_PUBLICATION_ENTRY_STATUS.ACTIVE
    ? t('docs.publicationSite.status.visible')
    : t('docs.publicationSite.status.hidden')
}

function resolveTargetLabel(item: SiteNavigationItemDraft) {
  if (item.type === DOCUMENT_PUBLICATION_NAV_ITEM_TYPE.GROUP) {
    return t('docs.publicationSite.navigation.group')
  }

  if (item.type === DOCUMENT_PUBLICATION_NAV_ITEM_TYPE.EXTERNAL) {
    return item.url || t('docs.publicationSite.navigation.notFilledLink')
  }

  if (item.target === DOCUMENT_PUBLICATION_NAV_ITEM_INTERNAL_TARGET.HOME) {
    return t('docs.publicationSite.navigation.home')
  }

  if (item.target === DOCUMENT_PUBLICATION_NAV_ITEM_INTERNAL_TARGET.SECTION) {
    return sectionTitleById.value.get(item.targetId) ?? t('docs.publicationSite.navigation.noSection')
  }

  const page = pageById.value.get(item.targetId)

  if (!page) {
    return t('docs.publicationSite.navigation.noPage')
  }

  return resolvePageTargetLabel(page)
}

function resolveItemDisplayLabel(item: SiteNavigationItemDraft) {
  if (item.label.trim()) {
    return item.label
  }

  if (item.icon.trim()) {
    return isUploadedMediaSource(item.icon)
      ? t('docs.publicationSite.navigation.iconOnly')
      : item.icon
  }

  return resolveTargetLabel(item)
}

function resolveNavIcon(item: SiteNavigationItemDraft) {
  if (item.type === DOCUMENT_PUBLICATION_NAV_ITEM_TYPE.GROUP) {
    return FolderOpened
  }

  if (item.type === DOCUMENT_PUBLICATION_NAV_ITEM_TYPE.EXTERNAL) {
    return Link
  }

  if (item.target === DOCUMENT_PUBLICATION_NAV_ITEM_INTERNAL_TARGET.SECTION) {
    return FolderOpened
  }

  if (item.target === DOCUMENT_PUBLICATION_NAV_ITEM_INTERNAL_TARGET.PAGE) {
    return Document
  }

  return HomeFilled
}

function resolveDraftDepth(localId: string) {
  return resolveDraftDepthByLocalId(localId, new Set())
}

function resolveDraftDepthByLocalId(localId: string, visiting: Set<string>): number {
  const item = draftByLocalId.value.get(localId)

  if (!item?.parentId) {
    return 1
  }

  if (visiting.has(localId)) {
    return DOCUMENT_PUBLICATION_NAV_ITEM_MAX_DEPTH + 1
  }

  visiting.add(localId)

  const depth = resolveDraftDepthByLocalId(item.parentId, visiting) + 1

  visiting.delete(localId)

  return depth
}

function canUseGroupType(item: SiteNavigationItemDraft) {
  return resolveDraftDepth(item.localId) < DOCUMENT_PUBLICATION_NAV_ITEM_MAX_DEPTH
}

function canAddChildItem(itemOrLocalId: SiteNavigationItemDraft | string) {
  const item = typeof itemOrLocalId === 'string'
    ? draftByLocalId.value.get(itemOrLocalId)
    : itemOrLocalId

  return item?.type === DOCUMENT_PUBLICATION_NAV_ITEM_TYPE.GROUP
    && resolveDraftDepth(item.localId) < DOCUMENT_PUBLICATION_NAV_ITEM_MAX_DEPTH
}

function collectDescendantLocalIds(parentId: string) {
  const childIdsByParentId = new Map<string, string[]>()

  for (const item of drafts.value) {
    if (!item.parentId) {
      continue
    }

    const childIds = childIdsByParentId.get(item.parentId) ?? []
    childIds.push(item.localId)
    childIdsByParentId.set(item.parentId, childIds)
  }

  const descendantLocalIds: string[] = []
  const stack = [...(childIdsByParentId.get(parentId) ?? [])]

  while (stack.length > 0) {
    const localId = stack.shift()

    if (!localId) {
      continue
    }

    descendantLocalIds.push(localId)
    stack.push(...(childIdsByParentId.get(localId) ?? []))
  }

  return descendantLocalIds
}

function selectDraft(localId: string) {
  selectedLocalId.value = localId
}

function handleRowClick(row: NavigationTreeNode) {
  selectDraft(row.localId)
}

function resolveRowClassName({ row }: { row: NavigationTreeNode }) {
  return [
    selectedDraft.value?.localId === row.localId ? 'is-selected' : '',
    row.parentId ? 'is-child' : '',
  ].filter(Boolean).join(' ')
}

function buildNavigationTree(items: SiteNavigationItemDraft[]): NavigationTreeNode[] {
  const orderedNodes = items
    .map(item => ({ ...item, children: [] as NavigationTreeNode[] }))
    .sort((left, right) => left.order - right.order)
  const nodeById = new Map(orderedNodes.map(node => [node.localId, node]))
  const roots: NavigationTreeNode[] = []

  for (const node of orderedNodes) {
    const parent = node.parentId ? nodeById.get(node.parentId) : null

    if (parent?.type === DOCUMENT_PUBLICATION_NAV_ITEM_TYPE.GROUP) {
      parent.children?.push(node)
      continue
    }

    node.parentId = ''
    roots.push(node)
  }

  return stripEmptyTreeChildren(roots)
}

function stripEmptyTreeChildren(nodes: NavigationTreeNode[]): NavigationTreeNode[] {
  return nodes.map((node) => {
    if (!node.children?.length) {
      const { children: _children, ...leaf } = node
      return leaf
    }

    return {
      ...node,
      children: stripEmptyTreeChildren(node.children),
    }
  })
}

function flattenNavigationTree(nodes: NavigationTreeNode[]): SiteNavigationItemDraft[] {
  return nodes.flatMap((node) => {
    const { children, ...item } = node

    return children?.length
      ? [item, ...flattenNavigationTree(children)]
      : [item]
  })
}

function findSiblingNodes(nodes: NavigationTreeNode[], localId: string): NavigationTreeNode[] | null {
  if (nodes.some(node => node.localId === localId)) {
    return nodes
  }

  for (const node of nodes) {
    if (!node.children?.length) {
      continue
    }

    const siblings = findSiblingNodes(node.children, localId)

    if (siblings) {
      return siblings
    }
  }

  return null
}

function toDraft(item: PublicationNavItem): SiteNavigationItemDraft {
  if (item.type === DOCUMENT_PUBLICATION_NAV_ITEM_TYPE.GROUP) {
    return {
      localId: item.id,
      id: item.id,
      type: item.type,
      label: item.label,
      icon: item.icon ?? '',
      parentId: item.parentId ?? '',
      target: DOCUMENT_PUBLICATION_NAV_ITEM_INTERNAL_TARGET.HOME,
      targetId: '',
      url: '',
      openTarget: DOCUMENT_PUBLICATION_NAV_ITEM_EXTERNAL_TARGET.BLANK,
      order: item.order,
      status: item.status,
    }
  }

  if (item.type === DOCUMENT_PUBLICATION_NAV_ITEM_TYPE.EXTERNAL) {
    return {
      localId: item.id,
      id: item.id,
      type: item.type,
      label: item.label ?? '',
      icon: item.icon ?? '',
      parentId: item.parentId ?? '',
      target: DOCUMENT_PUBLICATION_NAV_ITEM_INTERNAL_TARGET.HOME,
      targetId: '',
      url: item.url,
      openTarget: item.openTarget ?? DOCUMENT_PUBLICATION_NAV_ITEM_EXTERNAL_TARGET.BLANK,
      order: item.order,
      status: item.status,
    }
  }

  return {
    localId: item.id,
    id: item.id,
    type: item.type,
    label: item.label ?? '',
    icon: item.icon ?? '',
    parentId: item.parentId ?? '',
    target: item.target,
    targetId: item.targetId ?? '',
    url: '',
    openTarget: DOCUMENT_PUBLICATION_NAV_ITEM_EXTERNAL_TARGET.BLANK,
    order: item.order,
    status: item.status,
  }
}

function compareOrderedItem(left: { order: number, updatedAt: string }, right: { order: number, updatedAt: string }) {
  if (left.order !== right.order) {
    return left.order - right.order
  }

  return right.updatedAt.localeCompare(left.updatedAt)
}
</script>

<template>
  <section class="publication-site-navigation-panel grid gap-5">
    <header class="flex flex-wrap items-end justify-between gap-3">
      <div class="grid gap-1">
        <h2 class="m-0 text-xl font-semibold leading-7 text-main">
          {{ t('docs.publicationSite.navigation.title') }}
        </h2>
      </div>

      <div class="inline-flex flex-wrap items-center justify-end gap-2">
        <ElDropdown trigger="click" @command="handleCreateCommand">
          <ElButton :icon="Plus">
            {{ t('docs.publicationSite.navigation.addItem') }}
          </ElButton>
          <template #dropdown>
            <ElDropdownMenu>
              <ElDropdownItem command="group">
                {{ t('docs.publicationSite.navigation.group') }}
              </ElDropdownItem>
              <ElDropdownItem command="internal">
                {{ t('docs.publicationSite.navigation.internalLink') }}
              </ElDropdownItem>
              <ElDropdownItem command="external">
                {{ t('docs.publicationSite.navigation.externalLink') }}
              </ElDropdownItem>
            </ElDropdownMenu>
          </template>
        </ElDropdown>
        <ElButton type="primary" :loading="saving" @click="saveSiteNavigationItems">
          {{ t('docs.publicationSite.navigation.save') }}
        </ElButton>
      </div>
    </header>

    <div class="grid grid-cols-[minmax(0,1fr)_minmax(20rem,26rem)] items-start gap-5 max-[1120px]:grid-cols-1">
      <div class="publication-site-navigation-panel__surface overflow-hidden rounded-xl border bg-surface">
        <ElTable
          :data="navigationTree"
          row-key="localId"
          default-expand-all
          class="publication-site-navigation-panel__table"
          :row-class-name="resolveRowClassName"
          :tree-props="{ children: 'children' }"
          @row-click="handleRowClick"
        >
          <template #empty>
            <Empty compact :description="t('docs.publicationSite.navigation.empty')" />
          </template>

          <ElTableColumn :label="t('docs.publicationSite.navigation.item')" min-width="180" show-overflow-tooltip>
            <template #default="{ row }">
              <span class="publication-site-navigation-panel__item-content inline-flex min-w-0 items-center gap-3 align-middle">
                <span class="publication-site-navigation-panel__item-icon flex h-9 w-9 items-center justify-center rounded-lg">
                  <img
                    v-if="isUploadedMediaSource(row.icon)"
                    :src="row.icon"
                    alt=""
                  >
                  <span v-else-if="row.icon" class="text-xs leading-none">{{ row.icon }}</span>
                  <ElIcon v-else size="18">
                    <component :is="resolveNavIcon(row)" />
                  </ElIcon>
                </span>
                <span class="grid min-w-0 gap-0.5">
                  <span class="publication-site-navigation-panel__item-label min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-sm font-medium leading-5">
                    {{ resolveItemDisplayLabel(row) }}
                  </span>
                  <span v-if="row.type === DOCUMENT_PUBLICATION_NAV_ITEM_TYPE.GROUP" class="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-xs leading-4 text-tertiary">
                    {{ row.children?.length ? t('docs.publicationSite.navigation.childCount', { count: row.children.length }) : t('docs.publicationSite.navigation.emptyDropdown') }}
                  </span>
                </span>
              </span>
            </template>
          </ElTableColumn>

          <ElTableColumn :label="t('docs.publicationSite.navigation.type')" width="96">
            <template #default="{ row }">
              <ElTag size="small" effect="plain">
                {{ resolveTypeLabel(row) }}
              </ElTag>
            </template>
          </ElTableColumn>

          <ElTableColumn :label="t('docs.publicationSite.navigation.target')" min-width="140" show-overflow-tooltip>
            <template #default="{ row }">
              <span class="text-sm leading-5 text-secondary">
                {{ resolveTargetLabel(row) }}
              </span>
            </template>
          </ElTableColumn>

          <ElTableColumn :label="t('docs.publicationSite.navigation.status')" width="78">
            <template #default="{ row }">
              <ElTag
                size="small"
                :type="row.status === DOCUMENT_PUBLICATION_ENTRY_STATUS.ACTIVE ? 'success' : 'info'"
                effect="plain"
              >
                {{ resolveStatusLabel(row) }}
              </ElTag>
            </template>
          </ElTableColumn>

          <ElTableColumn :label="t('docs.common.operation')" width="128" align="right" header-align="right">
            <template #default="{ row }">
              <div class="inline-flex items-center justify-end gap-1">
                <ElButton
                  text
                  class="publication-site-navigation-panel__icon-button h-7 min-w-7 w-7 rounded-lg p-0"
                  :icon="ArrowUp"
                  :disabled="isDraftMoveDisabled(row, -1)"
                  :title="t('docs.publicationSite.navigation.moveUp')"
                  @click.stop="moveDraft(row.localId, -1)"
                />
                <ElButton
                  text
                  class="publication-site-navigation-panel__icon-button h-7 min-w-7 w-7 rounded-lg p-0"
                  :icon="ArrowDown"
                  :disabled="isDraftMoveDisabled(row, 1)"
                  :title="t('docs.publicationSite.navigation.moveDown')"
                  @click.stop="moveDraft(row.localId, 1)"
                />
                <ElDropdown trigger="click">
                  <ElButton
                    text
                    class="publication-site-navigation-panel__icon-button h-7 min-w-7 w-7 rounded-lg p-0"
                    :icon="MoreFilled"
                    :title="t('docs.common.moreActions')"
                    @click.stop
                  />
                  <template #dropdown>
                    <ElDropdownMenu>
                      <ElDropdownItem @click="toggleDraftStatus(row)">
                        {{ row.status === DOCUMENT_PUBLICATION_ENTRY_STATUS.ACTIVE ? t('docs.publicationSite.navigation.hideItem') : t('docs.publicationSite.navigation.showItem') }}
                      </ElDropdownItem>
                      <ElDropdownItem
                        v-if="canAddChildItem(row)"
                        @click="addInternalItem(row.localId)"
                      >
                        {{ t('docs.publicationSite.navigation.addChildItem') }}
                      </ElDropdownItem>
                      <ElDropdownItem @click="removeDraft(row.localId)">
                        {{ t('docs.publicationSite.navigation.deleteItem') }}
                      </ElDropdownItem>
                    </ElDropdownMenu>
                  </template>
                </ElDropdown>
              </div>
            </template>
          </ElTableColumn>
        </ElTable>
      </div>

      <aside>
        <section v-if="selectedDraft" class="publication-site-navigation-panel__panel grid gap-4 rounded-xl border bg-surface p-4">
          <div class="grid gap-1">
            <h2 class="m-0 text-base font-semibold leading-6 text-main">
              {{ t('docs.publicationSite.navigation.editTitle') }}
            </h2>
            <p class="m-0 text-xs leading-5 text-tertiary">
              {{ t('docs.publicationSite.navigation.editDescription') }}
            </p>
          </div>

          <ElForm label-position="top">
            <ElFormItem :label="t('docs.publicationSite.navigation.name')">
              <ElInput
                :model-value="selectedDraft.label"
                :maxlength="DOCUMENT_PUBLICATION_NAV_ITEM_LABEL_MAX_LENGTH"
                clearable
                @update:model-value="value => patchDraft(selectedDraft.localId, { label: value })"
              />
            </ElFormItem>

            <ElFormItem :label="t('docs.publicationSite.navigation.icon')">
              <div class="publication-site-navigation-panel__icon-upload">
                <div class="publication-site-navigation-panel__icon-preview">
                  <img
                    v-if="isUploadedMediaSource(selectedDraft.icon)"
                    :src="selectedDraft.icon"
                    alt=""
                  >
                  <span v-else-if="selectedDraft.icon" class="text-xs leading-none">{{ selectedDraft.icon }}</span>
                  <ElIcon v-else size="18">
                    <component :is="resolveNavIcon(selectedDraft)" />
                  </ElIcon>
                  <span v-if="isNavIconUploading(selectedDraft)" class="publication-site-navigation-panel__upload-mask">{{ t('docs.publicationSite.navigation.uploading') }}</span>
                </div>
                <div class="grid min-w-0 gap-1">
                  <div class="publication-site-navigation-panel__icon-actions flex flex-wrap items-center gap-2">
                    <ElUpload
                      action="#"
                      :accept="mediaAccept"
                      :show-file-list="false"
                      :disabled="saving || isNavIconUploading(selectedDraft)"
                      :before-upload="beforeNavIconUpload"
                      :http-request="options => handleNavIconUploadRequest(selectedDraft, options)"
                    >
                      <ElButton size="small" :icon="Upload" :disabled="saving || isNavIconUploading(selectedDraft)">
                        {{ t('docs.publicationSite.navigation.uploadIcon') }}
                      </ElButton>
                    </ElUpload>
                    <ElButton
                      v-if="selectedDraft.icon"
                      size="small"
                      :icon="Delete"
                      :disabled="saving || isNavIconUploading(selectedDraft)"
                      @click="removeNavIcon(selectedDraft)"
                    >
                      {{ t('docs.publicationSite.navigation.removeIcon') }}
                    </ElButton>
                  </div>
                  <span class="text-xs leading-5 text-secondary">{{ t('docs.publicationSite.navigation.iconMediaHint', { size: navIconMediaSizeLimitLabel }) }}</span>
                </div>
              </div>
            </ElFormItem>

            <ElFormItem :label="t('docs.publicationSite.navigation.type')">
              <div class="publication-site-navigation-panel__type-group" role="radiogroup">
                <button
                  type="button"
                  class="publication-site-navigation-panel__type-option"
                  :class="{ 'is-active': selectedDraft.type === DOCUMENT_PUBLICATION_NAV_ITEM_TYPE.GROUP }"
                  :style="resolveSegmentedOptionStyle(selectedDraft.type === DOCUMENT_PUBLICATION_NAV_ITEM_TYPE.GROUP, !canUseGroupType(selectedDraft))"
                  role="radio"
                  :aria-checked="selectedDraft.type === DOCUMENT_PUBLICATION_NAV_ITEM_TYPE.GROUP"
                  :disabled="!canUseGroupType(selectedDraft)"
                  @click="updateDraftType(selectedDraft, DOCUMENT_PUBLICATION_NAV_ITEM_TYPE.GROUP)"
                >
                  {{ t('docs.publicationSite.navigation.group') }}
                </button>
                <button
                  type="button"
                  class="publication-site-navigation-panel__type-option"
                  :class="{ 'is-active': selectedDraft.type === DOCUMENT_PUBLICATION_NAV_ITEM_TYPE.INTERNAL }"
                  :style="resolveSegmentedOptionStyle(selectedDraft.type === DOCUMENT_PUBLICATION_NAV_ITEM_TYPE.INTERNAL)"
                  role="radio"
                  :aria-checked="selectedDraft.type === DOCUMENT_PUBLICATION_NAV_ITEM_TYPE.INTERNAL"
                  @click="updateDraftType(selectedDraft, DOCUMENT_PUBLICATION_NAV_ITEM_TYPE.INTERNAL)"
                >
                  {{ t('docs.publicationSite.navigation.internalLink') }}
                </button>
                <button
                  type="button"
                  class="publication-site-navigation-panel__type-option"
                  :class="{ 'is-active': selectedDraft.type === DOCUMENT_PUBLICATION_NAV_ITEM_TYPE.EXTERNAL }"
                  :style="resolveSegmentedOptionStyle(selectedDraft.type === DOCUMENT_PUBLICATION_NAV_ITEM_TYPE.EXTERNAL)"
                  role="radio"
                  :aria-checked="selectedDraft.type === DOCUMENT_PUBLICATION_NAV_ITEM_TYPE.EXTERNAL"
                  @click="updateDraftType(selectedDraft, DOCUMENT_PUBLICATION_NAV_ITEM_TYPE.EXTERNAL)"
                >
                  {{ t('docs.publicationSite.navigation.externalLink') }}
                </button>
              </div>
            </ElFormItem>

            <template v-if="selectedDraft.type === DOCUMENT_PUBLICATION_NAV_ITEM_TYPE.INTERNAL">
              <ElFormItem :label="t('docs.publicationSite.navigation.internalTarget')">
                <ElSelect
                  :model-value="selectedDraft.target"
                  @change="value => patchDraft(selectedDraft.localId, { target: value, targetId: '' })"
                >
                  <ElOption :label="t('docs.publicationSite.navigation.home')" :value="DOCUMENT_PUBLICATION_NAV_ITEM_INTERNAL_TARGET.HOME" />
                  <ElOption :label="t('docs.publicationSite.navigation.section')" :value="DOCUMENT_PUBLICATION_NAV_ITEM_INTERNAL_TARGET.SECTION" />
                  <ElOption :label="t('docs.publicationSite.navigation.page')" :value="DOCUMENT_PUBLICATION_NAV_ITEM_INTERNAL_TARGET.PAGE" />
                </ElSelect>
              </ElFormItem>

              <ElFormItem
                v-if="selectedDraft.target !== DOCUMENT_PUBLICATION_NAV_ITEM_INTERNAL_TARGET.HOME"
                :label="t('docs.publicationSite.navigation.target')"
              >
                <ElSelect
                  :model-value="selectedDraft.targetId"
                  :placeholder="t('docs.publicationSite.navigation.chooseTarget')"
                  :no-data-text="t('docs.publicationSite.navigation.noTargets')"
                  @change="value => patchDraft(selectedDraft.localId, { targetId: value })"
                >
                  <ElOption
                    v-for="option in resolveTargetOptions(selectedDraft)"
                    :key="option.value"
                    :label="option.label"
                    :value="option.value"
                  />
                </ElSelect>
              </ElFormItem>
            </template>

            <template v-else-if="selectedDraft.type === DOCUMENT_PUBLICATION_NAV_ITEM_TYPE.EXTERNAL">
              <ElFormItem :label="t('docs.publicationSite.navigation.target')">
                <ElInput
                  :model-value="selectedDraft.url"
                  placeholder="https://example.com"
                  @update:model-value="value => patchDraft(selectedDraft.localId, { url: value })"
                />
              </ElFormItem>
            </template>
          </ElForm>
        </section>

        <section v-else class="publication-site-navigation-panel__panel rounded-xl border bg-surface p-4">
          <Empty compact :description="t('docs.publicationSite.navigation.selectItem')" />
        </section>
      </aside>
    </div>
  </section>
</template>

<style scoped lang="scss">
.publication-site-navigation-panel__surface,
.publication-site-navigation-panel__panel {
  border-color: color-mix(in srgb, var(--brand-border-base) 72%, transparent);
}

.publication-site-navigation-panel__surface,
.publication-site-navigation-panel__panel {
  box-shadow: var(--brand-shadow-hairline);
}

.publication-site-navigation-panel__surface {
  min-height: 34rem;
}

.publication-site-navigation-panel__table {
  --el-table-bg-color: transparent;
  --el-table-tr-bg-color: transparent;
  --el-table-header-bg-color: color-mix(in srgb, var(--brand-fill-lighter) 34%, white);
  --el-table-border-color: color-mix(in srgb, var(--brand-border-base) 58%, transparent);
  --el-table-row-hover-bg-color: color-mix(in srgb, var(--brand-primary) 4%, white);

  :deep(th.el-table__cell) {
    height: 3.25rem;
    color: var(--brand-text-tertiary);
    font-weight: 600;
  }

  :deep(td.el-table__cell) {
    height: 4rem;
  }

  :deep(.el-table__expand-icon) {
    position: relative;
    left: -0.25rem;
  }

  :deep(.el-table__row) {
    cursor: pointer;
  }

  :deep(.el-table__row.is-selected > td.el-table__cell) {
    background: color-mix(in srgb, var(--brand-primary) 6%, white);
  }

}

.publication-site-navigation-panel__item-icon {
  background: color-mix(in srgb, var(--brand-primary) 10%, white);
  color: var(--brand-primary);

  img {
    display: block;
    max-width: calc(100% - 0.5rem);
    max-height: calc(100% - 0.5rem);
    object-fit: contain;
  }
}

.publication-site-navigation-panel__icon-upload {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 0.75rem;
  align-items: center;
}

.publication-site-navigation-panel__icon-preview {
  position: relative;
  display: grid;
  place-items: center;
  overflow: hidden;
  width: 3rem;
  height: 3rem;
  border: 1px dashed color-mix(in srgb, var(--brand-border-base) 84%, transparent);
  border-radius: 0.5rem;
  background: color-mix(in srgb, var(--brand-fill-lighter) 52%, var(--brand-bg-surface));
  color: var(--brand-primary);

  img {
    display: block;
    max-width: calc(100% - 0.5rem);
    max-height: calc(100% - 0.5rem);
    object-fit: contain;
  }
}

.publication-site-navigation-panel__upload-mask {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  background: color-mix(in srgb, var(--brand-bg-surface) 78%, transparent);
  color: var(--brand-text-primary);
  font-size: 0.75rem;
  font-weight: 600;
}

.publication-site-navigation-panel__icon-actions :deep(.el-upload) {
  display: inline-flex;
  align-items: center;
}

.publication-site-navigation-panel__icon-button {
  transition: background 0.18s ease, color 0.18s ease;

  &:hover {
    background: color-mix(in srgb, var(--brand-primary) 10%, white);
    color: var(--brand-primary);
  }
}

.publication-site-navigation-panel__type-group {
  display: grid;
  overflow: hidden;
  width: 100%;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  border: 1px solid color-mix(in srgb, var(--brand-border-base) 82%, transparent);
  border-radius: 0.5rem;
  background: var(--brand-bg-surface);
}

.publication-site-navigation-panel__type-option {
  min-width: 0;
  height: 2rem;
  padding: 0 0.75rem;
  border: 0;
  border-right: 1px solid color-mix(in srgb, var(--brand-border-base) 82%, transparent);
  background: transparent;
  color: var(--brand-text-secondary);
  font-size: 0.875rem;
  font-weight: 600;
  cursor: pointer;
  transition: none;

  &:last-child {
    border-right: 0;
  }

  &:hover {
    background: color-mix(in srgb, var(--brand-primary) 6%, var(--brand-bg-surface));
    color: var(--brand-primary);
  }

  &:disabled {
    color: var(--brand-text-placeholder);
    cursor: not-allowed;
  }

  &.is-active {
    background: var(--brand-primary);
    color: white;
  }
}
</style>
