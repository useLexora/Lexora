import type {
  DocumentOutlineItem,
} from '@haohaoxue/lexora-contracts'
import type { Editor } from '@tiptap/core'
import type { TiptapEditorContent } from '../../core/typing'
import {
  buildDocumentBlockIndex,
  buildDocumentOutline,
  searchDocumentBlocks,
} from '@haohaoxue/lexora-shared/document'
import {
  computed,
  shallowRef,
  watch,
} from 'vue'
import { translate } from '@/i18n'
import {
  buildDocumentBlockHash,
  replaceCurrentDocumentBlockHash,
} from '@/utils/documentBlockAnchor'
import { findBlockById, getCurrentBlock } from '../../commands/currentBlock'
import {
  flashDocumentBlock,
  scrollDocumentBlockIntoView,
} from '../block-trigger/blockTriggerDom'
import { useEditorSnapshot } from '../shared/useEditorSnapshot'
import {
  resolveActiveOutlineBlockId,
  resolveOutlineIndent,
  resolveOutlineIndicatorWidth,
  resolveOutlineSelectionPosition,
} from './outline'

export function useEditorOutline(options: {
  defaultExpanded?: boolean
  editor: Editor
  getContent: () => TiptapEditorContent
}) {
  const isExpanded = shallowRef(Boolean(options.defaultExpanded))
  const searchQuery = shallowRef('')
  const selectedSearchIndex = shallowRef(-1)
  const editorSnapshot = useEditorSnapshot(options.editor)
  const blockIndex = computed(() => {
    return buildDocumentBlockIndex(options.getContent())
  })
  const outline = computed(() => buildDocumentOutline(blockIndex.value))
  const currentBlockId = computed(() => {
    void editorSnapshot.value
    const currentBlock = getCurrentBlock(options.editor.state.selection)

    return typeof currentBlock?.node.attrs?.id === 'string'
      ? currentBlock.node.attrs.id
      : null
  })
  const activeOutlineBlockId = computed(() =>
    resolveActiveOutlineBlockId(blockIndex.value, currentBlockId.value),
  )
  const searchResults = computed(() =>
    searchDocumentBlocks(blockIndex.value, searchQuery.value),
  )
  const selectedSearchBlockId = computed(() =>
    selectedSearchIndex.value >= 0
      ? searchResults.value[selectedSearchIndex.value]?.blockId ?? null
      : null,
  )

  watch(
    [searchQuery, searchResults],
    ([nextQuery, nextResults]) => {
      if (!nextQuery.trim() || nextResults.length === 0) {
        selectedSearchIndex.value = -1
        return
      }

      if (selectedSearchIndex.value < 0 || selectedSearchIndex.value >= nextResults.length) {
        selectedSearchIndex.value = 0
      }
    },
    {
      immediate: true,
    },
  )

  function setExpanded(value: boolean) {
    isExpanded.value = value
  }

  function isActiveOutlineBlock(blockId: string) {
    return activeOutlineBlockId.value === blockId
  }

  function getHeadingText(item: DocumentOutlineItem) {
    return item.plainText.trim() || translate('editor.outline.headingFallback')
  }

  function getSearchResultText(value: string) {
    return value.trim() || translate('editor.outline.blockEmpty')
  }

  function getBlockHref(blockId: string) {
    return buildDocumentBlockHash(blockId)
  }

  function updateSearchQuery(value: string) {
    searchQuery.value = value
  }

  function handleSearchKeydown(event: Event | KeyboardEvent) {
    if (!(event instanceof KeyboardEvent)) {
      return
    }

    if (!searchQuery.value.trim() || searchResults.value.length === 0) {
      return
    }

    if (event.key === 'ArrowDown') {
      event.preventDefault()
      selectNextSearchResult()
      return
    }

    if (event.key === 'ArrowUp') {
      event.preventDefault()
      selectPreviousSearchResult()
      return
    }

    if (event.key === 'Enter') {
      event.preventDefault()
      selectCurrentSearchResult()
    }
  }

  function isSearchResultSelected(blockId: string) {
    if (selectedSearchBlockId.value) {
      return selectedSearchBlockId.value === blockId
    }

    return currentBlockId.value === blockId
  }

  function setSelectedSearchIndex(index: number) {
    selectedSearchIndex.value = index
  }

  function selectNextSearchResult() {
    if (searchResults.value.length === 0) {
      return
    }

    selectedSearchIndex.value = selectedSearchIndex.value >= searchResults.value.length - 1
      ? 0
      : selectedSearchIndex.value + 1
  }

  function selectPreviousSearchResult() {
    if (searchResults.value.length === 0) {
      return
    }

    selectedSearchIndex.value = selectedSearchIndex.value <= 0
      ? searchResults.value.length - 1
      : selectedSearchIndex.value - 1
  }

  function selectCurrentSearchResult() {
    const blockId = selectedSearchBlockId.value ?? searchResults.value[0]?.blockId

    if (!blockId) {
      return
    }

    selectBlock(blockId)
  }

  function selectBlock(blockId: string) {
    const targetBlock = findBlockById(options.editor.state.doc, blockId)

    if (!targetBlock) {
      return
    }

    scrollDocumentBlockIntoView(options.editor, blockId)
    flashDocumentBlock(options.editor, blockId)
    options.editor.chain().focus(resolveOutlineSelectionPosition(targetBlock)).run()
    replaceCurrentDocumentBlockHash(blockId)
  }

  return {
    activeOutlineBlockId,
    currentBlockId,
    getBlockHref,
    getSearchResultText,
    getHeadingText,
    handleSearchKeydown,
    isActiveOutlineBlock,
    isSearchResultSelected,
    isExpanded,
    outline,
    resolveOutlineIndicatorWidth,
    resolveOutlineIndent,
    searchQuery,
    searchResults,
    selectBlock,
    selectCurrentSearchResult,
    selectNextSearchResult,
    selectPreviousSearchResult,
    setExpanded,
    setSelectedSearchIndex,
    updateSearchQuery,
  }
}
