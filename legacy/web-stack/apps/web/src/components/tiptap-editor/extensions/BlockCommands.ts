import type { CommandProps, Editor } from '@tiptap/core'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import type { CurrentBlockSelection } from '../commands/currentBlock'
import type { TurnIntoBlockType } from '../commands/turnInto'
import { Extension } from '@tiptap/core'
import { NodeSelection, Selection, TextSelection } from '@tiptap/pm/state'
import { CellSelection } from '@tiptap/pm/tables'
import { runLexoraBackspacePolicy } from '../commands/block-context/backspace'
import { findBlockById, getCurrentBlock } from '../commands/currentBlock'
import { recordHistorySelectionDeletedText } from '../commands/historySelection'
import { TIPTAP_SPLIT_MERGE_EXCLUDED_ANCESTOR_NODE_NAMES } from '../content/blockTaxonomy'

type HeadingTurnIntoBlockType = Extract<TurnIntoBlockType, 'heading-1' | 'heading-2' | 'heading-3' | 'heading-4' | 'heading-5'>
type BlockCommandContext = Pick<CommandProps, 'commands' | 'editor' | 'tr'>
type DeletionDirection = 'backward' | 'forward'
type StandardListTypeName = 'bulletList' | 'orderedList'
const EMPTY_STORED_MARKS: [] = []
const STANDARD_LIST_NODE_TYPE_NAMES = new Set<string>(['bulletList', 'orderedList'])
const LIST_ITEM_NODE_TYPE_NAMES = new Set<string>(['listItem', 'taskItem'])
const SPLIT_MERGE_EXCLUDED_NODE_NAMES = new Set<string>(TIPTAP_SPLIT_MERGE_EXCLUDED_ANCESTOR_NODE_NAMES)

const HEADING_LEVEL_BY_TARGET: Record<HeadingTurnIntoBlockType, 1 | 2 | 3 | 4 | 5> = {
  'heading-1': 1,
  'heading-2': 2,
  'heading-3': 3,
  'heading-4': 4,
  'heading-5': 5,
}

export const BlockCommands = Extension.create({
  name: 'BlockCommands',
  priority: 1_000,

  addCommands() {
    return {
      turnIntoBlock: target => (props) => {
        switch (target) {
          case 'paragraph':
            return turnIntoParagraph(props)
          case 'heading-1':
          case 'heading-2':
          case 'heading-3':
          case 'heading-4':
          case 'heading-5':
            return turnIntoHeading(props, HEADING_LEVEL_BY_TARGET[target])
          case 'bulletList':
            return turnIntoBulletList(props)
          case 'orderedList':
            return turnIntoOrderedList(props)
          case 'codeBlock':
            return turnIntoCodeBlock(props)
          case 'blockMath':
            return turnIntoBlockMath(props)
          case 'blockquote':
            return turnIntoBlockquote(props)
          case 'divider':
            return turnIntoDivider(props)
          case 'taskList':
            return turnIntoTaskList(props)
        }
      },
      indentBlock: () => (props) => {
        const listItemType = getActiveListItemType(props.editor)

        if (!listItemType || !canIndentCurrentListItem(props.editor, listItemType)) {
          return false
        }

        return props.commands.sinkListItem(listItemType)
      },
      outdentBlock: () => (props) => {
        const listItemType = getActiveListItemType(props.editor)

        if (!listItemType) {
          return false
        }

        return props.commands.liftListItem(listItemType)
      },
      moveBlockUp: () => (props: CommandProps) => moveCurrentBlock(props, 'up'),
      moveBlockDown: () => (props: CommandProps) => moveCurrentBlock(props, 'down'),
      moveCurrentBlockTo: (targetBlockId, placement) => (props: CommandProps) =>
        moveCurrentBlockTo(props, targetBlockId, placement),
      insertBlock: () => (props: CommandProps) => insertBlockAfterCurrent(props),
      deleteBlock: () => (props: CommandProps) => deleteCurrentBlock(props),
      duplicateBlock: () => (props: CommandProps) => duplicateCurrentBlock(props),
      splitCurrentBlock: () => (props: CommandProps) => splitCurrentBlock(props),
      mergeBlockBackward: () => (props: CommandProps) => mergeBlockBackward(props),
      deleteForward: () => (props: CommandProps) => deleteForward(props),
    }
  },

  addKeyboardShortcuts() {
    return {
      'Enter': () => this.editor.commands.splitCurrentBlock(),
      'Backspace': () => this.editor.commands.mergeBlockBackward(),
      'Delete': () => this.editor.commands.deleteForward(),
      'Alt-Shift-ArrowUp': () => this.editor.commands.moveBlockUp(),
      'Alt-Shift-ArrowDown': () => this.editor.commands.moveBlockDown(),
    }
  },
})

