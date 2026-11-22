<script setup lang="ts">
import type { LocalChatApi } from '@buddy-electron/shared/localChatApi'
import type { BuddyFileQuote } from '@buddy-shared/conversation/buddyUserContent'
import type { LocalSpaceFilePreview } from '@buddy-shared/spaces/spaceFileApi'
import type { DropdownOption } from 'naive-ui'
import type { AnnotatedImageQuote, AnnotationHistoryCommand, AnnotationQuoteCheckpoint, ImageAnnotationRect } from '@/shared/ui/files/imageAnnotation'
import type { WorkbenchView } from '@/workbench/common/workbench'
import { BUDDY_ATTACHMENT_TOTAL_BYTES_LIMIT } from '@buddy-shared/conversation/attachmentPolicy'
import { resolveBuiltinFileOpening } from '@buddy-shared/files/fileOpening'
import { taskFileTargetSchema } from '@buddy-shared/files/taskFileApi'
import { parseLocalChatPublicError } from '@buddy-shared/runtime/localChatError'
import { spaceFileTargetSchema } from '@buddy-shared/spaces/spaceFileApi'
import { ArrowRedo20Regular, ArrowUndo20Regular, ImageEdit20Regular, TextQuote20Regular } from '@vicons/fluent'
import { NButton, NDropdown, NTooltip, useMessage } from 'naive-ui'
import { computed, h, onScopeDispose, shallowRef, useTemplateRef, watch } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import WorkbenchMenu from '@/shared/ui/contributions/WorkbenchMenu.vue'
import DesktopDocumentContent from '@/shared/ui/files/DesktopDocumentContent.vue'
import DesktopDocumentToolbar from '@/shared/ui/files/DesktopDocumentToolbar.vue'
import { fileDocumentModes, resolveFileDocumentMode } from '@/shared/ui/files/fileDocumentPresentation'
import { annotatedSnapshotName, annotationExportFits, annotationHistoryCommit, annotationHistoryRedo, annotationHistoryUndo, annotationPreviewUrlAllowed, annotationQuoteAction, annotationThemeColors, bytesToBase64, createSingleFlight, emptyAnnotationHistory, imageElementCanvasReadable, isStaticAnnotatableImageName, quoteAnnotatedImage, readAnimatedPreview, renderAnnotatedPng } from '@/shared/ui/files/imageAnnotation'
import ImageAnnotationSurface from '@/shared/ui/files/ImageAnnotationSurface.vue'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'
import DesktopFileLoading from '@/shared/ui/loading/DesktopFileLoading.vue'
import ResourceSelectionQuoteMenu from '@/shared/ui/selection/ResourceSelectionQuoteMenu.vue'
import { useResourceQuoteReveal } from '@/shared/ui/selection/useResourceQuoteReveal'
import { useResourceSelectionQuote } from '@/shared/ui/selection/useResourceSelectionQuote'
import { useSelectionReferences } from '@/shared/ui/selection/workbenchSelectionReferences'
import { useWorkbench } from '@/workbench/browser/workbenchContext'

import { spaceFileImageResolver, taskFileImageResolver } from '../model/documentImageResolver'
import { fileOpeningHandler } from '../model/fileOpeningHandlers'
import { useFileOpening } from '../state/fileOpeningContext'
import { filePreviewRenderer } from './filePreviewRenderers'

const props = withDefaults(defineProps<{ view: WorkbenchView, files: LocalChatApi['spaces'], taskFiles?: LocalChatApi['taskFiles'], language: 'zh-CN' | 'en-US', writeClipboardText: (text: string) => Promise<void>, toolbarTarget?: HTMLElement | null, visible?: boolean, quoteSnapshot?: (input: AnnotatedImageQuote) => Promise<boolean> }>(), { visible: true })
const { labels, controller } = useWorkbench()
const { t } = useBuddyI18n(() => props.language)
const message = useMessage()
const preview = shallowRef<LocalSpaceFilePreview | null>(null)
const failed = shallowRef(false)
const missing = shallowRef(false)
const opening = useFileOpening()
const taskTarget = computed(() => props.view.resource.scheme === 'task-file' ? taskFileTargetSchema.parse({ conversationId: props.view.resource.data.conversationId, path: props.view.resource.data.path }) : null)
const target = computed(() => taskTarget.value ? null : spaceFileTargetSchema.strip().parse(props.view.resource.data))
const directory = computed(() => taskTarget.value !== null && props.view.resource.data.kind === 'directory')
const imageResolver = computed(() => taskTarget.value
  ? props.taskFiles && taskFileImageResolver(taskTarget.value, props.taskFiles.resolve)
  : target.value ? spaceFileImageResolver(target.value) : undefined)
