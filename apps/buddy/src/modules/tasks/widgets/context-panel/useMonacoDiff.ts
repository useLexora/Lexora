import type * as Monaco from 'monaco-editor/editor/editor.api.js'
import type { Ref } from 'vue'
import { readonly, shallowRef, watch } from 'vue'
import {
  loadDesktopMonaco,
  observeDesktopMonacoTheme,
} from '@/shared/ui/monaco/desktopMonaco'
import { observeDesktopMonacoLayout } from '@/shared/ui/monaco/desktopMonacoLayout'

interface UseMonacoDiffOptions {
  wrap?: Readonly<Ref<boolean>>
  sideBySide?: Readonly<Ref<boolean>>
  onHeight?: (height: number) => void
  getViewState?: () => Monaco.editor.IDiffEditorViewState | null
  onViewState?: (state: Monaco.editor.IDiffEditorViewState | null) => void
  container: Readonly<Ref<HTMLElement | null>>
  language: Readonly<Ref<string | null>>
  modified: Readonly<Ref<string>>
  original: Readonly<Ref<string>>
  path: Readonly<Ref<string>>
}

export function useMonacoDiff(options: UseMonacoDiffOptions) {
  const loading = shallowRef(true)
  const failed = shallowRef(false)

  watch([options.container, options.path], async ([container, path], _previous, onCleanup) => {
    let active = true
    let editor: Monaco.editor.IStandaloneDiffEditor | null = null
    let originalModel: Monaco.editor.ITextModel | null = null
    let modifiedModel: Monaco.editor.ITextModel | null = null
    let diffModel: Monaco.editor.IDiffEditorViewModel | null = null
    let savedViewState: Monaco.editor.IDiffEditorViewState | null | undefined
    let stopThemeSync: (() => void) | null = null
    let stopModelWatch: (() => void) | null = null
    let stopOptionsWatch: (() => void) | null = null
    let sizeListener: Monaco.IDisposable | null = null
    let stopLayout: (() => void) | null = null
    let initialized = false
    function dispose() {
      stopModelWatch?.()
      stopModelWatch = null
      stopOptionsWatch?.()
      sizeListener?.dispose()
      stopLayout?.()
      stopThemeSync?.()
      stopThemeSync = null
      editor?.setModel(null)
      diffModel?.dispose()
      diffModel = null
      editor?.dispose()
      editor = null
      originalModel?.dispose()
      originalModel = null
      modifiedModel?.dispose()
      modifiedModel = null
    }
    onCleanup(() => {
      if (initialized && editor)
        options.onViewState?.(savedViewState ?? editor.saveViewState())
      active = false
      dispose()
    })
    failed.value = false
    loading.value = Boolean(container)
    if (!container)
      return
    try {
      const monaco = await loadDesktopMonaco()
      if (!active)
        return
      const modelId = crypto.randomUUID()
      const language = options.language.value ?? 'plaintext'
      originalModel = monaco.editor.createModel(
        options.original.value,
        language,
        monaco.Uri.parse(`inmemory://lexora-buddy/${modelId}/before/${path}`),
      )
      modifiedModel = monaco.editor.createModel(
        options.modified.value,
        language,
        monaco.Uri.parse(`inmemory://lexora-buddy/${modelId}/after/${path}`),
      )
      editor = monaco.editor.createDiffEditor(container, {
        automaticLayout: false,
        dimension: { width: container.clientWidth, height: container.clientHeight },
        contextmenu: false,
        diffCodeLens: false,
        domReadOnly: true,
        enableSplitViewResizing: true,
        fontSize: 12,
        hideUnchangedRegions: {
          contextLineCount: 3,
          enabled: true,
          minimumLineCount: 8,
          revealLineCount: 12,
        },
        lineHeight: 20,
        minimap: { enabled: false },
        originalEditable: false,
        overviewRulerLanes: 0,
        padding: { bottom: 16, top: 12 },
        readOnly: true,
        renderMarginRevertIcon: false,
        renderOverviewRuler: false,
        renderSideBySide: options.sideBySide?.value ?? true,
        useInlineViewWhenSpaceIsLimited: false,
        diffWordWrap: options.wrap?.value ? 'on' : 'off',
        scrollBeyondLastLine: false,
        scrollbar: { alwaysConsumeMouseWheel: false },
        smoothScrolling: true,
        stickyScroll: { enabled: false },
      })
      stopLayout = observeDesktopMonacoLayout(container, size => editor?.layout(size))
      savedViewState = options.getViewState?.()
      const updateHeight = () => {
        if (editor?.getLineChanges())
          options.onHeight?.(Math.max(editor.getOriginalEditor().getContentHeight(), editor.getModifiedEditor().getContentHeight()))
      }
      const onContentSizeChange = (event: Monaco.editor.IContentSizeChangedEvent) => {
        if (event.contentHeightChanged)
          updateHeight()
      }
      const subscriptions = [
        editor.getOriginalEditor().onDidContentSizeChange(onContentSizeChange),
        editor.getModifiedEditor().onDidContentSizeChange(onContentSizeChange),
        editor.onDidUpdateDiff(() => {
          if (savedViewState) {
            const state = savedViewState
            savedViewState = null
            editor?.restoreViewState(state)
          }
          updateHeight()
        }),
      ]
      sizeListener = { dispose: () => subscriptions.forEach(subscription => subscription.dispose()) }
      diffModel = editor.createViewModel({ modified: modifiedModel, original: originalModel })
      editor.setModel(diffModel)
      stopOptionsWatch = watch([() => options.wrap?.value, () => options.sideBySide?.value], ([wrap, sideBySide]) => {
        editor?.updateOptions({ diffWordWrap: wrap ? 'on' : 'off', renderSideBySide: sideBySide ?? true, wordWrapOverride2: 'inherit' })
      })
      stopThemeSync = observeDesktopMonacoTheme(monaco, editor)
      stopModelWatch = watch([options.original, options.modified, options.language], ([original, modified, language]) => {
        if (!editor || !originalModel || !modifiedModel)
          return
        const viewState = editor.saveViewState()
        if (originalModel.getValue() !== original)
          originalModel.setValue(original)
        if (modifiedModel.getValue() !== modified)
          modifiedModel.setValue(modified)
        for (const model of [originalModel, modifiedModel]) {
          if (model.getLanguageId() !== (language ?? 'plaintext'))
            monaco.editor.setModelLanguage(model, language ?? 'plaintext')
        }
        if (viewState)
          editor.restoreViewState(viewState)
      }, { flush: 'sync' })
      initialized = true
      loading.value = false
    }
    catch {
      dispose()
      if (active) {
        failed.value = true
        loading.value = false
      }
    }
  }, { immediate: true, flush: 'sync' })

  return { failed: readonly(failed), loading: readonly(loading) }
}