export function isTurnIntoBlockActive(editor: Editor, target: TurnIntoBlockType) {
  switch (target) {
    case 'paragraph':
      return isPlainParagraphActive(editor)
    case 'heading-1':
    case 'heading-2':
    case 'heading-3':
    case 'heading-4':
    case 'heading-5':
      return editor.isActive('heading', {
        level: HEADING_LEVEL_BY_TARGET[target],
      })
    case 'bulletList':
      return editor.isActive('bulletList')
    case 'orderedList':
      return editor.isActive('orderedList')
    case 'codeBlock':
      return editor.isActive('codeBlock')
    case 'blockMath':
      return editor.isActive('blockMath')
    case 'blockquote':
      return editor.isActive('blockquote')
    case 'divider':
      return editor.isActive('horizontalRule')
    case 'taskList':
      return editor.isActive('taskList')
  }
}

function turnIntoParagraph(props: BlockCommandContext) {
  if (isTurnIntoBlockActive(props.editor, 'paragraph')) {
    return true
  }

  return props.commands.clearNodes()
}

function turnIntoHeading(props: BlockCommandContext, level: 1 | 2 | 3 | 4 | 5) {
  if (props.editor.isActive('heading', { level })) {
    return true
  }

  ensureParagraphBase(props)
  return props.commands.setNode('heading', { level })
}

function turnIntoBulletList(props: BlockCommandContext) {
  if (turnActiveListInto(props, 'bulletList')) {
    return true
  }

  if (props.editor.isActive('bulletList')) {
    return true
  }

  ensureParagraphBase(props)
  return props.commands.toggleBulletList()
}

function turnIntoOrderedList(props: BlockCommandContext) {
  if (turnActiveListInto(props, 'orderedList')) {
    return true
  }

  if (props.editor.isActive('orderedList')) {
    return true
  }

  ensureParagraphBase(props)
  return props.commands.toggleOrderedList()
}

function turnIntoCodeBlock(props: BlockCommandContext) {
  if (props.editor.isActive('codeBlock')) {
    return true
  }

  ensureParagraphBase(props)
  return props.commands.toggleCodeBlock()
}

function turnIntoBlockMath(props: BlockCommandContext) {
  if (props.editor.isActive('blockMath')) {
    return true
  }

  const currentBlock = getCurrentBlock(props.editor.state.selection)

  if (!currentBlock) {
    return props.commands.insertBlockMath({ latex: '' })
  }

  return props.editor.commands.command(({ state, tr }) => {
    const blockMathType = state.schema.nodes.blockMath

    if (!blockMathType) {
      return false
    }

    tr.replaceWith(currentBlock.from, currentBlock.to, blockMathType.create({ latex: '' }))
    tr.setSelection(NodeSelection.create(tr.doc, currentBlock.from))
    tr.scrollIntoView()

    return true
  })
}

function turnIntoBlockquote(props: BlockCommandContext) {
  if (props.editor.isActive('blockquote')) {
    return true
  }

  ensureParagraphBase(props)
  return props.commands.toggleBlockquote()
}

function turnIntoDivider(props: BlockCommandContext) {
  if (props.editor.isActive('horizontalRule')) {
    return true
  }

  ensureParagraphBase(props)
  return props.commands.setHorizontalRule()
}

function turnIntoTaskList(props: BlockCommandContext) {
  if (props.editor.isActive('taskList')) {
    return true
  }

  ensureParagraphBase(props)
  return props.commands.toggleTaskList()
}