const provider = computed(() => {
  const location = taskTarget.value ? 'standalone' : 'inline'
  const resolved = opening?.resolve(props.view.title, location) ?? resolveBuiltinFileOpening(props.view.title, location)
  return (taskTarget.value && typeof props.view.state.fileOpeningProvider === 'string' ? resolved.candidates.find(provider => provider.id === props.view.state.fileOpeningProvider) : null) ?? resolved.provider
})
const previewRenderer = computed(() => filePreviewRenderer({ provider: provider.value, ownerId: props.view.id, target: target.value, source: 'file', resourceReady: true, text: preview.value?.text ?? undefined, name: props.view.title, visible: props.visible, language: props.language }))
const modes = computed(() => fileDocumentModes({ preview: !!fileOpeningHandler(provider.value)?.preview, source: preview.value?.kind === 'text', edit: false }))
const mode = computed({ get: () => resolveFileDocumentMode(props.view.state.mode, modes.value), set: value => controller.updateView(props.view.id, { state: { ...props.view.state, mode: value } }) })
const quoteSource = computed<BuddyFileQuote['source'] | undefined>(() => target.value
  ? ({
      kind: 'file',
      title: props.view.title,
      file: target.value,
      format: mode.value === 'preview' ? 'markdown' : 'source',
    })
  : undefined)
