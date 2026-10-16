export function formatModelOptionLabel(providerName: string, modelName: string) {
  return `${providerName} / ${modelName}`
}

export function formatModelLimit(value: number | null | undefined) {
  return value == null ? '-' : value.toLocaleString('en-US')
}