function ensureParagraphBase(props: BlockCommandContext) {
  if (isPlainParagraphActive(props.editor)) {
    return true
  }

  return props.commands.clearNodes()
}

function isPlainParagraphActive(editor: Editor) {
  return editor.isActive('paragraph')
    && !editor.isActive('heading')
    && !editor.isActive('bulletList')
    && !editor.isActive('orderedList')
    && !editor.isActive('taskList')
    && !editor.isActive('codeBlock')
    && !editor.isActive('blockMath')
    && !editor.isActive('blockquote')
}

function getActiveListItemType(editor: Editor) {
  if (editor.isActive('taskItem')) {
    return 'taskItem'
  }

  if (editor.isActive('listItem')) {
    return 'listItem'
  }

  return null
}

function canIndentCurrentListItem(editor: Editor, listItemType: 'listItem' | 'taskItem') {
  const currentBlock = getCurrentBlock(editor.state.selection)

  if (!currentBlock || currentBlock.node.type.name !== listItemType) {
    return false
  }

  return currentBlock.index > 0
}

function splitCurrentBlock(props: BlockCommandContext) {
  if (!canHandlePlainBlockBoundary(props.editor)) {
    return false
  }

  const handled = props.commands.first(({ commands }) => [
    () => commands.newlineInCode(),
    () => commands.createParagraphNear(),
    () => commands.liftEmptyBlock(),
    () => commands.splitBlock({ keepMarks: false }),
  ])

  if (!handled || !props.editor.state.selection.empty) {
    return handled
  }

  const transaction = props.editor.state.tr.setStoredMarks(EMPTY_STORED_MARKS)

  if (transaction.storedMarksSet) {
    props.editor.view.dispatch(transaction)
  }

  return true
}

function mergeBlockBackward(props: CommandProps) {
  if (deleteSelectedTable(props, 'backward')) {
    return true
  }

  if (!props.editor.state.selection.empty) {
    recordHistorySelectionDeletedText(
      props.tr,
      props.editor.state.doc,
      props.editor.state.selection.from,
      props.editor.state.selection.to,
    )
    props.tr.deleteSelection()
    props.tr.scrollIntoView()
    return true
  }

  if (!canMergeCurrentBlock(props.editor)) {
    if (shouldHandleNestedListBackspace(props.editor.state.selection)) {
      return props.commands.first(({ commands }) => [
        () => commands.undoInputRule(),
        () => deleteEmptyNestedListItemToParagraph(props),
        () => deleteEmptyNestedParagraphBackward(props),
      ])
    }

    return props.commands.first(({ commands }) => [
      () => commands.undoInputRule(),
      () => deleteTextBeforeCaret(props),
    ])
  }

  return props.commands.first(({ commands }) => [
    () => commands.undoInputRule(),
    () => runLexoraBackspacePolicy(props),
    () => commands.joinBackward(),
    () => commands.selectNodeBackward(),
  ])
}

function deleteForward(props: CommandProps) {
  if (deleteSelectedTable(props, 'forward')) {
    return true
  }

  if (!props.editor.state.selection.empty) {
    recordHistorySelectionDeletedText(
      props.tr,
      props.editor.state.doc,
      props.editor.state.selection.from,
      props.editor.state.selection.to,
    )
    props.tr.deleteSelection()
    props.tr.scrollIntoView()
    return true
  }

  const range = resolveDeleteForwardTextRange(props.editor.state.selection)

  if (!range) {
    return false
  }

  recordHistorySelectionDeletedText(
    props.tr,
    props.editor.state.doc,
    range.from,
    range.to,
    'start',
  )
  props.tr.delete(range.from, range.to)
  props.tr.scrollIntoView()
  return true
}

function deleteTextBeforeCaret(props: CommandProps) {
  const range = resolveDeleteBackwardTextRange(props.editor.state.selection)

  if (!range) {
    return false
  }

  recordHistorySelectionDeletedText(
    props.tr,
    props.editor.state.doc,
    range.from,
    range.to,
  )
  props.tr.delete(range.from, range.to)
  props.tr.scrollIntoView()
  return true
}

