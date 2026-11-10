// @vitest-environment jsdom
import { selectionArtifact } from '@buddy-shared/artifacts/__tests__/artifactSelectionFixture'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { effectScope, shallowRef } from 'vue'
import { deferred } from '../../../../../../__tests__/deferred'
import { useArtifactPreview } from '../useArtifactPreview'

const scopes: ReturnType<typeof effectScope>[] = []
afterEach(() => {
  scopes.splice(0).forEach(scope => scope.stop())
  vi.unstubAllGlobals()
})

function openImage() {
  const artifact = shallowRef({ ...selectionArtifact, mimeType: 'image/png', name: 'picture.png' })
  const scope = effectScope()
  scopes.push(scope)
  const state = scope.run(() => useArtifactPreview({ artifact: () => artifact.value, readText: () => vi.fn() }))!
  function fail() {
    const image = document.createElement('img')
    image.src = state.previewUrl.value!
    return state.failImage({ target: image } as unknown as Event)
  }
  return { artifact, state, scope, fail }
}

describe('artifact preview failure lifecycle', () => {
  it('aborts old image diagnostics across resource switches, retry and disposal', async () => {
    const first = deferred<Response>()
    const second = deferred<Response>()
    const third = deferred<Response>()
    const fetch = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise).mockReturnValueOnce(third.promise)
    vi.stubGlobal('fetch', fetch)
    const f = openImage()
    const old = f.fail()
    f.artifact.value = { ...f.artifact.value, artifactId: 'other' }
    expect(fetch.mock.calls[0]![1].signal.aborted).toBe(true)
    first.resolve(new Response(null, { status: 404 }))
    await old
    expect(f.state.previewError.value).toBeNull()
    const retried = f.fail()
    f.state.refreshText()
    expect(fetch.mock.calls[1]![1].signal.aborted).toBe(true)
    second.resolve(new Response(null, { status: 403 }))
    await retried
    expect(f.state.previewError.value).toBeNull()
    const disposed = f.fail()
    const beforeDispose = f.state.previewError.value
    f.scope.stop()
    expect(fetch.mock.calls[2]![1].signal.aborted).toBe(true)
    third.resolve(new Response(null, { status: 413 }))
    await disposed
    expect(f.state.previewError.value).toBe(beforeDispose)
  })
})
