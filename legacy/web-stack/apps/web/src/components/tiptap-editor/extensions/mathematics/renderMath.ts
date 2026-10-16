import katex from 'katex'

export function renderKatex(
  target: HTMLElement | null,
  latex: string,
  options: {
    displayMode: boolean
  },
) {
  if (!target) {
    return true
  }

  target.textContent = ''

  if (!latex.trim()) {
    return true
  }

  try {
    katex.render(latex, target, {
      displayMode: options.displayMode,
      throwOnError: true,
    })

    return true
  }
  catch {
    target.textContent = latex
    return false
  }
}