function resolveDeleteForwardTextRange(selection: Selection) {
  if (
    !(selection instanceof TextSelection)
    || !selection.empty
    || !selection.$from.parent.isTextblock
    || selection.$from.parentOffset >= selection.$from.parent.content.size
    || !selection.$from.nodeAfter?.isText
    || !selection.$from.nodeAfter.text
  ) {
    return null
  }

  const deletedText = Array.from(selection.$from.nodeAfter.text).at(0)

  if (!deletedText) {
    return null
  }

  return {
    from: selection.from,
    to: selection.from + deletedText.length,
  }
}

function deleteSelectedTable(props: CommandProps, direction: DeletionDirection) {
  const { selection } = props.editor.state

  if (selection instanceof NodeSelection && selection.node.type.name === 'table') {
    deleteRangeAndSetLandingSelection(props, selection.from, selection.to, direction)
    return true
  }

  if (!(selection instanceof CellSelection)) {
    return false
  }

  const currentBlock = getCurrentBlock(selection)

  if (!currentBlock || currentBlock.node.type.name !== 'table') {
    return false
  }

  let cellCount = 0

  currentBlock.node.descendants((node) => {
    if (node.type.name === 'table') {
      return false
    }

    if (node.type.name === 'tableCell' || node.type.name === 'tableHeader') {
      cellCount += 1
    }
  })

  if (cellCount !== selection.ranges.length) {
    return false
  }

  deleteRangeAndSetLandingSelection(props, currentBlock.from, currentBlock.to, direction)
  return true
}

function deleteRangeAndSetLandingSelection(
  props: CommandProps,
  from: number,
  to: number,
  direction: DeletionDirection,
) {
  const landingSelection = resolveDeletionLandingSelection(
    props.editor.state.doc,
    from,
    to,
    direction,
  )

  props.tr.delete(from, to)

  if (!landingSelection) {
    props.tr.scrollIntoView()
    return
  }

  props.tr.setSelection(landingSelection.map(props.tr.doc, props.tr.mapping))
  props.tr.scrollIntoView()
}

function resolveDeletionLandingSelection(
  doc: CommandProps['editor']['state']['doc'],
  from: number,
  to: number,
  direction: DeletionDirection,
) {
  const previousSelection = Selection.findFrom(doc.resolve(from), -1, true)
  const nextSelection = Selection.findFrom(doc.resolve(to), 1, true)

  if (direction === 'backward') {
    return previousSelection ?? nextSelection
  }

  return nextSelection ?? previousSelection
}

function resolveDeleteBackwardTextRange(selection: Selection) {
  if (
    !(selection instanceof TextSelection)
    || !selection.empty
    || !selection.$from.parent.isTextblock
    || selection.$from.parentOffset <= 0
    || !selection.$from.nodeBefore?.isText
    || !selection.$from.nodeBefore.text
  ) {
    return null
  }

  const deletedText = Array.from(selection.$from.nodeBefore.text).at(-1)

  if (!deletedText) {
    return null
  }

  return {
    from: selection.from - deletedText.length,
    to: selection.from,
  }
}

function turnActiveListInto(props: BlockCommandContext, targetTypeName: StandardListTypeName) {
  const activeList = resolveActiveStandardList(props.editor.state.selection)

  if (!activeList) {
    return false
  }

  if (activeList.node.type.name === targetTypeName) {
    return true
  }

  const targetType = props.editor.schema.nodes[targetTypeName]

  if (!targetType || !targetType.validContent(activeList.node.content)) {
    return false
  }

  props.tr.setNodeMarkup(activeList.from, targetType, null, activeList.node.marks)
  props.tr.scrollIntoView()
  return true
}

function resolveActiveStandardList(selection: Selection): { from: number, node: ProseMirrorNode } | null {
  const { $from } = selection

  for (let depth = $from.depth; depth > 0; depth -= 1) {
    const node = $from.node(depth)

    if (!STANDARD_LIST_NODE_TYPE_NAMES.has(node.type.name)) {
      continue
    }

    return {
      from: $from.before(depth),
      node,
    }
  }

  return null
}

