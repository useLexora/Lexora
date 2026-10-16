<script setup lang="ts">
import type {
  PublicationRenderedDocument,
  PublicationSingleDocumentResponse,
  PublicationSiteRenderResponse,
  TiptapJsonContent,
} from '@haohaoxue/lexora-contracts'
import {
  collectDocumentAssetIds,
  hydrateDocumentAssetAttributes,
} from '@haohaoxue/lexora-shared/document'
import { computed, shallowRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRoute } from 'vue-router'
import {
  getPublicationSiteRender,
  getSinglePublicDocument,
  resolveDocumentPublicationAssets,
  resolveSinglePublicationAssets,
} from '@/apis/document-publication'
import { usePublicationDocumentMeta } from '../../composables/usePublicationDocumentMeta'
import PublicationTopNav from '../../layouts/top-nav'
import {
  resolvePublicationNavItems,
  rewritePublicationInternalLinks,
} from '../../utils/publicationRendering'
import PublicationHomePage from '../home-page'
import PublicationSingleDocumentPage from '../single-document-page'
import PublicationSiteDocumentPage from '../site-document-page'

const route = useRoute()
const { t } = useI18n()
const isLoading = shallowRef(true)
const errorMessage = shallowRef('')
const singleDocument = shallowRef<PublicationRenderedDocument | null>(null)
const siteRender = shallowRef<PublicationSiteRenderResponse | null>(null)
const hydratedBody = shallowRef<TiptapJsonContent>([])
let loadToken = 0

const publicationMode = computed(() => route.name === 'publication-single' ? 'single' : 'site')
const singleDocumentId = computed(() => typeof route.params.documentId === 'string' ? route.params.documentId : '')
const siteId = computed(() => typeof route.params.siteId === 'string' ? route.params.siteId : '')
const siteDocumentId = computed(() =>
  publicationMode.value === 'site' && typeof route.params.documentId === 'string'
    ? route.params.documentId
    : null,
)
const resolvedNavItems = computed(() => siteRender.value
  ? resolvePublicationNavItems({
      groups: siteRender.value.sidebarGroups,
      items: siteRender.value.navItems,
      siteId: siteRender.value.site.id,
    })
  : [],
)
const activeDocument = computed(() => publicationMode.value === 'single'
  ? singleDocument.value
  : siteRender.value?.currentPage ?? null,
)
const pageTitle = computed(() => {
  if (publicationMode.value === 'single') {
    return singleDocument.value?.title || t('docs.publicReader.defaultTitle')
  }

  const site = siteRender.value?.site

  if (!site) {
    return t('docs.publicReader.defaultTitle')
  }

  return siteRender.value?.currentPage
    ? `${siteRender.value.currentPage.title} - ${site.title}`
    : site.title
})
const allowIndexing = computed(() =>
  publicationMode.value === 'site' && Boolean(siteRender.value?.site.allowIndexing),
)
const hasReusableSiteShell = computed(() => publicationMode.value === 'site' && Boolean(siteRender.value))
const showGlobalLoading = computed(() => isLoading.value && !hasReusableSiteShell.value)
const isSiteHomeRoute = computed(() => publicationMode.value === 'site' && !siteDocumentId.value)
const isSiteDocumentLoading = computed(() =>
  publicationMode.value === 'site'
  && isLoading.value
  && Boolean(siteRender.value)
  && Boolean(siteDocumentId.value),
)
const siteActiveDocumentId = computed(() => siteDocumentId.value ?? siteRender.value?.currentPage?.documentId ?? null)
const displayedSiteDocument = computed(() => {
  if (!siteRender.value?.currentPage) {
    return null
  }

  if (isSiteDocumentLoading.value && siteRender.value.currentPage.documentId !== siteDocumentId.value) {
    return null
  }

  return siteRender.value.currentPage
})
const displayedSiteBody = computed(() => displayedSiteDocument.value ? hydratedBody.value : [])
const displayedSiteOutline = computed(() => displayedSiteDocument.value ? siteRender.value?.outline ?? [] : [])

watch(
  () => [route.name, route.params.siteId, route.params.documentId],
  () => {
    void loadPublication()
  },
  { immediate: true },
)

usePublicationDocumentMeta({
  allowIndexing,
  title: pageTitle,
})

async function loadPublication() {
  const currentToken = ++loadToken
  isLoading.value = true
  errorMessage.value = ''

  try {
    if (publicationMode.value === 'single') {
      await loadSinglePublication(currentToken)
      return
    }

    await loadSitePublication(currentToken)
  }
  catch (error) {
    if (currentToken !== loadToken) {
      return
    }

    singleDocument.value = null
    siteRender.value = null
    hydratedBody.value = []
    errorMessage.value = error instanceof Error ? error.message : t('docs.publicReader.loadDocumentFailed')
  }
  finally {
    if (currentToken === loadToken) {
      isLoading.value = false
    }
  }
}

