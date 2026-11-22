import { describe, expect, it } from 'vitest'
import { applyRendererReadCors } from '../rendererReadCors'

describe('renderer read CORS', () => {
  it('allows only the app renderer origin to read a file preview response', () => {
    const response = new Response('image', { headers: { 'content-type': 'image/png' } })
    applyRendererReadCors(response, 'lexora-app://renderer', 'lexora-app://renderer')
    expect(response.headers.get('access-control-allow-origin')).toBe('lexora-app://renderer')
    expect(response.headers.get('vary')).toBe('Origin')
  })

  it('does not grant another origin access to the same authorized response', () => {
    const response = new Response('image')
    applyRendererReadCors(response, 'https://example.test', 'lexora-app://renderer')
    applyRendererReadCors(response, null, 'lexora-app://renderer')
    expect(response.headers.get('access-control-allow-origin')).toBeNull()
  })
})