function deleteEmptyNestedListItemToParagraph(props: CommandProps) {
  const range = resolveEmptyNestedListItemRange(props.editor.state.selection)

  if (!range) {
    return false
  }

  const paragraphType = props.editor.schema.nodes.paragraph

  if (!paragraphType) {
    return false
  }

  props.tr.replaceWith(range.from, range.to, paragraphType.create())
  props.tr.setSelection(TextSelection.create(props.tr.doc, range.from + 1))
  props.tr.scrollIntoView()
  return true
}

function shouldHandleNestedListBackspace(selection: Selection) {
  return Boolean(resolveEmptyNestedListItemRange(selection) || resolveEmptyNestedParagraphRange(selection))
}

function deleteEmptyNestedParagraphBackward(props: CommandProps) {
  const range = resolveEmptyNestedParagraphRange(props.editor.state.selection)

  if (!range) {
    return false
  }

  props.tr.delete(range.from, range.to)
  props.tr.setSelection(TextSelection.create(props.tr.doc, props.tr.mapping.map(range.previousTextEnd, -1)))
  props.tr.scrollIntoView()
  return true
}

function resolveEmptyNestedListItemRange(selection: Selection) {
  if (
    !(selection instanceof TextSelection)
    || !selection.empty
    || selection.$from.parentOffset !== 0
    || selection.$from.parent.type.name !== 'paragraph'
    || selection.$from.parent.content.size > 0
  ) {
    return null
  }

  const listItemDepth = findClosestAncestorDepth(selection, LIST_ITEM_NODE_TYPE_NAMES)

  if (!listItemDepth) {
    return null
  }

  const listItem = selection.$from.node(listItemDepth)
  const listDepth = listItemDepth - 1
  const list = selection.$from.node(listDepth)

  if (
    listItem.childCount !== 1
    || listItem.firstChild?.type.name !== 'paragraph'
    || listItem.firstChild.content.size > 0
    || !STANDARD_LIST_NODE_TYPE_NAMES.has(list.type.name)
    || list.childCount !== 1
    || !findClosestAncestorDepth(selection, LIST_ITEM_NODE_TYPE_NAMES, listDepth - 1)
  ) {
    return null
  }

  const from = selection.$from.before(listDepth)

  return {
    from,
    to: from + list.nodeSize,
  }
}

function resolveEmptyNestedParagraphRange(selection: Selection) {
  if (
    !(selection instanceof TextSelection)
    || !selection.empty
    || selection.$from.parentOffset !== 0
    || selection.$from.parent.type.name !== 'paragraph'
    || selection.$from.parent.content.size > 0
  ) {
    return null
  }

  const paragraphDepth = selection.$from.depth
  const parentDepth = paragraphDepth - 1
  const parentNode = selection.$from.node(parentDepth)

  if (!LIST_ITEM_NODE_TYPE_NAMES.has(parentNode.type.name)) {
    return null
  }

  const paragraphIndex = selection.$from.index(parentDepth)

  if (paragraphIndex <= 0) {
    return null
  }

  const previousNode = parentNode.child(paragraphIndex - 1)

  if (!previousNode.isTextblock) {
    return null
  }

  const from = selection.$from.before(paragraphDepth)

  return {
    from,
    previousTextEnd: from - 1,
    to: selection.$from.after(paragraphDepth),
  }
}

function findClosestAncestorDepth(
  selection: Selection,
  nodeTypeNames: Set<string>,
  maxDepth = selection.$from.depth,
) {
  for (let depth = maxDepth; depth > 0; depth -= 1) {
    if (nodeTypeNames.has(selection.$from.node(depth).type.name)) {
      return depth
    }
  }

  return null
}

function duplicateCurrentBlock(props: CommandProps) {
  const currentBlock = getCurrentBlock(props.tr.selection)

  if (!currentBlock) {
    return false
  }

  props.tr.insert(currentBlock.to, currentBlock.node.copy(currentBlock.node.content))
  props.tr.scrollIntoView()
  return true
}

