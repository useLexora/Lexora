import type { MaybeRefOrGetter } from 'vue'
import { useResizeObserver } from '@vueuse/core'
import { computed, nextTick, onBeforeUnmount, shallowRef, toValue, watch } from 'vue'

export interface CodeBlockLineNumberRow {
  number: number
  style?: {
    height: string
  }
}

interface UseCodeBlockLineNumbersOptions {
  bodyRef: MaybeRefOrGetter<HTMLElement | null | undefined>
  codeText: MaybeRefOrGetter<string>
  isCollapsed: MaybeRefOrGetter<boolean>
  showLineNumbers: MaybeRefOrGetter<boolean>
  tabSize: MaybeRefOrGetter<number>
  wrapLines: MaybeRefOrGetter<boolean>
}

export function useCodeBlockLineNumbers(options: UseCodeBlockLineNumbersOptions) {
  const measuredLineHeights = shallowRef<number[]>([])
  const codeLines = computed(() => toValue(options.codeText).split('\n'))
  const lineNumberRows = computed<CodeBlockLineNumberRow[]>(() => {
    return codeLines.value.map((_, index) => {
      const height = toValue(options.wrapLines) ? measuredLineHeights.value[index] : undefined

      return {
        number: index + 1,
        style: height ? { height: `${height}px` } : undefined,
      }
    })
  })

  let lineNumberMeasureFrame: number | null = null

  watch(
    () => [
      toValue(options.codeText),
      toValue(options.wrapLines),
      toValue(options.tabSize),
      toValue(options.isCollapsed),
      toValue(options.showLineNumbers),
    ],
    () => {
      scheduleLineNumberMeasure()
    },
    {
      flush: 'post',
      immediate: true,
    },
  )

  useResizeObserver(options.bodyRef, () => {
    scheduleLineNumberMeasure()
  })

  onBeforeUnmount(() => {
    if (lineNumberMeasureFrame === null) {
      return
    }

    cancelAnimationFrame(lineNumberMeasureFrame)
  })

  async function measureWrappedLineHeights() {
    await nextTick()

    if (!shouldMeasureLineHeights()) {
      measuredLineHeights.value = []
      return
    }

    const codeElement = toValue(options.bodyRef)?.querySelector<HTMLElement>('.tiptap-code-block__code')

    if (!codeElement || codeElement.clientWidth <= 0) {
      measuredLineHeights.value = []
      return
    }

    measuredLineHeights.value = measureCodeLineHeights(codeElement, codeLines.value)
  }

  function scheduleLineNumberMeasure() {
    if (!shouldMeasureLineHeights()) {
      measuredLineHeights.value = []
      return
    }

    if (typeof requestAnimationFrame === 'undefined') {
      void measureWrappedLineHeights()
      return
    }

    if (lineNumberMeasureFrame !== null) {
      cancelAnimationFrame(lineNumberMeasureFrame)
    }

    lineNumberMeasureFrame = requestAnimationFrame(() => {
      lineNumberMeasureFrame = null
      void measureWrappedLineHeights()
    })
  }

  function shouldMeasureLineHeights() {
    return toValue(options.wrapLines)
      && !toValue(options.isCollapsed)
      && toValue(options.showLineNumbers)
  }

  return {
    lineNumberRows,
  }
}

function measureCodeLineHeights(codeElement: HTMLElement, lines: string[]) {
  const computedStyle = window.getComputedStyle(codeElement)
  const measuringElement = document.createElement('div')

  measuringElement.style.position = 'absolute'
  measuringElement.style.visibility = 'hidden'
  measuringElement.style.pointerEvents = 'none'
  measuringElement.style.boxSizing = 'border-box'
  measuringElement.style.width = `${codeElement.clientWidth}px`
  measuringElement.style.minWidth = '0'
  measuringElement.style.maxWidth = `${codeElement.clientWidth}px`
  measuringElement.style.margin = '0'
  measuringElement.style.padding = '0'
  measuringElement.style.border = '0'
  measuringElement.style.whiteSpace = 'pre-wrap'
  measuringElement.style.overflowWrap = 'anywhere'
  measuringElement.style.fontFamily = computedStyle.fontFamily
  measuringElement.style.fontSize = computedStyle.fontSize
  measuringElement.style.fontWeight = computedStyle.fontWeight
  measuringElement.style.fontStyle = computedStyle.fontStyle
  measuringElement.style.fontVariantLigatures = computedStyle.fontVariantLigatures
  measuringElement.style.fontFeatureSettings = computedStyle.fontFeatureSettings
  measuringElement.style.lineHeight = computedStyle.lineHeight
  measuringElement.style.letterSpacing = computedStyle.letterSpacing
  measuringElement.style.setProperty('tab-size', computedStyle.getPropertyValue('tab-size'))

  document.body.append(measuringElement)

  const fallbackLineHeight = resolvePixelLineHeight(computedStyle)
  const heights = lines.map((line) => {
    measuringElement.textContent = line || ' '

    return measuringElement.getBoundingClientRect().height || fallbackLineHeight
  })

  measuringElement.remove()

  return heights
}

function resolvePixelLineHeight(computedStyle: CSSStyleDeclaration) {
  const lineHeight = Number.parseFloat(computedStyle.lineHeight)

  if (Number.isFinite(lineHeight)) {
    return lineHeight
  }

  const fontSize = Number.parseFloat(computedStyle.fontSize)

  return Number.isFinite(fontSize) ? fontSize * 1.65 : 23
}
