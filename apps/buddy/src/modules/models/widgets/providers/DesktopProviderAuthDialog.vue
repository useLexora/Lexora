<script setup lang="ts">
import type { LocalProviderAuthChallenge } from '@buddy-shared/providers/providerApi'

import type { BuddyLocale } from '@/i18n/buddyI18n'
import { NButton, NInput, NModal, NSelect } from 'naive-ui'
import { computed, shallowRef, watch } from 'vue'
import { useBuddyI18n } from '@/i18n/buddyI18n'

const props = defineProps<{
  challenge: LocalProviderAuthChallenge | null
  language: BuddyLocale
  providerName: string | null
}>()
const emit = defineEmits<{ cancel: [challengeId: string], submit: [challengeId: string, value: string] }>()
const { t } = useBuddyI18n(() => props.language)
const value = shallowRef('')
const isInputChallenge = computed(() => ['manual_code', 'secret', 'select', 'text']
  .includes(props.challenge?.type ?? ''))
const title = computed(() => props.challenge?.type === 'secret'
  ? t('desktop.providers.apiKeyAuthTitle')
  : t('desktop.providers.authTitle'))
const message = computed(() => props.challenge?.type === 'secret'
  ? t('desktop.providers.apiKeyAuthDescription')
  : props.challenge?.message)
const placeholder = computed(() => props.challenge?.type === 'secret'
  ? t('desktop.providers.apiKeyPlaceholder')
  : props.challenge?.placeholder)
const inputProps = computed(() => ({
  autocomplete: props.challenge?.type === 'secret' ? 'new-password' : 'off',
}))
const selectOptions = computed(() => props.challenge?.options?.map(option => ({
  label: option.label,
  value: option.id,
})) ?? [])

watch(() => props.challenge?.challengeId, () => value.value = '')

function cancel() {
  if (props.challenge)
    emit('cancel', props.challenge.challengeId)
}

function submit() {
  if (props.challenge && value.value)
    emit('submit', props.challenge.challengeId, value.value)
}
</script>

<template>
  <NModal v-if="challenge" :show="true" :mask-closable="false" @esc="cancel">
    <div class="desktop-provider-auth w-[min(30rem,_calc(100vw_-_2rem))] rounded-4 bg-raised text-fg p-[1.35rem] shadow-window" role="dialog" aria-modal="true">
      <form class="grid relative gap-[0.85rem]" @submit.prevent="submit">
        <input
          v-if="challenge.type === 'secret'"
          aria-hidden="true"
          autocomplete="username"
          class="absolute w-[1px] h-[1px] opacity-0 pointer-events-none"
          name="username"
          tabindex="-1"
          type="text"
          :value="challenge.providerId"
        >
        <span class="text-accent-text text-[0.68rem] font-700">{{ providerName ?? challenge.providerId }}</span>
        <h2>{{ title }}</h2>
        <p v-if="message">
          {{ message }}
        </p>
        <p v-if="challenge.instructions">
          {{ challenge.instructions }}
        </p>
        <a v-if="challenge.url" :href="challenge.url" target="_blank">{{ challenge.url }}</a>
        <dl v-if="challenge.userCode || challenge.verificationUri">
          <template v-if="challenge.userCode">
            <dt>{{ t('desktop.providers.userCode') }}</dt><dd>{{ challenge.userCode }}</dd>
          </template>
          <template v-if="challenge.verificationUri">
            <dt>{{ t('desktop.providers.verificationUrl') }}</dt><dd>{{ challenge.verificationUri }}</dd>
          </template>
        </dl>
        <NSelect
          v-if="challenge.type === 'select'"
          v-model:value="value"
          :options="selectOptions"
          :placeholder="placeholder"
        />
        <NInput
          v-else-if="isInputChallenge"
          v-model:value="value"
          :input-props="inputProps"
          :type="challenge.type === 'secret' ? 'password' : 'text'"
          :placeholder="placeholder"
        />
        <footer>
          <NButton attr-type="button" @click="cancel">
            {{ t('common.cancel') }}
          </NButton>
          <NButton
            v-if="isInputChallenge"
            attr-type="submit"
            type="primary"
            :disabled="!value"
          >
            {{ t('common.continue') }}
          </NButton>
        </footer>
      </form>
    </div>
  </NModal>
</template>

<style scoped lang="scss">
.desktop-provider-auth.fade-in-scale-up-transition-enter-active,
.desktop-provider-auth.fade-in-scale-up-transition-leave-active {
  transition: opacity 120ms ease-out !important;
}

.desktop-provider-auth.fade-in-scale-up-transition-enter-from,
.desktop-provider-auth.fade-in-scale-up-transition-enter-to,
.desktop-provider-auth.fade-in-scale-up-transition-leave-from,
.desktop-provider-auth.fade-in-scale-up-transition-leave-to {
  transform: none !important;
}

.desktop-provider-auth h2,
.desktop-provider-auth p { margin: 0; }

.desktop-provider-auth p { color: var(--buddy-text-secondary); line-height: 1.6; }
.desktop-provider-auth a { overflow-wrap: anywhere; color: var(--buddy-accent-text); }
.desktop-provider-auth dl { display: grid; grid-template-columns: max-content 1fr; gap: 0.3rem 0.7rem; margin: 0; }
.desktop-provider-auth dd { margin: 0; font-family: var(--buddy-font-mono); }
.desktop-provider-auth footer { display: flex; justify-content: flex-end; gap: 0.6rem; }
</style>
