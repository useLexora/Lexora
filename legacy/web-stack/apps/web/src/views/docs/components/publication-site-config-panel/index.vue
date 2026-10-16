<script setup lang="ts">
import type { FormInstance, FormRules, UploadRequestOptions } from 'element-plus'
import type {
  PublicationSiteConfigPanelEmits,
  PublicationSiteConfigPanelProps,
  SiteConfigForm,
  SiteHomeActionDraft,
  SiteHomeConfigDraft,
  SiteHomeFeatureDraft,
} from './typing'
import type {
  DocumentSinglePublicationTreeItem,
  PublicationPage,
  PublicationSection,
  PublicationSite,
  PublicationSiteHomeConfig,
  PublicationSiteMediaKind,
} from '@/apis/document-publication'
import { ArrowDown, ArrowUp, Delete, Plus, Upload } from '@element-plus/icons-vue'
import {
  DOCUMENT_PUBLICATION_DEFAULT_SITE_HOME_CONFIG,
  DOCUMENT_PUBLICATION_ENTRY_STATUS,
  DOCUMENT_PUBLICATION_SITE_CUSTOM_MEDIA_MAX_BYTES_BY_SCOPE,
  DOCUMENT_PUBLICATION_SITE_CUSTOM_MEDIA_SCOPE,
  DOCUMENT_PUBLICATION_SITE_FOOTER_COPYRIGHT_MAX_LENGTH,
  DOCUMENT_PUBLICATION_SITE_FOOTER_MESSAGE_MAX_LENGTH,
  DOCUMENT_PUBLICATION_SITE_HOME_ACTION_LABEL_MAX_LENGTH,
  DOCUMENT_PUBLICATION_SITE_HOME_ACTION_MAX_COUNT,
  DOCUMENT_PUBLICATION_SITE_HOME_FEATURE_DETAILS_MAX_LENGTH,
  DOCUMENT_PUBLICATION_SITE_HOME_FEATURE_MAX_COUNT,
  DOCUMENT_PUBLICATION_SITE_HOME_FEATURE_TITLE_MAX_LENGTH,
  DOCUMENT_PUBLICATION_SITE_HOME_MODE,
  DOCUMENT_PUBLICATION_SITE_HOME_NAME_MAX_LENGTH,
  DOCUMENT_PUBLICATION_SITE_HOME_TAGLINE_MAX_LENGTH,
  DOCUMENT_PUBLICATION_SITE_HOME_TEXT_MAX_LENGTH,
  DOCUMENT_PUBLICATION_SITE_MEDIA_KIND,
  DOCUMENT_PUBLICATION_SITE_MEDIA_MAX_BYTES_BY_KIND,
  DOCUMENT_PUBLICATION_SITE_MEDIA_MIME_TYPES,
  DOCUMENT_PUBLICATION_SITE_STATUS,
  DOCUMENT_PUBLICATION_SITE_THEME,
  DOCUMENT_PUBLICATION_SITE_TITLE_MAX_LENGTH,
  DOCUMENT_SITE_PUBLICATION_PAGE_SCOPE,
} from '@haohaoxue/lexora-contracts/document/publication/constants'
import { prettyBytes } from '@haohaoxue/lexora-shared/file'
import { computed, reactive, useTemplateRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { ElMessage } from '@/utils/element-plus'

const props = withDefaults(defineProps<PublicationSiteConfigPanelProps>(), {
  loading: false,
  saving: false,
  uploadingMediaKind: null,
  uploadingCustomMediaKey: '',
})
const emits = defineEmits<PublicationSiteConfigPanelEmits>()
const formRef = useTemplateRef<FormInstance>('formRef')
const { t } = useI18n()

interface HomeActionTargetOption {
  value: string
  label: string
  disabled?: boolean
  children: HomeActionTargetOption[]
}

const siteConfigForm = reactive<SiteConfigForm>({
  title: '',
  logoUrl: '',
  siteAccessEnabled: true,
  heroName: '',
  heroText: '',
  heroTagline: '',
  heroImageUrl: '',
  actions: [],
  features: [],
  footerMessage: '',
  footerCopyright: '',
})
const siteConfigRules = computed<FormRules<SiteConfigForm>>(() => ({
  title: [
    { required: true, message: t('docs.publicationSite.validation.siteTitleRequired'), trigger: 'blur' },
    {
      min: 1,
      max: DOCUMENT_PUBLICATION_SITE_TITLE_MAX_LENGTH,
      message: t('docs.publicationSite.validation.siteTitleMax', { max: DOCUMENT_PUBLICATION_SITE_TITLE_MAX_LENGTH }),
      trigger: 'blur',
    },
  ],
  heroName: [
    { required: true, message: t('docs.publicationSite.validation.homeNameRequired'), trigger: 'blur' },
    { min: 1, max: DOCUMENT_PUBLICATION_SITE_HOME_NAME_MAX_LENGTH, message: t('docs.publicationSite.validation.homeNameMax', { max: DOCUMENT_PUBLICATION_SITE_HOME_NAME_MAX_LENGTH }), trigger: 'blur' },
  ],
  heroText: [
    { required: true, message: t('docs.publicationSite.validation.homeTextRequired'), trigger: 'blur' },
    { min: 1, max: DOCUMENT_PUBLICATION_SITE_HOME_TEXT_MAX_LENGTH, message: t('docs.publicationSite.validation.homeTextMax', { max: DOCUMENT_PUBLICATION_SITE_HOME_TEXT_MAX_LENGTH }), trigger: 'blur' },
  ],
  heroTagline: [
    { max: DOCUMENT_PUBLICATION_SITE_HOME_TAGLINE_MAX_LENGTH, message: t('docs.publicationSite.validation.homeTaglineMax', { max: DOCUMENT_PUBLICATION_SITE_HOME_TAGLINE_MAX_LENGTH }), trigger: 'blur' },
  ],
  footerMessage: [
    { max: DOCUMENT_PUBLICATION_SITE_FOOTER_MESSAGE_MAX_LENGTH, message: t('docs.publicationSite.validation.footerMessageMax', { max: DOCUMENT_PUBLICATION_SITE_FOOTER_MESSAGE_MAX_LENGTH }), trigger: 'blur' },
  ],
  footerCopyright: [
    { max: DOCUMENT_PUBLICATION_SITE_FOOTER_COPYRIGHT_MAX_LENGTH, message: t('docs.publicationSite.validation.footerCopyrightMax', { max: DOCUMENT_PUBLICATION_SITE_FOOTER_COPYRIGHT_MAX_LENGTH }), trigger: 'blur' },
  ],
}))

const mediaAccept = DOCUMENT_PUBLICATION_SITE_MEDIA_MIME_TYPES.join(',')
const siteLogoMediaSizeLimitLabel = prettyBytes(DOCUMENT_PUBLICATION_SITE_MEDIA_MAX_BYTES_BY_KIND[DOCUMENT_PUBLICATION_SITE_MEDIA_KIND.LOGO])
const homeLogoMediaSizeLimitLabel = prettyBytes(DOCUMENT_PUBLICATION_SITE_MEDIA_MAX_BYTES_BY_KIND[DOCUMENT_PUBLICATION_SITE_MEDIA_KIND.HOME_LOGO])
const customIconMediaSizeLimitLabel = prettyBytes(DOCUMENT_PUBLICATION_SITE_CUSTOM_MEDIA_MAX_BYTES_BY_SCOPE[DOCUMENT_PUBLICATION_SITE_CUSTOM_MEDIA_SCOPE.HOME_FEATURE_ICON])
const isSiteLogoUploading = computed(() => props.uploadingMediaKind === DOCUMENT_PUBLICATION_SITE_MEDIA_KIND.LOGO)
const isHomeLogoUploading = computed(() => props.uploadingMediaKind === DOCUMENT_PUBLICATION_SITE_MEDIA_KIND.HOME_LOGO)
const isAnyMediaUploading = computed(() => Boolean(props.uploadingMediaKind || props.uploadingCustomMediaKey))
const isPersistedSiteAccessEnabled = computed(() => props.site?.status === DOCUMENT_PUBLICATION_SITE_STATUS.ACTIVE)
const sitePreviewUrl = computed(() => props.site && isPersistedSiteAccessEnabled.value ? `/s/${props.site.id}` : '')
const sitePreviewKey = computed(() => props.site ? `${props.site.id}:${props.site.updatedAt}` : 'empty')
const activeSections = computed(() =>
  [...props.sections]
    .filter(section => section.status === DOCUMENT_PUBLICATION_ENTRY_STATUS.ACTIVE)
    .sort(compareOrderedItem),
)
const activePages = computed(() =>
  [...props.pages]
    .filter(page => page.status === DOCUMENT_PUBLICATION_ENTRY_STATUS.ACTIVE)
    .sort(compareOrderedItem),
)
const homeActionTargetOptions = computed(() =>
  buildHomeActionTargetOptions({
    sections: activeSections.value,
    pages: activePages.value,
    tree: props.tree,
  }),
)
const selectableHomeActionDocumentIds = computed(() => {
  const documentIds = new Set<string>()

  collectHomeActionTargetDocumentIds(homeActionTargetOptions.value, documentIds)
  return documentIds
})
const defaultHomeActionTargetDocumentId = computed(() =>
  findFirstHomeActionTargetDocumentId(homeActionTargetOptions.value),
)

function resolveSegmentedOptionStyle(active: boolean) {
  return active
    ? 'background-color: var(--brand-primary) !important; color: #fff !important;'
    : 'background-color: transparent !important; color: var(--brand-text-secondary) !important;'
}

watch(
  [() => props.site, () => props.sections, () => props.pages, () => props.tree],
  ([site]) => {
    if (props.uploadingMediaKind) {
      syncUploadedMediaFields(site, props.uploadingMediaKind)
      return
    }

    resetSiteConfigForm(site)
  },
  { immediate: true },
)

async function submitSiteConfig() {
  await formRef.value?.validate()

  if (!validateHomeActions() || !validateHomeFeatures()) {
    return
  }

  emits('save', {
    title: siteConfigForm.title.trim(),
    logoUrl: toNullableText(siteConfigForm.logoUrl),
    theme: DOCUMENT_PUBLICATION_SITE_THEME.DEFAULT,
    status: siteConfigForm.siteAccessEnabled
      ? DOCUMENT_PUBLICATION_SITE_STATUS.ACTIVE
      : DOCUMENT_PUBLICATION_SITE_STATUS.DISABLED,
    homeMode: DOCUMENT_PUBLICATION_SITE_HOME_MODE.LANDING,
    homeDocumentId: null,
    homeConfig: buildHomeConfig(),
  })
}

function resetSiteConfigForm(site: PublicationSite | null) {
  const homeConfig = site?.homeConfig ?? cloneDefaultHomeConfig()

  siteConfigForm.title = site?.title ?? ''
  siteConfigForm.logoUrl = site?.logoUrl ?? ''
  siteConfigForm.siteAccessEnabled = !site || site.status === DOCUMENT_PUBLICATION_SITE_STATUS.ACTIVE
  siteConfigForm.heroName = homeConfig.hero.name
  siteConfigForm.heroText = homeConfig.hero.text
  siteConfigForm.heroTagline = homeConfig.hero.tagline ?? ''
  siteConfigForm.heroImageUrl = homeConfig.hero.imageUrl ?? ''
  siteConfigForm.actions = homeConfig.actions.map(toActionDraft)
  siteConfigForm.features = homeConfig.features.map(toFeatureDraft)
  siteConfigForm.footerMessage = homeConfig.footer.message ?? ''
  siteConfigForm.footerCopyright = homeConfig.footer.copyright ?? ''
  formRef.value?.clearValidate()
}

function buildHomeConfig(): PublicationSiteHomeConfig {
  return {
    hero: {
      name: siteConfigForm.heroName.trim(),
      text: siteConfigForm.heroText.trim(),
      tagline: toNullableText(siteConfigForm.heroTagline),
      imageUrl: toNullableText(siteConfigForm.heroImageUrl),
    },
    actions: siteConfigForm.actions
      .map(action => ({
        label: action.label.trim(),
        href: resolveHomeActionHref(action.targetDocumentId),
        theme: action.theme,
      })),
    features: siteConfigForm.features
      .map(feature => ({
        title: feature.title.trim(),
        details: toNullableText(feature.details),
        icon: toNullableText(feature.icon),
      })),
    footer: {
      message: toNullableText(siteConfigForm.footerMessage),
      copyright: toNullableText(siteConfigForm.footerCopyright),
    },
  }
}

function addHomeAction() {
  if (siteConfigForm.actions.length >= DOCUMENT_PUBLICATION_SITE_HOME_ACTION_MAX_COUNT) {
    return
  }

  siteConfigForm.actions.push({
    localId: crypto.randomUUID(),
    label: '',
    targetDocumentId: defaultHomeActionTargetDocumentId.value,
    theme: 'brand',
  })
}

function removeHomeAction(localId: string) {
  siteConfigForm.actions = siteConfigForm.actions.filter(action => action.localId !== localId)
}

function moveHomeAction(localId: string, direction: -1 | 1) {
  siteConfigForm.actions = moveDraftItem(siteConfigForm.actions, localId, direction)
}

function addHomeFeature() {
  if (siteConfigForm.features.length >= DOCUMENT_PUBLICATION_SITE_HOME_FEATURE_MAX_COUNT) {
    return
  }

  siteConfigForm.features.push({
    localId: crypto.randomUUID(),
    title: '',
    details: '',
    icon: '',
  })
}

function removeHomeFeature(localId: string) {
  siteConfigForm.features = siteConfigForm.features.filter(feature => feature.localId !== localId)
}

function moveHomeFeature(localId: string, direction: -1 | 1) {
  siteConfigForm.features = moveDraftItem(siteConfigForm.features, localId, direction)
}

function isDraftMoveDisabled(items: Array<{ localId: string }>, localId: string, direction: -1 | 1) {
  const index = items.findIndex(item => item.localId === localId)

  return index < 0 || index + direction < 0 || index + direction >= items.length
}

function moveDraftItem<T extends { localId: string }>(items: T[], localId: string, direction: -1 | 1): T[] {
  const currentIndex = items.findIndex(item => item.localId === localId)
  const nextIndex = currentIndex + direction

  if (currentIndex < 0 || nextIndex < 0 || nextIndex >= items.length) {
    return items
  }

  const nextItems = [...items]
  const [currentItem] = nextItems.splice(currentIndex, 1)

  if (!currentItem) {
    return items
  }

  nextItems.splice(nextIndex, 0, currentItem)
  return nextItems
}

function validateHomeActions() {
  for (const action of siteConfigForm.actions) {
    const label = action.label.trim()

    if (!label) {
      ElMessage.warning(t('docs.publicationSite.validation.actionLabelRequired'))
      return false
    }

    if (!selectableHomeActionDocumentIds.value.has(action.targetDocumentId)) {
      ElMessage.warning(t('docs.publicationSite.validation.actionTargetRequired', { label }))
      return false
    }
  }

  return true
}

function validateHomeFeatures() {
  for (const feature of siteConfigForm.features) {
    if (!feature.title.trim()) {
      ElMessage.warning(t('docs.publicationSite.validation.featureTitleRequired'))
      return false
    }
  }

  return true
}

function beforeMediaUpload(kind: PublicationSiteMediaKind, file: File) {
  if (!(DOCUMENT_PUBLICATION_SITE_MEDIA_MIME_TYPES as readonly string[]).includes(file.type)) {
    ElMessage.error(t('docs.publicationSite.validation.unsupportedImageType'))
    return false
  }

  const maxBytes = DOCUMENT_PUBLICATION_SITE_MEDIA_MAX_BYTES_BY_KIND[kind]

  if (file.size > maxBytes) {
    ElMessage.error(t('docs.publicationSite.validation.imageTooLarge', { size: prettyBytes(maxBytes) }))
    return false
  }

  return true
}

function beforeCustomMediaUpload(file: File) {
  if (!(DOCUMENT_PUBLICATION_SITE_MEDIA_MIME_TYPES as readonly string[]).includes(file.type)) {
    ElMessage.error(t('docs.publicationSite.validation.unsupportedImageType'))
    return false
  }

  const maxBytes = DOCUMENT_PUBLICATION_SITE_CUSTOM_MEDIA_MAX_BYTES_BY_SCOPE[DOCUMENT_PUBLICATION_SITE_CUSTOM_MEDIA_SCOPE.HOME_FEATURE_ICON]

  if (file.size > maxBytes) {
    ElMessage.error(t('docs.publicationSite.validation.imageTooLarge', { size: prettyBytes(maxBytes) }))
    return false
  }

  return true
}

function handleMediaUploadRequest(kind: PublicationSiteMediaKind, options: UploadRequestOptions) {
  if (props.saving || isAnyMediaUploading.value) {
    const error = new Error(t('docs.publicationSite.validation.mediaUploading'))
    return Promise.reject(error)
  }

  emits('uploadMedia', kind, options.file)
  options.onSuccess({})
  return Promise.resolve({})
}

async function handleFeatureIconUploadRequest(feature: SiteHomeFeatureDraft, options: UploadRequestOptions) {
  if (props.saving || isAnyMediaUploading.value || !props.uploadCustomMedia) {
    const error = new Error(t('docs.publicationSite.validation.mediaUploading'))
    return Promise.reject(error)
  }

  const mediaUrl = await props.uploadCustomMedia(
    DOCUMENT_PUBLICATION_SITE_CUSTOM_MEDIA_SCOPE.HOME_FEATURE_ICON,
    feature.localId,
    options.file,
  )

  if (!mediaUrl) {
    const error = new Error(t('docs.publicationSite.messages.mediaUploadFailed'))
    return Promise.reject(error)
  }

  feature.icon = mediaUrl
  options.onSuccess({})
  return Promise.resolve({})
}

function handleRemoveMedia(kind: PublicationSiteMediaKind) {
  if (props.saving || isAnyMediaUploading.value) {
    return
  }

  emits('removeMedia', kind)
}

function removeHomeFeatureIcon(feature: SiteHomeFeatureDraft) {
  if (props.saving || isAnyMediaUploading.value) {
    return
  }

  feature.icon = ''
}

function isHomeFeatureIconUploading(feature: SiteHomeFeatureDraft) {
  return props.uploadingCustomMediaKey === `${DOCUMENT_PUBLICATION_SITE_CUSTOM_MEDIA_SCOPE.HOME_FEATURE_ICON}:${feature.localId}`
}

function isUploadedMediaSource(value: string | null | undefined) {
  const source = value?.trim() ?? ''

  return source.startsWith('/') || /^https?:\/\//i.test(source)
}

function hidePreviewIframeScrollbar(event: Event) {
  const iframe = event.target as HTMLIFrameElement | null
  const frameDocument = iframe?.contentDocument

  if (!frameDocument) {
    return
  }

  frameDocument.documentElement.style.overflow = 'hidden'
  frameDocument.body.style.overflow = 'hidden'
}

function syncUploadedMediaFields(site: PublicationSite | null, kind: PublicationSiteMediaKind) {
  if (!site) {
    return
  }

  if (kind === DOCUMENT_PUBLICATION_SITE_MEDIA_KIND.LOGO) {
    siteConfigForm.logoUrl = site.logoUrl ?? ''
    return
  }

  siteConfigForm.heroImageUrl = site.homeConfig.hero.imageUrl ?? ''
}

function cloneDefaultHomeConfig(): SiteHomeConfigDraft {
  return JSON.parse(JSON.stringify(DOCUMENT_PUBLICATION_DEFAULT_SITE_HOME_CONFIG)) as PublicationSiteHomeConfig
}

function toActionDraft(action: PublicationSiteHomeConfig['actions'][number]): SiteHomeActionDraft {
  return {
    localId: crypto.randomUUID(),
    label: action.label,
    targetDocumentId: resolveActionTargetDocumentId(action.href),
    theme: action.theme,
  }
}

function resolveActionTargetDocumentId(href: string) {
  const siteId = props.site?.id ?? ''

  if (!siteId) {
    return ''
  }

  const normalizedHref = href.trim()
  const segments = normalizedHref.split('/').filter(Boolean)

  if (segments.length !== 3 || segments[0] !== 's' || segments[1] !== siteId) {
    return ''
  }

  const targetDocumentId = segments[2] ?? ''

  return selectableHomeActionDocumentIds.value.has(targetDocumentId)
    ? targetDocumentId
    : ''
}

function resolveHomeActionHref(targetDocumentId: string) {
  const siteId = props.site?.id ?? ''

  if (!siteId || !selectableHomeActionDocumentIds.value.has(targetDocumentId)) {
    return ''
  }

  return `/s/${siteId}/${targetDocumentId}`
}

function buildHomeActionTargetOptions(input: {
  sections: PublicationSection[]
  pages: PublicationPage[]
  tree: DocumentSinglePublicationTreeItem[]
}): HomeActionTargetOption[] {
  return input.sections.flatMap((section) => {
    const seenDocumentIds = new Set<string>()
    const sectionPageOptions = input.pages
      .filter(page => page.sectionId === section.id)
      .flatMap((page) => {
        const option = buildHomeActionTargetPageOption(page, input.tree, seenDocumentIds)
        return option ? [option] : []
      })

    if (!sectionPageOptions.length) {
      return []
    }

    return [{
      value: `section:${section.id}`,
      label: section.title,
      disabled: true,
      children: sectionPageOptions,
    }]
  })
}

function buildHomeActionTargetPageOption(
  page: PublicationPage,
  tree: DocumentSinglePublicationTreeItem[],
  seenDocumentIds: Set<string>,
): HomeActionTargetOption | null {
  if (seenDocumentIds.has(page.documentId)) {
    return null
  }

  seenDocumentIds.add(page.documentId)
  const sourceDocument = findDocumentTreeItem(tree, page.documentId)

  return {
    value: page.documentId,
    label: sourceDocument?.title || page.title || t('docs.common.noTitle'),
    children: page.scope === DOCUMENT_SITE_PUBLICATION_PAGE_SCOPE.DESCENDANTS
      ? buildHomeActionTargetDescendantOptions(sourceDocument?.children ?? [], seenDocumentIds)
      : [],
  }
}

function buildHomeActionTargetDescendantOptions(
  items: DocumentSinglePublicationTreeItem[],
  seenDocumentIds: Set<string>,
): HomeActionTargetOption[] {
  return items.flatMap((item) => {
    if (seenDocumentIds.has(item.id)) {
      return []
    }

    seenDocumentIds.add(item.id)

    return [{
      value: item.id,
      label: item.title || t('docs.common.noTitle'),
      children: buildHomeActionTargetDescendantOptions(item.children, seenDocumentIds),
    }]
  })
}

function collectHomeActionTargetDocumentIds(items: HomeActionTargetOption[], target: Set<string>) {
  for (const item of items) {
    if (!item.value.startsWith('section:')) {
      target.add(item.value)
    }

    collectHomeActionTargetDocumentIds(item.children, target)
  }
}

function findFirstHomeActionTargetDocumentId(items: HomeActionTargetOption[]): string {
  for (const item of items) {
    if (!item.value.startsWith('section:')) {
      return item.value
    }

    const childValue = findFirstHomeActionTargetDocumentId(item.children)

    if (childValue) {
      return childValue
    }
  }

  return ''
}

function findDocumentTreeItem(
  items: DocumentSinglePublicationTreeItem[],
  documentId: string,
): DocumentSinglePublicationTreeItem | null {
  for (const item of items) {
    if (item.id === documentId) {
      return item
    }

    const child = findDocumentTreeItem(item.children, documentId)

    if (child) {
      return child
    }
  }

  return null
}

function compareOrderedItem(left: { order: number, updatedAt: string }, right: { order: number, updatedAt: string }) {
  if (left.order !== right.order) {
    return left.order - right.order
  }

  return right.updatedAt.localeCompare(left.updatedAt)
}

function toFeatureDraft(feature: PublicationSiteHomeConfig['features'][number]): SiteHomeFeatureDraft {
  return {
    localId: resolveCustomMediaIdFromUrl(feature.icon, DOCUMENT_PUBLICATION_SITE_CUSTOM_MEDIA_SCOPE.HOME_FEATURE_ICON) ?? crypto.randomUUID(),
    title: feature.title,
    details: feature.details ?? '',
    icon: feature.icon ?? '',
  }
}

function resolveCustomMediaIdFromUrl(value: string | null | undefined, scope: string): string | null {
  const match = value?.match(new RegExp(`/custom/${scope}/([\\w-]+)`))

  return match?.[1] ?? null
}

function toNullableText(value: string | null | undefined) {
  const text = value?.trim() ?? ''

  return text || null
}
</script>

<template>
  <section class="publication-site-config-panel grid gap-5">
    <header class="publication-site-config-panel__header flex flex-wrap items-center justify-between gap-4">
      <h2 class="m-0 text-xl font-semibold leading-7 text-main">
        {{ t('docs.publicationSite.config.title') }}
      </h2>

      <div class="flex flex-wrap items-center justify-end gap-3">
        <div class="publication-site-config-panel__access-toggle flex items-center gap-3 rounded-lg border px-3 py-2">
          <span class="text-sm font-medium leading-5 text-main">{{ t('docs.publicationSite.config.accessEnabled') }}</span>
          <ElSwitch
            v-model="siteConfigForm.siteAccessEnabled"
            size="small"
          />
        </div>
        <ElButton type="primary" :loading="saving" @click="submitSiteConfig">
          {{ t('docs.publicationSite.config.saveSettings') }}
        </ElButton>
      </div>
    </header>

    <ElSkeleton v-if="loading" animated>
      <template #template>
        <div class="publication-site-config-panel__body grid items-start gap-5 max-[1280px]:grid-cols-1">
          <section class="rounded-xl border border-border-a60 bg-surface p-5">
            <div class="grid gap-5">
              <ElSkeletonItem variant="h3" class="max-w-36" />
              <div class="publication-site-config-panel__two-column grid gap-4 max-[720px]:grid-cols-1">
                <ElSkeletonItem variant="rect" class="h-10 w-full" />
                <ElSkeletonItem variant="rect" class="h-10 w-full" />
              </div>
              <ElSkeletonItem variant="h3" class="max-w-36" />
              <ElSkeletonItem variant="rect" class="h-32 w-full" />
              <ElSkeletonItem variant="rect" class="h-24 w-full" />
            </div>
          </section>
        </div>
      </template>
    </ElSkeleton>

    <div v-else class="publication-site-config-panel__body grid items-start gap-5 max-[1280px]:grid-cols-1">
      <ElForm
        ref="formRef"
        :model="siteConfigForm"
        :rules="siteConfigRules"
        label-position="top"
        class="publication-site-config-panel__form border bg-surface"
      >
        <section class="publication-site-config-panel__section grid gap-3">
          <h2 class="m-0 text-base font-semibold leading-6 text-main">
            {{ t('docs.publicationSite.config.siteInfo') }}
          </h2>

          <div class="publication-site-config-panel__two-column grid gap-4 max-[720px]:grid-cols-1">
            <ElFormItem :label="t('docs.publicationSite.config.siteTitle')" prop="title">
              <ElInput
                v-model="siteConfigForm.title"
                :maxlength="DOCUMENT_PUBLICATION_SITE_TITLE_MAX_LENGTH"
                show-word-limit
              />
            </ElFormItem>

            <ElFormItem :label="t('docs.publicationSite.config.siteLogo')" prop="logoUrl">
              <div class="publication-site-config-panel__asset-row">
                <div class="publication-site-config-panel__asset-preview publication-site-config-panel__asset-preview--site">
                  <img
                    v-if="siteConfigForm.logoUrl"
                    :src="siteConfigForm.logoUrl"
                    :alt="t('docs.publicationSite.config.logoAlt')"
                  >
                  <div v-else class="publication-site-config-panel__asset-empty">
                    <ElIcon size="20">
                      <Plus />
                    </ElIcon>
                  </div>
                  <span v-if="isSiteLogoUploading" class="publication-site-config-panel__upload-mask">{{ t('docs.publicationSite.config.uploading') }}</span>
                </div>

                <div class="grid min-w-0 gap-0.5">
                  <span class="text-sm font-medium leading-5 text-main">{{ t('docs.publicationSite.config.siteNavigationLogo') }}</span>
                  <span class="text-xs leading-5 text-secondary">{{ t('docs.publicationSite.config.mediaHint', { size: siteLogoMediaSizeLimitLabel }) }}</span>
                </div>

                <div class="publication-site-config-panel__asset-actions">
                  <ElUpload
                    action="#"
                    :accept="mediaAccept"
                    :show-file-list="false"
                    :disabled="saving || isAnyMediaUploading"
                    :before-upload="file => beforeMediaUpload(DOCUMENT_PUBLICATION_SITE_MEDIA_KIND.LOGO, file)"
                    :http-request="options => handleMediaUploadRequest(DOCUMENT_PUBLICATION_SITE_MEDIA_KIND.LOGO, options)"
                  >
                    <ElButton :icon="Upload" :disabled="saving || isAnyMediaUploading">
                      {{ t('docs.publicationSite.config.upload') }}
                    </ElButton>
                  </ElUpload>
                  <ElButton
                    v-if="siteConfigForm.logoUrl"
                    :icon="Delete"
                    :disabled="saving || isAnyMediaUploading"
                    @click="handleRemoveMedia(DOCUMENT_PUBLICATION_SITE_MEDIA_KIND.LOGO)"
                  >
                    {{ t('docs.publicationSite.config.remove') }}
                  </ElButton>
                </div>
              </div>
            </ElFormItem>
          </div>
        </section>

        <section class="publication-site-config-panel__section grid gap-3">
          <h2 class="m-0 mt-8px text-base font-semibold leading-6 text-main">
            {{ t('docs.publicationSite.config.home') }}
          </h2>

          <div class="publication-site-config-panel__two-column grid gap-4 max-[720px]:grid-cols-1">
            <div class="grid content-start gap-3">
              <ElFormItem :label="t('docs.publicationSite.config.homeName')" prop="heroName">
                <ElInput
                  v-model="siteConfigForm.heroName"
                  :maxlength="DOCUMENT_PUBLICATION_SITE_HOME_NAME_MAX_LENGTH"
                  show-word-limit
                />
              </ElFormItem>

              <ElFormItem :label="t('docs.publicationSite.config.homeText')" prop="heroText">
                <ElInput
                  v-model="siteConfigForm.heroText"
                  :maxlength="DOCUMENT_PUBLICATION_SITE_HOME_TEXT_MAX_LENGTH"
                  show-word-limit
                />
              </ElFormItem>

              <ElFormItem :label="t('docs.publicationSite.config.homeTagline')" prop="heroTagline">
                <ElInput
                  v-model="siteConfigForm.heroTagline"
                  type="textarea"
                  :rows="3"
                  :maxlength="DOCUMENT_PUBLICATION_SITE_HOME_TAGLINE_MAX_LENGTH"
                  show-word-limit
                />
              </ElFormItem>
            </div>

            <ElFormItem :label="t('docs.publicationSite.config.homeLogo')" prop="heroImageUrl">
              <div class="publication-site-config-panel__asset-row publication-site-config-panel__asset-row--home">
                <div class="publication-site-config-panel__asset-preview publication-site-config-panel__asset-preview--home">
                  <img
                    v-if="siteConfigForm.heroImageUrl"
                    :src="siteConfigForm.heroImageUrl"
                    :alt="t('docs.publicationSite.config.homeLogoAlt')"
                  >
                  <div v-else class="publication-site-config-panel__asset-empty">
                    <ElIcon size="24">
                      <Plus />
                    </ElIcon>
                  </div>
                  <span v-if="isHomeLogoUploading" class="publication-site-config-panel__upload-mask">{{ t('docs.publicationSite.config.uploading') }}</span>
                </div>

                <div class="grid min-w-0 gap-0.5">
                  <span class="text-sm font-medium leading-5 text-main">{{ t('docs.publicationSite.config.homeVisual') }}</span>
                  <span class="text-xs leading-5 text-secondary">{{ t('docs.publicationSite.config.homeVisualHint', { size: homeLogoMediaSizeLimitLabel }) }}</span>
                </div>

                <div class="publication-site-config-panel__asset-actions">
                  <ElUpload
                    action="#"
                    :accept="mediaAccept"
                    :show-file-list="false"
                    :disabled="saving || isAnyMediaUploading"
                    :before-upload="file => beforeMediaUpload(DOCUMENT_PUBLICATION_SITE_MEDIA_KIND.HOME_LOGO, file)"
                    :http-request="options => handleMediaUploadRequest(DOCUMENT_PUBLICATION_SITE_MEDIA_KIND.HOME_LOGO, options)"
                  >
                    <ElButton :icon="Upload" :disabled="saving || isAnyMediaUploading">
                      {{ t('docs.publicationSite.config.upload') }}
                    </ElButton>
                  </ElUpload>
                  <ElButton
                    v-if="siteConfigForm.heroImageUrl"
                    :icon="Delete"
                    :disabled="saving || isAnyMediaUploading"
                    @click="handleRemoveMedia(DOCUMENT_PUBLICATION_SITE_MEDIA_KIND.HOME_LOGO)"
                  >
                    {{ t('docs.publicationSite.config.remove') }}
                  </ElButton>
                </div>
              </div>
            </ElFormItem>
          </div>

          <div class="publication-site-config-panel__content-lists">
            <div class="publication-site-config-panel__list-block">
              <div class="publication-site-config-panel__list-header">
                <span class="text-sm font-semibold leading-5 text-main">{{ t('docs.publicationSite.config.homeActions') }}</span>
                <ElButton
                  text
                  :icon="Plus"
                  :disabled="siteConfigForm.actions.length >= DOCUMENT_PUBLICATION_SITE_HOME_ACTION_MAX_COUNT"
                  @click="addHomeAction"
                >
                  {{ t('docs.publicationSite.config.addAction') }}
                </ElButton>
              </div>

              <div v-if="siteConfigForm.actions.length" class="publication-site-config-panel__draft-list">
                <div
                  v-for="action in siteConfigForm.actions"
                  :key="action.localId"
                  class="publication-site-config-panel__draft-item publication-site-config-panel__draft-item--action"
                >
                  <div class="publication-site-config-panel__draft-main">
                    <ElInput
                      v-model="action.label"
                      :placeholder="t('docs.publicationSite.config.actionLabel')"
                      :maxlength="DOCUMENT_PUBLICATION_SITE_HOME_ACTION_LABEL_MAX_LENGTH"
                      show-word-limit
                    />
                    <ElTreeSelect
                      v-model="action.targetDocumentId"
                      :data="homeActionTargetOptions"
                      clearable
                      filterable
                      check-strictly
                      default-expand-all
                      :placeholder="t('docs.publicationSite.config.actionTarget')"
                      :disabled="!homeActionTargetOptions.length"
                    />
                    <div class="publication-site-config-panel__action-theme" role="radiogroup">
                      <button
                        type="button"
                        class="publication-site-config-panel__action-theme-option"
                        :class="{ 'is-active': action.theme === 'brand' }"
                        :style="resolveSegmentedOptionStyle(action.theme === 'brand')"
                        role="radio"
                        :aria-checked="action.theme === 'brand'"
                        @click="action.theme = 'brand'"
                      >
                        {{ t('docs.publicationSite.config.actionThemeBrand') }}
                      </button>
                      <button
                        type="button"
                        class="publication-site-config-panel__action-theme-option"
                        :class="{ 'is-active': action.theme === 'alt' }"
                        :style="resolveSegmentedOptionStyle(action.theme === 'alt')"
                        role="radio"
                        :aria-checked="action.theme === 'alt'"
                        @click="action.theme = 'alt'"
                      >
                        {{ t('docs.publicationSite.config.actionThemeAlt') }}
                      </button>
                    </div>
                  </div>

                  <div class="publication-site-config-panel__draft-actions">
                    <ElButton
                      text
                      class="publication-site-config-panel__icon-button"
                      :icon="ArrowUp"
                      :disabled="isDraftMoveDisabled(siteConfigForm.actions, action.localId, -1)"
                      :title="t('docs.publicationSite.config.moveUp')"
                      @click="moveHomeAction(action.localId, -1)"
                    />
                    <ElButton
                      text
                      class="publication-site-config-panel__icon-button"
                      :icon="ArrowDown"
                      :disabled="isDraftMoveDisabled(siteConfigForm.actions, action.localId, 1)"
                      :title="t('docs.publicationSite.config.moveDown')"
                      @click="moveHomeAction(action.localId, 1)"
                    />
                    <ElButton
                      text
                      class="publication-site-config-panel__icon-button"
                      :icon="Delete"
                      :title="t('docs.publicationSite.config.remove')"
                      @click="removeHomeAction(action.localId)"
                    />
                  </div>
                </div>
              </div>
              <p v-else class="publication-site-config-panel__empty-text">
                {{ t('docs.publicationSite.config.homeActionsEmpty') }}
              </p>
            </div>

            <div class="publication-site-config-panel__list-block">
              <div class="publication-site-config-panel__list-header">
                <span class="text-sm font-semibold leading-5 text-main">{{ t('docs.publicationSite.config.homeFeatures') }}</span>
                <ElButton
                  text
                  :icon="Plus"
                  :disabled="siteConfigForm.features.length >= DOCUMENT_PUBLICATION_SITE_HOME_FEATURE_MAX_COUNT"
                  @click="addHomeFeature"
                >
                  {{ t('docs.publicationSite.config.addFeature') }}
                </ElButton>
              </div>

              <div v-if="siteConfigForm.features.length" class="publication-site-config-panel__draft-list">
                <div
                  v-for="feature in siteConfigForm.features"
                  :key="feature.localId"
                  class="publication-site-config-panel__draft-item publication-site-config-panel__draft-item--feature"
                >
                  <div class="publication-site-config-panel__feature-icon-upload">
                    <ElUpload
                      class="publication-site-config-panel__feature-icon-trigger"
                      action="#"
                      :accept="mediaAccept"
                      :show-file-list="false"
                      :disabled="saving || isAnyMediaUploading"
                      :before-upload="beforeCustomMediaUpload"
                      :http-request="options => handleFeatureIconUploadRequest(feature, options)"
                    >
                      <div
                        class="publication-site-config-panel__feature-icon-preview"
                        :title="t('docs.publicationSite.config.uploadIcon')"
                      >
                        <img
                          v-if="isUploadedMediaSource(feature.icon)"
                          :src="feature.icon"
                          :alt="feature.title || t('docs.publicationSite.config.featureIcon')"
                        >
                        <ElIcon v-else size="24">
                          <Plus />
                        </ElIcon>
                        <ElButton
                          v-if="feature.icon"
                          text
                          class="publication-site-config-panel__feature-icon-remove"
                          :icon="Delete"
                          :disabled="saving || isAnyMediaUploading"
                          :title="t('docs.publicationSite.config.remove')"
                          @click.stop.prevent="removeHomeFeatureIcon(feature)"
                        />
                        <span v-if="isHomeFeatureIconUploading(feature)" class="publication-site-config-panel__upload-mask">{{ t('docs.publicationSite.config.uploading') }}</span>
                      </div>
                    </ElUpload>
                    <span class="publication-site-config-panel__feature-icon-hint text-xs leading-5 text-secondary">{{ t('docs.publicationSite.config.iconMediaHint', { size: customIconMediaSizeLimitLabel }) }}</span>
                  </div>

                  <div class="publication-site-config-panel__draft-main">
                    <ElInput
                      v-model="feature.title"
                      :placeholder="t('docs.publicationSite.config.featureTitle')"
                      :maxlength="DOCUMENT_PUBLICATION_SITE_HOME_FEATURE_TITLE_MAX_LENGTH"
                      show-word-limit
                    />
                    <ElInput
                      v-model="feature.details"
                      type="textarea"
                      :rows="2"
                      :placeholder="t('docs.publicationSite.config.featureDetails')"
                      :maxlength="DOCUMENT_PUBLICATION_SITE_HOME_FEATURE_DETAILS_MAX_LENGTH"
                      show-word-limit
                    />
                  </div>

                  <div class="publication-site-config-panel__draft-actions">
                    <ElButton
                      text
                      class="publication-site-config-panel__icon-button"
                      :icon="ArrowUp"
                      :disabled="isDraftMoveDisabled(siteConfigForm.features, feature.localId, -1)"
                      :title="t('docs.publicationSite.config.moveUp')"
                      @click="moveHomeFeature(feature.localId, -1)"
                    />
                    <ElButton
                      text
                      class="publication-site-config-panel__icon-button"
                      :icon="ArrowDown"
                      :disabled="isDraftMoveDisabled(siteConfigForm.features, feature.localId, 1)"
                      :title="t('docs.publicationSite.config.moveDown')"
                      @click="moveHomeFeature(feature.localId, 1)"
                    />
                    <ElButton
                      text
                      class="publication-site-config-panel__icon-button"
                      :icon="Delete"
                      :title="t('docs.publicationSite.config.remove')"
                      @click="removeHomeFeature(feature.localId)"
                    />
                  </div>
                </div>
              </div>
              <p v-else class="publication-site-config-panel__empty-text">
                {{ t('docs.publicationSite.config.homeFeaturesEmpty') }}
              </p>
            </div>
          </div>

          <div class="grid grid-cols-2 gap-3 max-[720px]:grid-cols-1">
            <ElFormItem :label="t('docs.publicationSite.config.footerMessage')" prop="footerMessage">
              <ElInput
                v-model="siteConfigForm.footerMessage"
                :maxlength="DOCUMENT_PUBLICATION_SITE_FOOTER_MESSAGE_MAX_LENGTH"
                show-word-limit
                clearable
              />
            </ElFormItem>

            <ElFormItem :label="t('docs.publicationSite.config.footerCopyright')" prop="footerCopyright">
              <ElInput
                v-model="siteConfigForm.footerCopyright"
                :maxlength="DOCUMENT_PUBLICATION_SITE_FOOTER_COPYRIGHT_MAX_LENGTH"
                show-word-limit
                clearable
              />
            </ElFormItem>
          </div>
        </section>
      </ElForm>

      <aside class="publication-site-config-panel__preview grid rounded-xl border bg-surface p-3" aria-labelledby="publication-site-config-panel-preview-title">
        <div class="flex items-center gap-2">
          <h2 id="publication-site-config-panel-preview-title" class="m-0 text-sm font-semibold leading-5 text-secondary">
            {{ t('docs.publicationSite.config.preview') }}
          </h2>
        </div>

        <div class="publication-site-config-panel__site-preview overflow-hidden rounded-xl border">
          <iframe
            v-if="sitePreviewUrl"
            :key="sitePreviewKey"
            class="h-full w-full border-0"
            :src="sitePreviewUrl"
            scrolling="no"
            :title="t('docs.publicationSite.config.previewIframeTitle')"
            @load="hidePreviewIframeScrollbar"
          />
          <div v-else class="grid h-full place-items-center px-6 text-center">
            <div class="grid gap-1">
              <strong class="text-sm font-semibold leading-5 text-main">
                {{ site ? t('docs.publicationSite.config.previewClosedTitle') : t('docs.publicationSite.config.previewUnsavedTitle') }}
              </strong>
              <span class="text-xs leading-5 text-secondary">
                {{ site ? t('docs.publicationSite.config.previewClosedDescription') : t('docs.publicationSite.config.previewUnsavedDescription') }}
              </span>
            </div>
          </div>
        </div>
      </aside>
    </div>
  </section>
</template>

<style scoped lang="scss">
.publication-site-config-panel__form,
.publication-site-config-panel__preview {
  border-color: color-mix(in srgb, var(--brand-border-base) 72%, transparent);
  box-shadow: var(--brand-shadow-hairline);
}

.publication-site-config-panel__form {
  max-height: var(--publication-site-config-panel-content-height);
  overflow-y: auto;
  scrollbar-gutter: stable;
}

.publication-site-config-panel__body {
  --publication-site-config-panel-content-height: calc(100vh - 13rem);

  min-height: 0;
  grid-template-columns: 37.5rem minmax(0, 1fr);
  align-items: stretch;
}

.publication-site-config-panel__preview {
  min-height: min(36rem, var(--publication-site-config-panel-content-height));
  max-height: var(--publication-site-config-panel-content-height);
  grid-template-rows: auto minmax(0, 1fr);
  align-content: stretch;
  gap: 0.5rem;
}

.publication-site-config-panel__access-toggle {
  border-color: color-mix(in srgb, var(--brand-border-base) 72%, transparent);
  background: color-mix(in srgb, var(--brand-fill-lighter) 32%, var(--brand-bg-surface));
}

.publication-site-config-panel__two-column {
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
}

.publication-site-config-panel__asset-row {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  gap: 1rem;
  align-items: center;
  min-height: 4.5rem;
  padding: 0.75rem;
  border: 1px solid color-mix(in srgb, var(--brand-border-base) 70%, transparent);
  border-radius: 0.5rem;
  background: color-mix(in srgb, var(--brand-fill-lighter) 28%, var(--brand-bg-surface));
}

.publication-site-config-panel__asset-row--home {
  grid-template-columns: minmax(0, 1fr);
  min-height: 7.25rem;
}

.publication-site-config-panel__asset-preview {
  position: relative;
  display: grid;
  place-items: center;
  overflow: hidden;
  width: 3rem;
  height: 3rem;
  border: 1px dashed color-mix(in srgb, var(--brand-border-base) 86%, transparent);
  border-radius: 0.5rem;
  background: color-mix(in srgb, var(--brand-fill-lighter) 58%, var(--brand-bg-surface));
  color: var(--brand-text-secondary);

  img {
    display: block;
    max-width: calc(100% - 0.5rem);
    max-height: calc(100% - 0.5rem);
    object-fit: contain;
  }
}

.publication-site-config-panel__asset-preview--home {
  width: 100%;
  height: 8rem;
}

.publication-site-config-panel__asset-empty {
  display: grid;
  place-items: center;
}

.publication-site-config-panel__asset-actions {
  grid-column: 2;
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-start;
  gap: 0.5rem;
}

.publication-site-config-panel__asset-row--home .publication-site-config-panel__asset-actions {
  grid-column: auto;
}

.publication-site-config-panel__asset-actions :deep(.el-upload) {
  display: block;
}

.publication-site-config-panel__upload-mask {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  background: color-mix(in srgb, var(--brand-bg-surface) 78%, transparent);
  color: var(--brand-text-primary);
  font-size: 0.8125rem;
  font-weight: 600;
}

.publication-site-config-panel__section + .publication-site-config-panel__section {
  border-top: 1px solid color-mix(in srgb, var(--brand-border-base) 66%, transparent);
}

.publication-site-config-panel__content-lists {
  display: grid;
  gap: 1rem;
}

.publication-site-config-panel__list-block {
  display: grid;
  align-content: start;
  gap: 0.75rem;
  min-width: 0;
  padding: 1rem;
  border: 1px solid color-mix(in srgb, var(--brand-border-base) 70%, transparent);
  border-radius: 0.5rem;
  background: color-mix(in srgb, var(--brand-fill-lighter) 24%, var(--brand-bg-surface));
}

.publication-site-config-panel__list-header {
  display: flex;
  min-height: 2rem;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
}

.publication-site-config-panel__draft-list {
  display: grid;
  gap: 0.625rem;
}

.publication-site-config-panel__draft-item {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 0.875rem;
  padding: 0.875rem;
  border: 1px solid color-mix(in srgb, var(--brand-border-base) 68%, transparent);
  border-radius: 0.5rem;
  background: var(--brand-bg-surface);
}

.publication-site-config-panel__draft-item--feature {
  grid-template-columns: minmax(7.5rem, 8.75rem) minmax(0, 1fr) auto;
  align-items: start;
}

.publication-site-config-panel__draft-main {
  display: grid;
  min-width: 0;
  gap: 0.5rem;
}

.publication-site-config-panel__action-theme {
  display: inline-grid;
  overflow: hidden;
  width: fit-content;
  grid-template-columns: repeat(2, minmax(0, auto));
  border: 1px solid color-mix(in srgb, var(--brand-border-base) 82%, transparent);
  border-radius: 0.5rem;
  background: var(--brand-bg-surface);
}

.publication-site-config-panel__action-theme-option {
  min-width: 4rem;
  height: 1.75rem;
  padding: 0 0.75rem;
  border: 0;
  border-right: 1px solid color-mix(in srgb, var(--brand-border-base) 82%, transparent);
  background: transparent;
  color: var(--brand-text-secondary);
  font-size: 0.8125rem;
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

  &.is-active {
    background: var(--brand-primary);
    color: white;
  }
}

.publication-site-config-panel__feature-icon-upload {
  display: grid;
  min-width: 0;
  gap: 0.5rem;
  text-align: center;
}

.publication-site-config-panel__feature-icon-trigger {
  display: block;
  width: 100%;
  max-width: 5.5rem;
  justify-self: center;

  &.is-disabled {
    cursor: not-allowed;
  }
}

.publication-site-config-panel__feature-icon-preview {
  position: relative;
  display: grid;
  place-items: center;
  overflow: hidden;
  width: 5.5rem;
  height: 5.5rem;
  border: 1px dashed color-mix(in srgb, var(--brand-border-base) 84%, transparent);
  border-radius: 0.75rem;
  background: color-mix(in srgb, var(--brand-fill-lighter) 52%, var(--brand-bg-surface));
  color: var(--brand-text-secondary);
  cursor: pointer;
  transition:
    border-color 0.2s ease,
    background-color 0.2s ease;

  &:hover {
    border-color: color-mix(in srgb, var(--brand-primary) 28%, var(--brand-border-base));
    background: color-mix(in srgb, var(--brand-primary) 6%, var(--brand-bg-surface));
  }

  &::after {
    position: absolute;
    inset: 0;
    background: color-mix(in srgb, var(--brand-bg-surface) 42%, transparent);
    opacity: 0;
    pointer-events: none;
    content: '';
    transition: opacity 0.18s ease;
  }

  &:hover::after,
  &:focus-within::after {
    opacity: 1;
  }

  img {
    display: block;
    max-width: calc(100% - 0.875rem);
    max-height: calc(100% - 0.875rem);
    object-fit: contain;
  }
}

.publication-site-config-panel__feature-icon-trigger.is-disabled .publication-site-config-panel__feature-icon-preview {
  cursor: not-allowed;
  opacity: 0.72;
}

.publication-site-config-panel__feature-icon-remove {
  position: absolute;
  top: 0.375rem;
  right: 0.375rem;
  z-index: 1;
  width: 1.75rem;
  min-width: 1.75rem;
  height: 1.75rem;
  padding: 0;
  border-radius: 50%;
  background: transparent;
  color: var(--brand-text-secondary);
  box-shadow: none;
  opacity: 0;
  transform: scale(0.92);
  pointer-events: none;
  transition:
    opacity 0.18s ease,
    transform 0.18s ease,
    color 0.18s ease;
  backdrop-filter: blur(1px);

  &:hover {
    color: var(--brand-text-primary);
  }
}

.publication-site-config-panel__feature-icon-preview:hover .publication-site-config-panel__feature-icon-remove,
.publication-site-config-panel__feature-icon-preview:focus-within .publication-site-config-panel__feature-icon-remove {
  opacity: 1;
  transform: scale(1);
  pointer-events: auto;
}

.publication-site-config-panel__feature-icon-hint {
  display: block;
  min-width: 0;
}

.publication-site-config-panel__draft-actions {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
}

.publication-site-config-panel__icon-button {
  width: 1.875rem;
  min-width: 1.875rem;
  height: 1.875rem;
  padding: 0;
  border-radius: 0.5rem;
}

.publication-site-config-panel__empty-text {
  min-height: 2rem;
  margin: 0;
  color: var(--brand-text-tertiary);
  font-size: 0.8125rem;
  line-height: 2rem;
}

.publication-site-config-panel__site-preview {
  height: 100%;
  min-height: 0;
  border: 1px solid color-mix(in srgb, var(--brand-border-base) 92%, var(--brand-text-tertiary) 8%);
  background: var(--brand-bg-surface);
  box-shadow:
    0 0 0 1px color-mix(in srgb, var(--brand-border-base) 70%, transparent),
    var(--brand-shadow-hairline);
}

@media (max-width: 1280px) {
  .publication-site-config-panel__body {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 720px) {
  .publication-site-config-panel__preview {
    min-height: 0;
  }

  .publication-site-config-panel__site-preview {
    height: 30rem;
    min-height: 30rem;
  }

  .publication-site-config-panel__asset-row,
  .publication-site-config-panel__asset-row--home {
    grid-template-columns: minmax(0, 1fr);
  }

  .publication-site-config-panel__asset-preview,
  .publication-site-config-panel__asset-preview--home {
    width: 100%;
    height: 7.5rem;
  }

  .publication-site-config-panel__asset-actions {
    justify-content: flex-start;
  }

  .publication-site-config-panel__draft-item {
    grid-template-columns: minmax(0, 1fr);
  }

  .publication-site-config-panel__draft-item--feature {
    grid-template-columns: minmax(0, 1fr);
  }

  .publication-site-config-panel__draft-actions {
    flex-direction: row;
  }
}
</style>
