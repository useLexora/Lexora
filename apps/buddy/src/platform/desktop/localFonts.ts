type LocalFontWindow = typeof window & {
  queryLocalFonts: () => Promise<ReadonlyArray<{ family: string }>>
}

export async function listLocalFontFamilies(): Promise<string[]> {
  const fonts = await (window as LocalFontWindow).queryLocalFonts()
  return [...new Set(fonts.map(font => font.family))].sort((left, right) => left.localeCompare(right))
}
