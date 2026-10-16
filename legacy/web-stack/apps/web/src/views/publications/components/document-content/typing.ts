import type { PublicationRenderedDocument, TiptapJsonContent } from '@haohaoxue/lexora-contracts'
import type { DocumentBodyEditorOutlineOptions } from '@/components/tiptap-editor'

export interface PublicationDocumentContentProps {
  body: TiptapJsonContent
  document: PublicationRenderedDocument
  layout: 'plain' | 'site'
  outlineOptions?: DocumentBodyEditorOutlineOptions
  showHeader?: boolean
  showMeta?: boolean
  showOutline?: boolean
}
