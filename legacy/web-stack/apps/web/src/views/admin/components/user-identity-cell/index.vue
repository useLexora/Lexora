<script setup lang="ts">
import type { UserIdentityCellProps } from './typing'
import { useI18n } from 'vue-i18n'
import EntityAvatar from '@/components/entity-avatar'

defineProps<UserIdentityCellProps>()
const { t } = useI18n({ useScope: 'global' })
</script>

<template>
  <div class="flex min-w-0 items-center gap-3">
    <EntityAvatar
      :name="user.displayName"
      :src="user.avatarUrl"
      :alt="t('common.avatarAlt', { name: user.displayName })"
      :size="40"
      shape="circle"
      kind="user"
      class="shrink-0"
    />

    <span class="min-w-0 truncate text-sm font-semibold text-main" :title="user.displayName">
      {{ user.displayName }}
    </span>
  </div>
</template>
