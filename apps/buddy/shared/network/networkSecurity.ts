export function isHttpEndpointUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return ['http:', 'https:'].includes(url.protocol)
      && Boolean(url.hostname)
      && !url.username
      && !url.password
  }
  catch {
    return false
  }
}

export function isPlainHttpEndpointUrl(value: string): boolean {
  if (!isHttpEndpointUrl(value))
    return false
  return new URL(value).protocol === 'http:'
}
