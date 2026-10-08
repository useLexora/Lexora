import type { BuddyArtifactQuote } from '../../conversation/buddyUserContent'
import type { LocalArtifact } from '../artifactApi'

export const selectionArtifact: LocalArtifact = {
  artifactId: 'artifact-a',
  conversationId: 'a',
  runId: 'run-a',
  sourceToolCallId: 'tool-a',
  sourceArtifactId: null,
  name: 'report.md',
  path: 'C:\\fixtures\\report.md',
  kind: 'file',
  mimeType: 'text/markdown',
  sizeBytes: 100,
  previewUrl: null,
  createdAt: '2026-10-03T00:00:00.000Z',
  updatedAt: '2026-10-03T00:00:00.000Z',
}
export const artifactQuote: BuddyArtifactQuote = {
  id: 'artifact-quote',
  text: 'Frozen artifact excerpt.',
  textOffset: 0,
  source: {
    kind: 'artifact',
    title: selectionArtifact.name,
    artifactId: selectionArtifact.artifactId,
    conversationId: selectionArtifact.conversationId,
    runId: selectionArtifact.runId,
    path: selectionArtifact.path,
    updatedAt: selectionArtifact.updatedAt,
    format: 'markdown',
  },
}
