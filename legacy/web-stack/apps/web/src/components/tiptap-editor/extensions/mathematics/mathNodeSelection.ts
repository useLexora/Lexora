import type { Editor } from '@tiptap/core'
import type { EditorState } from '@tiptap/pm/state'
import { NodeSelection } from '@tiptap/pm/state'

export const TIPTAP_MATH_PANEL_OPEN_META = 'tiptapMathPanelOpen'

export type MathNodeName = 'inlineMath' | 'blockMath'
export type MathNodeMode = 'inline' | 'block'

export interface SelectedMathNode {
  key: string
  latex: string
  mode: MathNodeMode
  nodeName: MathNodeName
  nodeSize: number
  pos: number
}

export function isMathNodeName(nodeName: string): nodeName is MathNodeName {
  return nodeName === 'inlineMath' || nodeName === 'blockMath'
}

export function getSelectedMathNode(state: EditorState): SelectedMathNode | null {
  const { selection } = state

  if (!(selection instanceof NodeSelection) || !isMathNodeName(selection.node.type.name)) {
    return null
  }

  return {
    key: `${selection.from}:${selection.node.type.name}`,
    latex: readMathLatex(selection.node.attrs.latex),
    mode: selection.node.type.name === 'blockMath' ? 'block' : 'inline',
    nodeName: selection.node.type.name,
    nodeSize: selection.node.nodeSize,
    pos: selection.from,
  }
}

export function isMathNodeSelection(state: EditorState) {
  return getSelectedMathNode(state) !== null
}

export function selectMathNode(editor: Editor, getPos: () => number | undefined) {
  const pos = getPos()

  if (typeof pos !== 'number') {
    return false
  }

  const transaction = editor.state.tr
    .setSelection(NodeSelection.create(editor.state.doc, pos))
    .setMeta(TIPTAP_MATH_PANEL_OPEN_META, true)
    .scrollIntoView()

  editor.view.dispatch(transaction)
  editor.view.focus()
  return true
}

function readMathLatex(value: unknown) {
  return typeof value === 'string' ? value : ''
}