function moveCurrentBlock(props: CommandProps, direction: 'up' | 'down') {
  const currentBlock = getCurrentBlock(props.tr.selection)

  if (!currentBlock) {
    return false
  }

  const targetPosition = getMoveTargetPosition(currentBlock, direction)

  if (targetPosition === null) {
    return false
  }

  props.tr.delete(currentBlock.from, currentBlock.to)
  props.tr.insert(targetPosition, currentBlock.node)
  setSelectionNearMovedBlock(props, targetPosition)

  return true
}

function moveCurrentBlockTo(
  props: CommandProps,
  targetBlockId: string,
  placement: 'before' | 'after',
) {
  const currentBlock = getCurrentBlock(props.tr.selection)

  if (!currentBlock) {
    return false
  }

  const targetBlock = findBlockById(props.tr.doc, targetBlockId)

  if (!targetBlock || targetBlock.parent !== currentBlock.parent || targetBlock.from === currentBlock.from) {
    return false
  }

  const deletedSize = currentBlock.to - currentBlock.from
  let insertPosition = placement === 'before'
    ? targetBlock.from
    : targetBlock.to

  if (currentBlock.from < insertPosition) {
    insertPosition -= deletedSize
  }

  if (insertPosition === currentBlock.from) {
    return false
  }

  props.tr.delete(currentBlock.from, currentBlock.to)
  props.tr.insert(insertPosition, currentBlock.node)
  setSelectionNearMovedBlock(props, insertPosition)

  return true
}

function insertBlockAfterCurrent(props: CommandProps) {
  const currentBlock = getCurrentBlock(props.tr.selection)

  if (!currentBlock) {
    return false
  }

  const insertedBlock = createInsertedBlock(props.editor, currentBlock.node.type.name)

  if (!insertedBlock) {
    return false
  }

  props.tr.insert(currentBlock.to, insertedBlock)
  setSelectionNearMovedBlock(props, currentBlock.to)

  return true
}

function deleteCurrentBlock(props: CommandProps) {
  const currentBlock = getCurrentBlock(props.tr.selection)

  if (!currentBlock) {
    return false
  }

  props.tr.delete(currentBlock.from, currentBlock.to)
  props.tr.scrollIntoView()
  return true
}

function createInsertedBlock(editor: Editor, currentBlockType: string) {
  if (currentBlockType === 'listItem' || currentBlockType === 'taskItem') {
    return editor.schema.nodes[currentBlockType]?.createAndFill()
  }

  return editor.schema.nodes.paragraph?.createAndFill()
}

function getMoveTargetPosition(
  currentBlock: CurrentBlockSelection,
  direction: 'up' | 'down',
) {
  if (direction === 'up') {
    if (currentBlock.index <= 0) {
      return null
    }

    return currentBlock.from - currentBlock.parent.child(currentBlock.index - 1).nodeSize
  }

  if (currentBlock.index >= currentBlock.parent.childCount - 1) {
    return null
  }

  return currentBlock.from + currentBlock.parent.child(currentBlock.index + 1).nodeSize
}

function setSelectionNearMovedBlock(props: CommandProps, blockStartPosition: number) {
  const selection = Selection.findFrom(
    props.tr.doc.resolve(blockStartPosition + 1),
    1,
    true,
  )

  if (!selection) {
    return
  }

  props.tr.setSelection(selection)
  props.tr.scrollIntoView()
}

function canHandlePlainBlockBoundary(editor: Editor) {
  if (!editor.state.selection.empty) {
    return false
  }

  return !hasSplitMergeExcludedAncestor(editor)
}

function canMergeCurrentBlock(editor: Editor) {
  if (!canHandlePlainBlockBoundary(editor)) {
    return false
  }

  return editor.state.selection.$from.parentOffset === 0
}

function hasSplitMergeExcludedAncestor(editor: Editor) {
  const { $from } = editor.state.selection

  return Array.from({ length: $from.depth + 1 }, (_, depth) => $from.node(depth).type.name)
    .some(nodeName => SPLIT_MERGE_EXCLUDED_NODE_NAMES.has(nodeName))
}