async function loadSinglePublication(currentToken: number) {
  if (!singleDocumentId.value) {
    throw new Error(t('docs.publicReader.loadDocumentFailed'))
  }

  const response = await getSinglePublicDocument(singleDocumentId.value)
  const body = await hydrateSinglePublicationBody(response)

  if (currentToken !== loadToken) {
    return
  }

  singleDocument.value = response.document
  siteRender.value = null
  hydratedBody.value = body
}

async function loadSitePublication(currentToken: number) {
  if (!siteId.value) {
    throw new Error(t('docs.publicReader.loadSiteFailed'))
  }

  const response = await getPublicationSiteRender(siteId.value, siteDocumentId.value)
  const body = response.currentPage
    ? await hydrateSitePublicationBody(response)
    : []

  if (currentToken !== loadToken) {
    return
  }

  siteRender.value = response
  singleDocument.value = null
  hydratedBody.value = body
}

async function hydrateSinglePublicationBody(
  response: PublicationSingleDocumentResponse,
): Promise<TiptapJsonContent> {
  const bodyWithLinks = rewritePublicationInternalLinks(response.document.body, response.internalLinks)
  const assetIds = Array.from(new Set([...response.assetIds, ...collectDocumentAssetIds(bodyWithLinks)]))

  if (!assetIds.length) {
    return bodyWithLinks
  }

  const resolvedAssets = await resolveSinglePublicationAssets(response.document.documentId, { assetIds })
  return hydrateDocumentAssetAttributes(
    bodyWithLinks,
    Object.fromEntries(resolvedAssets.assets.map(asset => [asset.id, asset])),
  )
}

async function hydrateSitePublicationBody(
  response: PublicationSiteRenderResponse,
): Promise<TiptapJsonContent> {
  if (!response.currentPage) {
    return []
  }

  const bodyWithLinks = rewritePublicationInternalLinks(response.currentPage.body, response.internalLinks)
  const assetIds = collectDocumentAssetIds(bodyWithLinks)

  if (!assetIds.length) {
    return bodyWithLinks
  }

  const resolvedAssets = await resolveDocumentPublicationAssets(
    response.site.id,
    response.currentPage.documentId,
    { assetIds },
  )

  return hydrateDocumentAssetAttributes(
    bodyWithLinks,
    Object.fromEntries(resolvedAssets.assets.map(asset => [asset.id, asset])),
  )
}
</script>

<template>
  <section class="publication-view" :class="`publication-view--${publicationMode}`">
    <div v-if="showGlobalLoading" class="publication-view__loading mx-auto mt-16 w-[min(52rem,calc(100%-2rem))]">
      <ElSkeleton :rows="8" animated />
    </div>

    <ElResult
      v-else-if="errorMessage"
      icon="warning"
      :title="t('docs.publicReader.unavailableTitle')"
      :sub-title="errorMessage"
      class="publication-view__result mx-auto mt-16 w-[min(52rem,calc(100%-2rem))]"
    />

    <template v-else-if="publicationMode === 'single' && activeDocument">
      <PublicationSingleDocumentPage
        :document="activeDocument"
        :body="hydratedBody"
      />
    </template>

    <template v-else-if="siteRender">
      <PublicationTopNav
        :site="siteRender.site"
        :nav-items="resolvedNavItems"
        :home="isSiteHomeRoute"
      />

      <PublicationSiteDocumentPage
        v-if="siteDocumentId"
        :document="displayedSiteDocument"
        :body="displayedSiteBody"
        :outline="displayedSiteOutline"
        :sidebar-groups="siteRender.sidebarGroups"
        :site-id="siteRender.site.id"
        :active-document-id="siteActiveDocumentId"
        :is-loading="isSiteDocumentLoading"
      />

      <PublicationHomePage
        v-else
        :site="siteRender.site"
        :home="siteRender.home"
      />
    </template>
  </section>
</template>

<style scoped lang="scss">
.publication-view {
  --publication-c-bg: var(--brand-bg-surface);
  --publication-c-bg-alt: var(--brand-fill-blank);
  --publication-c-bg-soft: color-mix(in srgb, var(--brand-fill-lighter) 62%, var(--brand-bg-surface));
  --publication-c-text-1: var(--brand-text-primary);
  --publication-c-text-2: var(--brand-text-secondary);
  --publication-c-text-3: var(--brand-text-tertiary);
  --publication-c-divider: color-mix(in srgb, var(--brand-border-base) 82%, transparent);
  --publication-c-gutter: color-mix(in srgb, var(--brand-border-base) 68%, transparent);
  --publication-c-brand-1: var(--brand-primary);
  --publication-c-brand-2: color-mix(in srgb, var(--brand-primary) 82%, var(--brand-text-primary));
  --publication-c-brand-soft: color-mix(in srgb, var(--brand-primary) 10%, transparent);
  --publication-layout-max-width: 90rem;
  --publication-nav-height: 4rem;
  --publication-sidebar-width: 17rem;
  --publication-aside-width: 16rem;
  min-height: 100vh;
  background: var(--publication-c-bg);
  color: var(--publication-c-text-1);
}

.publication-view--site {
  background: var(--publication-c-bg);
}

@media (min-width: 960px) {
  .publication-view--site {
    padding-top: var(--publication-nav-height);
  }
}
</style>
