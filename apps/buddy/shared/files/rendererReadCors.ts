// File previews stay on the authorized media protocol. Canvas can read them only when the
// response explicitly allows the app renderer; other origins do not gain access.
export function applyRendererReadCors(response: Response, origin: string | null, rendererOrigin: string): Response {
  if (origin && origin === rendererOrigin) {
    response.headers.set('access-control-allow-origin', rendererOrigin)
    response.headers.set('access-control-expose-headers', 'x-lexora-error-code')
    response.headers.set('vary', 'Origin')
  }
  return response
}