const identity = computed(() => {
  const { scheme, id, data } = props.view.resource
  return JSON.stringify([scheme, id, data.conversationId, data.spaceId, data.directoryId, data.revision, data.path])
})
const references = useSelectionReferences()
const selection = useResourceSelectionQuote({
  viewId: () => props.view.id,
  ownerKey: () => JSON.stringify([props.view.id, identity.value, mode.value]),
  visible: () => props.visible && target.value !== null,
  language: () => props.language,
})
const attempt = shallowRef(0)
watch([identity, attempt], async (_, __, onCleanup) => {
  let active = true
  onCleanup(() => active = false)
  preview.value = null
  failed.value = false
  missing.value = false
  if (directory.value)
    return
  try {
    const value = taskTarget.value && props.taskFiles
      ? await props.taskFiles.read(taskTarget.value)
      : await props.files.readFile(spaceFileTargetSchema.strip().parse(props.view.resource.data))
    if (active)
      preview.value = value
  }
  catch (error) {
    if (active) {
      failed.value = true
      missing.value = error instanceof Error && parseLocalChatPublicError(error.message)?.code === 'FILE_NOT_FOUND'
    }
  }
}, { immediate: true })
const document = useTemplateRef<InstanceType<typeof DesktopDocumentContent>>('document')
useResourceQuoteReveal({
  viewId: () => props.view.id,
  identity: () => identity.value,
  visible: () => props.visible,
  prepare: () => attempt.value++,
  ready: () => !!preview.value && !!document.value?.ready,
  reveal: quote => document.value?.reveal(quote) ?? false,
})
function loadPreview() {
  attempt.value++
}
function captureResource() {
  return { resource: spaceFileTargetSchema.strip().parse(props.view.resource.data) }
}
const canvasPreview = computed(() => mode.value === 'preview' && !!preview.value?.imageUrl && annotationPreviewUrlAllowed(preview.value.imageUrl) && isStaticAnnotatableImageName(props.view.title) && !previewRenderer.value)
const annotatable = computed(() => props.visible && canvasPreview.value)
const annotationPhase = shallowRef<'off' | 'checking' | 'on'>('off')
const annotationHistory = shallowRef(emptyAnnotationHistory())
const annotationRects = computed(() => annotationHistory.value.marks)
const annotationBusy = shallowRef(false)
const annotationIconTheme = { heightMedium: '28px' }
const annotationSelectedTheme = { ...annotationIconTheme, colorQuaternary: 'var(--buddy-accent-surface)', colorQuaternaryHover: 'var(--buddy-accent-surface-hover)', colorQuaternaryPressed: 'var(--buddy-accent-surface-pressed)' }
const annotationToggleLabel = computed(() => t(annotationPhase.value === 'off' ? 'desktop.chat.imageAnnotation' : 'desktop.chat.imageAnnotationExit'))
const canUndoAnnotation = computed(() => annotationPhase.value === 'on' && !annotationBusy.value && annotationHistory.value.marks.length > 0)
const canRedoAnnotation = computed(() => annotationPhase.value === 'on' && !annotationBusy.value && annotationHistory.value.undone.length > 0)
const quoteReady = computed(() => annotationPhase.value === 'on' && !annotationBusy.value && annotationRects.value.length > 0)
const annotationQuoteScope = computed(() => references?.captureScope(props.view.id) ?? null)
const quoteAction = computed(() => annotationQuoteAction(annotationQuoteScope.value))
const pendingQuoteScope = shallowRef<AnnotatedImageQuote['scope'] | null>(null)
const annotationQuoteOptions = computed<DropdownOption[]>(() => pendingQuoteScope.value?.targets.map(target => ({ key: target.id, label: target.label })) ?? [])
const quoteOnce = createSingleFlight()
let annotationGeneration = 0
let suppressQuoteResult = false
let annotationLifetime = new AbortController()
onScopeDispose(() => annotationLifetime.abort())
function closeAnnotationQuoteMenu() {
  pendingQuoteScope.value = null
}
function resetAnnotation() {
  annotationGeneration += 1
  annotationLifetime.abort()
  annotationLifetime = new AbortController()
  annotationPhase.value = 'off'
  closeAnnotationQuoteMenu()
  annotationHistory.value = emptyAnnotationHistory()
  annotationBusy.value = false
}
function exitAnnotation() {
  suppressQuoteResult = true
  resetAnnotation()
}
watch([identity, () => preview.value?.imageUrl], () => {
  if (annotationPhase.value !== 'off')
    resetAnnotation()
})
function previewImage(): HTMLImageElement | null {
  return document.value?.getImageElement() ?? null
}
function failAnnotation(generation: number, key: 'desktop.chat.imageAnnotationUnavailable' | 'desktop.chat.imageAnnotationAnimated') {
  if (generation !== annotationGeneration)
    return
  message.warning(t(key))
  resetAnnotation()
}
async function beginAnnotation() {
  if (!annotatable.value || annotationPhase.value !== 'off')
    return
  const generation = annotationGeneration
  const signal = annotationLifetime.signal
  const image = previewImage()
  suppressQuoteResult = false
  annotationPhase.value = 'checking'
  try {
    if (image && !image.complete)
      await image.decode()
    if (signal.aborted)
      return
    if (!image || !imageElementCanvasReadable(image) || !annotationExportFits(image.naturalWidth, image.naturalHeight)) {
      failAnnotation(generation, 'desktop.chat.imageAnnotationUnavailable')
      return
    }
    const lowerName = props.view.title.toLowerCase()
    if ((lowerName.endsWith('.webp') || lowerName.endsWith('.png')) && await readAnimatedPreview(image.currentSrc || image.src, signal)) {
      failAnnotation(generation, 'desktop.chat.imageAnnotationAnimated')
      return
    }
    if (!signal.aborted)
      annotationPhase.value = 'on'
  }
  catch {
    if (!signal.aborted)
      failAnnotation(generation, 'desktop.chat.imageAnnotationUnavailable')
  }
}
function commitAnnotation(rect: ImageAnnotationRect) {
  if (annotationBusy.value || annotationPhase.value !== 'on')
    return
  annotationHistory.value = annotationHistoryCommit(annotationHistory.value, rect)
}
function applyAnnotationHistory(command: AnnotationHistoryCommand) {
  if (annotationPhase.value !== 'on' || annotationBusy.value)
    return
  const next = command === 'undo' ? annotationHistoryUndo(annotationHistory.value) : annotationHistoryRedo(annotationHistory.value)
  if (next !== annotationHistory.value)
    annotationHistory.value = next
}
function toggleAnnotation() {
  if (annotationPhase.value === 'off')
    void beginAnnotation()
  else
    exitAnnotation()
}
const quoteLabel = computed(() => {
  const action = quoteAction.value
  if (action.kind === 'direct' && action.named) {
    const target = annotationQuoteScope.value?.targets.find(item => item.id === action.targetId)
    return t('desktop.chat.quoteToTarget', { title: target?.pane?.title ?? target?.label ?? '' })
  }
  return t(action.kind === 'choose' ? 'desktop.chat.quoteChooseTarget' : 'desktop.chat.quoteToCurrent')
})
watch([annotationQuoteScope, quoteReady], ([scope, ready]) => {
  const pending = pendingQuoteScope.value
  if (pending && (!ready || !scope || scope.sourceIdentity !== pending.sourceIdentity || scope.targets.length !== pending.targets.length || pending.targets.some(target => !scope.targets.some(current => current.id === target.id && current.identity === target.identity))))
    closeAnnotationQuoteMenu()
})
function annotationQuoteMenuProps() {
  return { 'class': 'buddy-selection-menu resource-selection-menu', 'role': 'menu', 'aria-label': t('desktop.chat.quoteChooseTarget'), 'data-testid': 'image-annotation-target-menu' }
}
function renderAnnotationQuoteLabel(option: DropdownOption) {
  const label = String(option.label ?? '')
  return h('span', { class: 'block min-w-0 w-full truncate', title: label }, label)
}
function liveQuoteCheckpoint(generation: number, targetId: string, scopeIdentity: string, targetIdentity: string, imageUrl: string): AnnotationQuoteCheckpoint | null {
  if (generation !== annotationGeneration || annotationPhase.value === 'off')
    return null
  const scope = references?.captureScope(props.view.id)
  const target = scope?.targets.find(item => item.id === targetId)
  if (!scope || !target || scope.sourceIdentity !== scopeIdentity || target.identity !== targetIdentity || preview.value?.imageUrl !== imageUrl)
    return null
  return { sourceIdentity: scopeIdentity, imageUrl, targetId, targetIdentity }
}
function toggleAnnotationQuoteMenu() {
  if (!quoteReady.value)
    return
  if (pendingQuoteScope.value) {
    closeAnnotationQuoteMenu()
    return
  }
  const scope = annotationQuoteScope.value
  const action = quoteAction.value
  if (!scope || !props.quoteSnapshot || action.kind === 'unavailable') {
    message.warning(t('desktop.chat.quoteNoTarget'))
    return
  }
  if (action.kind === 'choose')
    pendingQuoteScope.value = scope
  else
    quoteAnnotation(scope, action.targetId)
}
function selectAnnotationQuoteTarget(targetId: string | number) {
  const scope = pendingQuoteScope.value
  closeAnnotationQuoteMenu()
  if (scope && typeof targetId === 'string')
    quoteAnnotation(scope, targetId)
}
function quoteAnnotation(scope: AnnotatedImageQuote['scope'], targetId: string) {
  void quoteOnce(async () => {
    const receive = props.quoteSnapshot
    if (!quoteReady.value || !receive)
      return
    const generation = annotationGeneration
    const imageUrl = preview.value?.imageUrl
    const target = scope.targets.find(item => item.id === targetId)
    const image = previewImage()
    if (!target || !imageUrl || !image || !liveQuoteCheckpoint(generation, targetId, scope.sourceIdentity, target.identity, imageUrl))
      return message.warning(t('desktop.chat.quoteTargetChanged'))
    const checkpoint: AnnotationQuoteCheckpoint = { sourceIdentity: scope.sourceIdentity, imageUrl, targetId, targetIdentity: target.identity }
    suppressQuoteResult = false
    annotationBusy.value = true
    try {
      const blob = await renderAnnotatedPng(image, image.naturalWidth, image.naturalHeight, annotationRects.value.slice(), annotationThemeColors())
      if (blob.size > BUDDY_ATTACHMENT_TOTAL_BYTES_LIMIT) {
        if (generation === annotationGeneration)
          message.warning(t('desktop.chat.attachmentLimit'))
        return
      }
      const result = await quoteAnnotatedImage({
        checkpoint,
        readRoute: () => liveQuoteCheckpoint(generation, targetId, scope.sourceIdentity, target.identity, imageUrl),
        receive: async current => receive({ scope, targetId, name: annotatedSnapshotName(props.view.title), base64: bytesToBase64(new Uint8Array(await blob.arrayBuffer())), current }),
      })
      if (suppressQuoteResult || generation !== annotationGeneration)
        return
      const title = target.pane?.title ?? target.label
      if (result === 'added')
        message.success(t('desktop.chat.quoteAddedToTarget', { title }))
      else if (result === 'stale')
        message.warning(t('desktop.chat.quoteTargetChanged'))
      else
        message.warning(t('desktop.chat.attachmentImportFailed'))
    }
    catch {
      if (generation === annotationGeneration && !suppressQuoteResult)
        message.warning(t('desktop.chat.imageAnnotationExportFailed'))
    }
    finally {
      if (generation === annotationGeneration)
        annotationBusy.value = false
    }
  })
}
</script>

