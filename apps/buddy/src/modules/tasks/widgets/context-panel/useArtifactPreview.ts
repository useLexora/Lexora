import type { LocalArtifact, LocalArtifactText } from '@buddy-shared/artifacts/artifactApi'
import { parseLocalChatPublicError } from '@buddy-shared/runtime/localChatError'
import { computed, readonly, shallowRef, watch } from 'vue'
import { isMarkdownArtifact, isTextMimeType } from './artifactContextPresentation'

interface ArtifactPreviewOptions {
  artifact: () => LocalArtifact
  textEnabled?: () => boolean
  imageEnabled?: () => boolean
  readText: () => (artifactId: string) => Promise<LocalArtifactText>
}

export function useArtifactPreview(options: ArtifactPreviewOptions) {
  const revision = shallowRef(0)
  const previewFailed = shallowRef(false)
  const previewIndex = shallowRef(0)
  const previewOpen = shallowRef(false)
  const textPreview = shallowRef<LocalArtifactText | null>(null)
  const textPreviewFailed = shallowRef(false)
  const textPreviewMissing = shallowRef(false)
  const textPreviewLoading = shallowRef(false)
  const imageUrl = computed(() => {
    const artifact = options.artifact()
    return artifact.kind === 'file' && (options.imageEnabled?.() ?? artifact.mimeType.startsWith('image/'))
      ? `lexora-artifact://preview/${encodeURIComponent(artifact.artifactId)}?v=${encodeURIComponent(artifact.updatedAt)}`
      : null
  })
  const previewUrl = computed(() => previewFailed.value ? null : imageUrl.value)
  const previewSources = computed(() => previewUrl.value ? [previewUrl.value] : [])

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
    previewFailed.value = false
    previewIndex.value = 0
    previewOpen.value = false
    textPreview.value = null
    textPreviewFailed.value = false
    textPreviewMissing.value = false
    textPreviewLoading.value = kind === 'file' && (options.textEnabled?.() ?? (isTextMimeType(mimeType) || isMarkdownArtifact(options.artifact())))
    if (!textPreviewLoading.value)
      return
    try {
      const result = await readText(artifactId)
      if (active)
        textPreview.value = result
    }
    catch (error) {
      if (active) {
        textPreviewFailed.value = true
        textPreviewMissing.value = error instanceof Error && parseLocalChatPublicError(error.message)?.code === 'FILE_NOT_FOUND'
      }
    }
    finally {
      if (active)
        textPreviewLoading.value = false
    }
  }, { immediate: true, flush: 'sync' })

  function failImage(event: Event) {
    if ((event.target as HTMLImageElement | null)?.getAttribute('src') === imageUrl.value)
      previewFailed.value = true
  }

  function openPreview() {
    if (previewUrl.value)
      previewOpen.value = true
  }

  return {
    refreshText: () => revision.value++,
    previewFailed: readonly(previewFailed),
    failImage,
    openPreview,
    previewIndex,
    previewOpen,
    previewSources,
    previewUrl,
    textPreview: readonly(textPreview),
    textPreviewFailed: readonly(textPreviewFailed),
    textPreviewMissing: readonly(textPreviewMissing),
    textPreviewLoading: readonly(textPreviewLoading),
  }
}
