import type { LocalArtifact, LocalArtifactText } from '@buddy-shared/artifacts/artifactApi'
import type { FilePreviewErrorKey } from '@/shared/lib/filePreviewError'
import { computed, onScopeDispose, readonly, shallowRef, watch } from 'vue'
import { diagnoseFilePreviewError, resolveFileErrorKey } from '@/shared/lib/filePreviewError'
import { isMarkdownArtifact, isTextMimeType } from './artifactContextPresentation'

interface ArtifactPreviewOptions {
  artifact: () => LocalArtifact
  textEnabled?: () => boolean
  imageEnabled?: () => boolean
  readText: () => (artifactId: string) => Promise<LocalArtifactText>
}

export function useArtifactPreview(options: ArtifactPreviewOptions) {
  const revision = shallowRef(0)
  const previewError = shallowRef<FilePreviewErrorKey | null>(null)
  const previewFailed = computed(() => previewError.value !== null)
  let imageDiagnosis: AbortController | null = null
  let disposed = false
  const previewIndex = shallowRef(0)
  const previewOpen = shallowRef(false)
  const textPreview = shallowRef<LocalArtifactText | null>(null)
  const textPreviewError = shallowRef<FilePreviewErrorKey | null>(null)
  const textPreviewFailed = computed(() => textPreviewError.value !== null)
  const textPreviewMissing = computed(() => textPreviewError.value === 'desktop.context.previewFileMissing')
  const textPreviewLoading = shallowRef(false)
  const imageUrl = computed(() => {
    const artifact = options.artifact()
    return artifact.kind === 'file' && (options.imageEnabled?.() ?? artifact.mimeType.startsWith('image/'))
      ? `lexora-artifact://preview/${encodeURIComponent(artifact.artifactId)}?v=${encodeURIComponent(`${artifact.updatedAt}:${revision.value}`)}`
      : null
  })
  const previewUrl = computed(() => previewFailed.value ? null : imageUrl.value)
  const previewSources = computed(() => previewUrl.value ? [previewUrl.value] : [])

  watch(imageUrl, () => {
    imageDiagnosis?.abort()
    imageDiagnosis = null
    previewError.value = null
    previewIndex.value = 0
    previewOpen.value = false
  }, { flush: 'sync' })
  onScopeDispose(() => {
    disposed = true
    imageDiagnosis?.abort()
  })

  watch([
    () => options.artifact().artifactId,
    () => options.artifact().updatedAt,
    () => options.artifact().kind,
    () => options.artifact().mimeType,
    options.readText,
    revision,
    () => options.textEnabled?.(),
  ], async ([artifactId, , kind, mimeType, readText], _previous, onCleanup) => {
    let active = true
    onCleanup(() => {
      active = false
    })
    textPreview.value = null
    textPreviewError.value = null
    textPreviewLoading.value = kind === 'file' && (options.textEnabled?.() ?? (isTextMimeType(mimeType) || isMarkdownArtifact(options.artifact())))
    if (!textPreviewLoading.value)
      return
    try {
      const result = await readText(artifactId)
      if (active)
        textPreview.value = result
    }
    catch (error) {
      if (active)
        textPreviewError.value = resolveFileErrorKey(error) ?? 'desktop.context.previewLoadFailed'
    }
    finally {
      if (active)
        textPreviewLoading.value = false
    }
  }, { immediate: true, flush: 'sync' })

  async function failImage(event: Event) {
    const src = imageUrl.value
    if (disposed || !src || (event.target as HTMLImageElement | null)?.getAttribute('src') !== src)
      return
    imageDiagnosis?.abort()
    const request = new AbortController()
    imageDiagnosis = request
    previewError.value = 'desktop.context.previewLoadFailed'
    const error = await diagnoseFilePreviewError(src, request.signal, 'desktop.context.previewLoadFailed')
    if (!request.signal.aborted && !disposed && imageUrl.value === src)
      previewError.value = error
  }

  function openPreview() {
    if (previewUrl.value)
      previewOpen.value = true
  }

  return {
    refreshText: () => revision.value++,
    previewFailed,
    previewError: readonly(previewError),
    failImage,
    openPreview,
    previewIndex,
    previewOpen,
    previewSources,
    previewUrl,
    textPreview: readonly(textPreview),
    textPreviewError: readonly(textPreviewError),
    textPreviewFailed: readonly(textPreviewFailed),
    textPreviewMissing: readonly(textPreviewMissing),
    textPreviewLoading: readonly(textPreviewLoading),
  }
}