<template>
  <div class="file-preview flex flex-1 flex-col min-h-0 overflow-auto">
    <Teleport v-if="visible" :to="toolbarTarget ?? 'body'" :disabled="!toolbarTarget">
      <DesktopDocumentToolbar v-model="mode" :name="String(view.resource.data.path)" :modes="modes" :language="language" :embedded="!!toolbarTarget" :prioritize-actions="annotatable || annotationPhase !== 'off'">
        <template #actions>
          <div v-if="annotatable || annotationPhase !== 'off'" class="image-annotation-tools inline-flex flex-none items-center gap-[2px]" role="group" :aria-label="t('desktop.chat.imageAnnotation')">
            <template v-if="annotationPhase !== 'off'">
              <NTooltip trigger="hover" :delay="350">
                <template #trigger>
                  <span class="inline-flex flex-none">
                    <NButton class="image-annotation-action buddy-icon-button w-[28px] h-[28px] flex-none" quaternary data-testid="image-annotation-undo" :disabled="!canUndoAnnotation" :aria-label="t('desktop.chat.imageAnnotationUndo')" :theme-overrides="annotationIconTheme" @click="applyAnnotationHistory('undo')">
                      <template #icon>
                        <DesktopIcon :component="ArrowUndo20Regular" />
                      </template>
                    </NButton>
                  </span>
                </template>
                {{ t('desktop.chat.imageAnnotationUndo') }}
              </NTooltip>
              <NTooltip trigger="hover" :delay="350">
                <template #trigger>
                  <span class="inline-flex flex-none">
                    <NButton class="image-annotation-action buddy-icon-button w-[28px] h-[28px] flex-none" quaternary data-testid="image-annotation-redo" :disabled="!canRedoAnnotation" :aria-label="t('desktop.chat.imageAnnotationRedo')" :theme-overrides="annotationIconTheme" @click="applyAnnotationHistory('redo')">
                      <template #icon>
                        <DesktopIcon :component="ArrowRedo20Regular" />
                      </template>
                    </NButton>
                  </span>
                </template>
                {{ t('desktop.chat.imageAnnotationRedo') }}
              </NTooltip>
              <span class="w-px h-[14px] flex-none mx-[4px] bg-border" aria-hidden="true" />
              <NTooltip trigger="hover" :delay="350" :disabled="pendingQuoteScope !== null">
                <template #trigger>
                  <span class="inline-flex flex-none">
                    <NDropdown trigger="manual" placement="bottom-end" size="small" :show="pendingQuoteScope !== null" :options="annotationQuoteOptions" :menu-props="annotationQuoteMenuProps" :node-props="option => ({ 'role': 'menuitem', 'aria-label': String(option.label ?? '') })" :render-label="renderAnnotationQuoteLabel" @clickoutside="closeAnnotationQuoteMenu" @update:show="closeAnnotationQuoteMenu" @select="selectAnnotationQuoteTarget">
                      <NButton class="image-annotation-action buddy-icon-button w-[28px] h-[28px] flex-none" quaternary data-testid="image-annotation-quote" :disabled="!quoteReady" :loading="annotationBusy" :aria-label="quoteLabel" :aria-haspopup="quoteAction.kind === 'choose' ? 'menu' : undefined" :aria-expanded="quoteAction.kind === 'choose' ? pendingQuoteScope !== null : undefined" :color="quoteReady ? 'var(--buddy-accent-text)' : undefined" :theme-overrides="annotationIconTheme" @click="toggleAnnotationQuoteMenu" @keydown.tab="closeAnnotationQuoteMenu">
                        <template #icon>
                          <DesktopIcon :component="TextQuote20Regular" />
                        </template>
                      </NButton>
                    </NDropdown>
                  </span>
                </template>
                {{ quoteLabel }}
              </NTooltip>
              <span class="w-px h-[14px] flex-none mx-[4px] bg-border" aria-hidden="true" />
            </template>
            <NTooltip trigger="hover" :delay="350">
              <template #trigger>
                <span class="inline-flex flex-none">
                  <NButton class="image-annotation-action buddy-icon-button w-[28px] h-[28px] flex-none" quaternary data-image-annotation-toggle :data-testid="annotationPhase === 'off' ? 'image-annotation-enter' : 'image-annotation-exit'" :aria-pressed="annotationPhase !== 'off'" :aria-label="annotationToggleLabel" :color="annotationPhase === 'off' ? undefined : 'var(--buddy-accent-on-surface)'" :theme-overrides="annotationPhase === 'off' ? annotationIconTheme : annotationSelectedTheme" @click="toggleAnnotation">
                    <template #icon>
                      <DesktopIcon :component="ImageEdit20Regular" />
                    </template>
                  </NButton>
                </span>
              </template>
              {{ annotationToggleLabel }}
            </NTooltip>
          </div>
          <WorkbenchMenu v-if="target" target="resource.actions" :values="{ 'resource.scheme': view.resource.scheme }" :capture="captureResource" />
        </template>
      </DesktopDocumentToolbar>
    </Teleport>
    <div v-if="directory" class="grid gap-2 p-4 text-muted">
      <strong>{{ view.title }}</strong>
      <span>{{ view.resource.data.path }}</span>
    </div>
    <div v-else-if="failed" class="flex items-center gap-[8px] p-[12px] text-muted text-[12px]" role="alert">
      <span>{{ missing ? labels.fileMissing : labels.failed }}</span>
      <button type="button" class="file-preview__retry border-0 bg-transparent p-0 text-accent cursor-pointer underline text-[12px] hover:opacity-85" @click="loadPreview">
        {{ labels.retry }}
      </button>
    </div>
    <DesktopFileLoading v-else-if="!preview && !previewRenderer" :loading="true" :label="labels.loading" />
    <p v-else-if="!(mode === 'preview' && previewRenderer) && (preview?.kind === 'binary' || preview?.kind === 'oversized')" class="p-[16px] text-muted text-[13px]" role="status">
      {{ language === 'en-US' ? (preview.kind === 'oversized' ? 'This file is too large for the built-in preview.' : 'No available reader supports this file.') : (preview.kind === 'oversized' ? '文件超出内置预览的大小限制。' : '暂无可用阅读器支持此文件。') }}
    </p>
    <DesktopDocumentContent
      v-else
      ref="document" :mode="mode" :name="view.title" :text="preview?.text" :image-url="preview?.imageUrl" :image-cross-origin="canvasPreview" :media-kind="preview?.kind === 'audio' || preview?.kind === 'video' ? preview.kind : null" :media-url="preview?.mediaUrl" :resolve-image="imageResolver" :visible="visible" :wrap="view.state.wrap !== false" :language="language" :write-clipboard-text="writeClipboardText"
      :quote-source="selection.enabled ? quoteSource : undefined" :prepare-quote="selection.prepare" @preview-error="failed = true" @scroll.capture="selection.close"
    >
      <template v-if="previewRenderer" #preview>
        <component :is="previewRenderer.component" v-bind="previewRenderer.props" @error="failed = true" />
      </template>
      <template v-if="annotationPhase === 'on'" #imageOverlay>
        <ImageAnnotationSurface :image="previewImage()" :rects="annotationRects" :disabled="annotationBusy" :label="t('desktop.chat.imageAnnotation')" @commit="commitAnnotation" @history="applyAnnotationHistory" />
      </template>
    </DesktopDocumentContent>
    <ResourceSelectionQuoteMenu v-if="selection.enabled" :selection="selection" :language="language" />
  </div>
</template>
