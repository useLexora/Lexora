import './tiptap.scss'

export type { TurnIntoBlockType } from './commands/turnInto'
export type {
  TiptapEditorBlockContextRequest,
  TiptapEditorCommentRequest,
  TiptapEditorContent,
  TiptapEditorSelectionContextRequest,
} from './core/typing'
export {
  DocumentBodyEditor,
  DocumentContentSurface,
  DocumentTitleEditor,
  StandaloneContentEditor,
} from './presets'
export type { DocumentBodyEditorOutlineOptions } from './presets/body/typing'
export type {
  DocumentContentSurfaceEmits,
  DocumentContentSurfaceProps,
} from './presets/document/typing'
