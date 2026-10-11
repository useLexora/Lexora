import type * as Monaco from 'monaco-editor/editor/editor.api.js'
import type { Ref } from 'vue'
import type { DesktopTerminalTranscriptProjection } from '../../model/transcript/typing'
import { shallowRef, watch } from 'vue'
import {
  loadDesktopMonaco,
  observeDesktopMonacoTheme,
} from '@/shared/ui/monaco/desktopMonaco'
import { projectDesktopTerminalTranscriptModelUpdate } from '../../model/transcript/terminalTranscript'

interface UseDesktopTerminalTranscriptOptions {
  container: Readonly<Ref<HTMLElement | null>>
  transcript: Readonly<Ref<DesktopTerminalTranscriptProjection>>
}

export function useDesktopTerminalTranscript(options: UseDesktopTerminalTranscriptOptions) {
  const contentHeight = shallowRef<number | null>(null)
  const loading = shallowRef(true)
  const failed = shallowRef(false)

  watch(options.container, async (container, _previous, onCleanup) => {
    contentHeight.value = null
    failed.value = false
    loading.value = true
    if (!container)
      return

    let disposed = false
    let editor: Monaco.editor.IStandaloneCodeEditor | null = null
    let model: Monaco.editor.ITextModel | null = null
    let contentSizeListener: Monaco.IDisposable | null = null
    let stopThemeSync: (() => void) | null = null
    let stopTranscriptWatch: (() => void) | null = null
    let appliedTranscript: DesktopTerminalTranscriptProjection | null = null
    let commandDecorationIds: string[] = []
    let outputDecorationIds: string[] = []

    function disposeEditor() {
      disposed = true
      stopTranscriptWatch?.()
      stopTranscriptWatch = null
      contentSizeListener?.dispose()
      contentSizeListener = null
      stopThemeSync?.()
      stopThemeSync = null
      editor?.dispose()
      editor = null
      model?.dispose()
      model = null
    }

    onCleanup(disposeEditor)

    try {
      const monaco = await loadDesktopMonaco()
      if (disposed || options.container.value !== container)
        return
      const transcript = options.transcript.value
      model = monaco.editor.createModel(
        transcript.text,
        transcript.language,
        monaco.Uri.parse(`inmemory://lexora-buddy/terminal/${crypto.randomUUID()}`),
      )
      editor = monaco.editor.create(container, createTerminalEditorOptions(model))
      contentHeight.value = editor.getContentHeight()
      contentSizeListener = editor.onDidContentSizeChange((event) => {
        contentHeight.value = event.contentHeight
      })
      updateTranscript(transcript)
      stopTranscriptWatch = watch(options.transcript, updateTranscript)
      stopThemeSync = observeDesktopMonacoTheme(monaco, editor)
      loading.value = false

      function updateTranscript(transcript: DesktopTerminalTranscriptProjection) {
        if (!editor || !model)
          return
        const update = appliedTranscript
          ? projectDesktopTerminalTranscriptModelUpdate(appliedTranscript, transcript)
          : { kind: 'replace' as const }
        if (update.kind === 'unchanged')
          return
        if (model.getLanguageId() !== transcript.language)
          monaco.editor.setModelLanguage(model, transcript.language)
        if (update.kind === 'append') {
          const lineNumber = model.getLineCount()
          const column = model.getLineMaxColumn(lineNumber)
          model.applyEdits([{
            forceMoveMarkers: true,
            range: new monaco.Range(lineNumber, column, lineNumber, column),
            text: update.text,
          }])
        }
        else if (model.getValue() !== transcript.text) {
          model.setValue(transcript.text)
        }
        if (update.kind === 'replace')
          commandDecorationIds = updateCommandDecorations(monaco, editor, model, transcript, commandDecorationIds)
        outputDecorationIds = updateOutputDecoration(monaco, editor, model, transcript, outputDecorationIds)
        appliedTranscript = transcript
      }
    }
    catch {
      if (!disposed && options.container.value === container) {
        disposeEditor()
        contentHeight.value = null
        failed.value = true
        loading.value = false
      }
    }
  }, { flush: 'post', immediate: true })

  return { contentHeight, failed, loading }
}

