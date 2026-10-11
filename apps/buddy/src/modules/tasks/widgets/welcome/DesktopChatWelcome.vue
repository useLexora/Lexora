<script setup lang="ts">
import type { BuddyLocale } from '@/i18n/buddyI18n'
import type { DesktopChatWelcomeVariant } from '@/shared/branding/welcome/desktopChatWelcomeVariants'
import { computed, shallowRef } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'
import { useDesktopTheme } from '@/theme/useDesktopTheme'
import DesktopChatWelcomeDecoration from './DesktopChatWelcomeDecoration.vue'

const props = defineProps<{
  language: BuddyLocale
  variant: DesktopChatWelcomeVariant | null
}>()

const { t } = useBuddyI18n(() => props.language)
const { resolved } = useDesktopTheme()
const failedImage = shallowRef<string | null>(null)
const welcome = computed(() => resolved.value.document.welcome)
const custom = computed(() => welcome.value !== undefined)
const heading = computed(() => custom.value
  ? welcome.value?.text?.[props.language] ?? ''
  : props.variant ? t(props.variant.titleKey) : '')
const illustration = computed(() => {
  const image = welcome.value?.image
  const url = custom.value
    ? image ? resolved.value.assets[image] : null
    : props.variant?.illustrationUrl
  return url && url !== failedImage.value ? url : null
})
</script>

<template>
  <section v-if="heading || illustration" class="desktop-chat-welcome grid w-[min(calc(100%_-_2.5rem),_44rem)] gap-[0.55rem] my-0 mx-auto text-center" :data-variant="custom ? 'theme' : variant?.id">
    <img
      v-if="illustration"
      class="desktop-chat-welcome__illustration w-[clamp(5rem,_min(26cqh,_54cqw),_16rem)] max-w-full mb-[var(--desktop-chat-welcome-illustration-offset-bottom)] select-none"
      :src="illustration"
      alt=""
      draggable="false"
      @error="failedImage = illustration"
    >
    <div
      v-if="heading"
      class="desktop-chat-welcome__heading relative max-w-[calc(100%_-_2.5rem)]"
      :data-decoration="custom ? undefined : variant?.decoration"
    >
      <h1>{{ heading }}</h1>
      <DesktopChatWelcomeDecoration v-if="!custom && variant" :type="variant.decoration" />
    </div>
  </section>
</template>

<style scoped lang="scss">
.desktop-chat-welcome {
  --desktop-chat-welcome-illustration-offset-x: 0%;
  --desktop-chat-welcome-illustration-offset-bottom: 0rem;
  justify-items: center;
}

.desktop-chat-welcome[data-variant='orchestrating'] {
  --desktop-chat-welcome-illustration-offset-x: -3.7%;
  --desktop-chat-welcome-illustration-offset-bottom: -1.4rem;
}

.desktop-chat-welcome[data-variant='planning'] {
  --desktop-chat-welcome-illustration-offset-x: 1%;
  --desktop-chat-welcome-illustration-offset-bottom: -2.2rem;
}

.desktop-chat-welcome[data-variant='writing'] {
  --desktop-chat-welcome-illustration-offset-x: -2.3%;
  --desktop-chat-welcome-illustration-offset-bottom: -1rem;
}

.desktop-chat-welcome__illustration {
  aspect-ratio: 1;
  object-fit: contain;
  transform: translateX(var(--desktop-chat-welcome-illustration-offset-x));
}

.desktop-chat-welcome__heading {
  display: inline-grid;
  justify-items: center;

  h1 {
    margin: 0;
    color: var(--buddy-text-strong);
    font-family: "Noto Serif CJK SC", "Source Han Serif SC", "Songti SC", STSong, SimSun, serif;
    font-size: clamp(1.15rem, 4cqw, 2.15rem);
    font-weight: 600;
    letter-spacing: 0.01em;
    line-height: 1.3;
    text-rendering: optimizelegibility;
  }
}

@container task-pane (max-height: 620px) {
  .desktop-chat-welcome {
    gap: 0.35rem;
  }

  .desktop-chat-welcome[data-variant='orchestrating'] {
    --desktop-chat-welcome-illustration-offset-bottom: -1rem;
  }

  .desktop-chat-welcome[data-variant='planning'] {
    --desktop-chat-welcome-illustration-offset-bottom: -1.6rem;
  }

  .desktop-chat-welcome[data-variant='writing'] {
    --desktop-chat-welcome-illustration-offset-bottom: -0.75rem;
  }

  .desktop-chat-welcome__illustration {
    width: min(13rem, 60cqh);
  }

  .desktop-chat-welcome__heading h1 {
    font-size: clamp(1.15rem, 4cqw, 1.6rem);
  }
}

@container welcome-region (max-height: 120px) {
  .desktop-chat-welcome__illustration {
    display: none;
  }
}

@container welcome-region (max-height: 64px) {
  .desktop-chat-welcome {
    display: none;
  }
}
</style>
