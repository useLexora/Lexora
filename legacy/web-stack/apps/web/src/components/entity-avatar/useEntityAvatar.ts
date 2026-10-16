import type { EntityAvatarProps } from './typing'
import { computed, shallowRef, watch } from 'vue'
import { translate } from '@/i18n'

function resolveSize(value: number | string) {
  return typeof value === 'number'
    ? `${value}px`
    : value
}

function resolveFontSize(value: number | string) {
  if (typeof value === 'number') {
    return `${Math.max(11, Math.round(value * 0.42))}px`
  }

  return undefined
}

export function useEntityAvatar(props: Readonly<EntityAvatarProps>) {
  const imageLoadFailed = shallowRef(false)
  const avatarAlt = computed(() => props.alt?.trim() || translate('common.iconAlt', { name: props.name }))
  const avatarInitial = computed(() => props.name.trim().slice(0, 1).toUpperCase() || '?')
  const resolvedSrc = computed(() => {
    const src = props.src?.trim()

    if (!src || imageLoadFailed.value) {
      return null
    }

    return src
  })
  const avatarStyle = computed(() => {
    const size = resolveSize(props.size ?? 40)
    const fontSize = resolveFontSize(props.size ?? 40)

    return {
      width: size,
      height: size,
      fontSize,
    }
  })

  watch(() => props.src, () => {
    imageLoadFailed.value = false
  })

  function handleImageError() {
    imageLoadFailed.value = true
  }

  return {
    avatarAlt,
    avatarInitial,
    avatarStyle,
    handleImageError,
    resolvedSrc,
  }
}