function updateCommandDecorations(
  monaco: typeof Monaco,
  editor: Monaco.editor.IStandaloneCodeEditor,
  model: Monaco.editor.ITextModel,
  transcript: DesktopTerminalTranscriptProjection,
  previousIds: string[],
): string[] {
  const commandLastLine = transcript.promptRanges.length
  const decorations: Monaco.editor.IModelDeltaDecoration[] = []
  for (const range of transcript.promptRanges) {
    decorations.push(
      {
        options: { inlineClassName: 'desktop-terminal-transcript__prompt', zIndex: 2 },
        range: new monaco.Range(range.lineNumber, 1, range.lineNumber, range.endColumn),
      },
      {
        options: { inlineClassName: 'desktop-terminal-transcript__command', zIndex: 1 },
        range: new monaco.Range(
          range.lineNumber,
          range.endColumn,
          range.lineNumber,
          model.getLineMaxColumn(range.lineNumber),
        ),
      },
    )
  }
  const commandText = model.getValueInRange(new monaco.Range(
    1,
    1,
    commandLastLine,
    model.getLineMaxColumn(commandLastLine),
  ))
  const tokenizedLines = monaco.editor.tokenize(commandText, transcript.language)
  for (const [lineIndex, tokens] of tokenizedLines.entries()) {
    const lineNumber = lineIndex + 1
    const promptEndColumn = transcript.promptRanges[lineIndex]?.endColumn ?? 1
    const lineMaxColumn = model.getLineMaxColumn(lineNumber)
    for (const [tokenIndex, token] of tokens.entries()) {
      const className = terminalTokenClassName(token.type)
      if (!className)
        continue
      const startColumn = Math.max(token.offset + 1, promptEndColumn)
      const endColumn = Math.min(
        tokens[tokenIndex + 1]?.offset !== undefined
          ? tokens[tokenIndex + 1].offset + 1
          : lineMaxColumn,
        lineMaxColumn,
      )
      if (startColumn >= endColumn)
        continue
      decorations.push({
        options: { inlineClassName: className, zIndex: 3 },
        range: new monaco.Range(lineNumber, startColumn, lineNumber, endColumn),
      })
    }
  }
  const firstCommandLine = model.getLineContent(1)
  const firstCommandStart = transcript.promptRanges[0]?.endColumn ?? 1
  const firstCommandMatch = /\S+/.exec(firstCommandLine.slice(firstCommandStart - 1))
  if (firstCommandMatch) {
    const startColumn = firstCommandStart + firstCommandMatch.index
    decorations.push({
      options: {
        inlineClassName: 'desktop-terminal-transcript__token-command',
        zIndex: 4,
      },
      range: new monaco.Range(
        1,
        startColumn,
        1,
        startColumn + firstCommandMatch[0].length,
      ),
    })
  }
  return editor.deltaDecorations(previousIds, decorations)
}

function updateOutputDecoration(
  monaco: typeof Monaco,
  editor: Monaco.editor.IStandaloneCodeEditor,
  model: Monaco.editor.ITextModel,
  transcript: DesktopTerminalTranscriptProjection,
  previousIds: string[],
): string[] {
  if (transcript.outputStartLine === null)
    return editor.deltaDecorations(previousIds, [])
  const lastLine = model.getLineCount()
  return editor.deltaDecorations(previousIds, [{
    options: { inlineClassName: 'desktop-terminal-transcript__output' },
    range: new monaco.Range(
      transcript.outputStartLine,
      1,
      lastLine,
      model.getLineMaxColumn(lastLine),
    ),
  }])
}

function terminalTokenClassName(type: string): string | null {
  const token = type.toLowerCase()
  if (token.startsWith('comment'))
    return 'desktop-terminal-transcript__token-comment'
  if (token.startsWith('string'))
    return 'desktop-terminal-transcript__token-string'
  if (token.startsWith('keyword'))
    return 'desktop-terminal-transcript__token-keyword'
  if (token.startsWith('type.identifier'))
    return 'desktop-terminal-transcript__token-command'
  if (token.startsWith('attribute.name'))
    return 'desktop-terminal-transcript__token-attribute'
  if (token.startsWith('number') || token.startsWith('constants'))
    return 'desktop-terminal-transcript__token-number'
  if (token.startsWith('variable'))
    return 'desktop-terminal-transcript__token-variable'
  if (token.startsWith('delimiter'))
    return 'desktop-terminal-transcript__token-operator'
  if (token.startsWith('metatag'))
    return 'desktop-terminal-transcript__token-metatag'
  return null
}

function createTerminalEditorOptions(model: Monaco.editor.ITextModel): Monaco.editor.IStandaloneEditorConstructionOptions {
  return {
    model,
    automaticLayout: true,
    bracketPairColorization: { enabled: false, independentColorPoolPerBracketType: false },
    contextmenu: false,
    copyWithSyntaxHighlighting: false,
    cursorBlinking: 'solid',
    cursorWidth: 0,
    domReadOnly: false,
    folding: false,
    fontLigatures: false,
    fontSize: 12.5,
    glyphMargin: false,
    guides: {
      bracketPairs: false,
      bracketPairsHorizontal: false,
      highlightActiveBracketPair: false,
      highlightActiveIndentation: false,
      indentation: false,
    },
    hover: { enabled: 'off' },
    lineDecorationsWidth: 0,
    lineHeight: 20,
    lineNumbers: 'off',
    links: false,
    matchBrackets: 'never',
    minimap: { enabled: false },
    mouseStyle: 'text',
    occurrencesHighlight: 'off',
    overviewRulerBorder: false,
    overviewRulerLanes: 0,
    padding: { bottom: 0, top: 0 },
    readOnly: true,
    renderLineHighlight: 'none',
    renderValidationDecorations: 'off',
    roundedSelection: false,
    scrollBeyondLastLine: false,
    scrollbar: {
      alwaysConsumeMouseWheel: false,
      horizontal: 'hidden',
      horizontalHasArrows: false,
      horizontalScrollbarSize: 0,
      useShadows: false,
      vertical: 'auto',
      verticalHasArrows: false,
      verticalScrollbarSize: 10,
      verticalSliderSize: 6,
    },
    selectionHighlight: false,
    smoothScrolling: true,
    stickyScroll: { enabled: false },
    wordWrap: 'on',
    wrappingIndent: 'same',
    wrappingStrategy: 'advanced',
  }
}
