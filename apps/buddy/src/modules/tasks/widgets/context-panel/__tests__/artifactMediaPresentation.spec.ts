import { expect, it } from 'vitest'
import { artifactMediaKind, resolveArtifactDisplayMode } from '../artifactContextPresentation'

it.each([
  ['video.mp4', 'application/octet-stream', 'video'],
  ['audio.WAV', 'application/octet-stream', 'audio'],
  ['recording.WeBa', 'application/octet-stream', 'audio'],
  ['recording', 'audio/mpeg', 'audio'],
  ['report.pdf', 'application/pdf', null],
  ['note.constructor', 'application/octet-stream', null],
  ['note.__proto__', 'application/octet-stream', null],
] as const)('resolves current and previously registered media for %s', (name, mimeType, kind) => {
  const artifact = { kind: 'file' as const, name, mimeType }
  expect(artifactMediaKind(artifact)).toBe(kind)
  expect(resolveArtifactDisplayMode(artifact, 'source')).toBe(kind ? 'preview' : 'file')
})

it('does not treat a directory with a media suffix as playable', () => {
  const artifact = { kind: 'directory' as const, name: 'recordings.mp4', mimeType: 'inode/directory' }
  expect(artifactMediaKind(artifact)).toBeNull()
  expect(resolveArtifactDisplayMode(artifact, 'preview')).toBe('directory')
})
