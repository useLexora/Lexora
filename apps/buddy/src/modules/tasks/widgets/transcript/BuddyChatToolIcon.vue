<script setup lang="ts">
import type { Component } from 'vue'
import type { ChatToolIcon } from '../../model/transcript/chatToolRegistry'
import type { DesktopIconName } from '@/shared/ui/icon/desktopIcons'
import { AnimalCat20Regular, Box20Regular, CalendarClock20Regular, Camera20Regular, Cursor20Regular, DocumentText20Regular, Folder20Regular, Globe20Regular, Image20Regular, ImageEdit20Regular, PlugConnected20Regular, ShieldKeyhole20Regular, Stack20Regular, Window20Regular, WindowConsole20Regular, Wrench20Regular } from '@vicons/fluent'
import DesktopIcon from '@/shared/ui/icon/DesktopIcon.vue'
import SkillIcon from '@/shared/ui/icon/SkillIcon.vue'

defineProps<{ icon: ChatToolIcon }>()
const icons = {
  'activity': { component: Stack20Regular },
  'artifact': { component: Box20Regular },
  'authorization': { component: ShieldKeyhole20Regular },
  'automation': { component: CalendarClock20Regular },
  'browser': { component: Globe20Regular },
  'browser-act': { component: Cursor20Regular },
  'browser-open': { component: Window20Regular },
  'browser-snapshot': { component: Camera20Regular },
  'connector': { component: PlugConnected20Regular },
  'create': { name: 'toolCreateFile' },
  'directory': { component: Folder20Regular },
  'edit': { name: 'toolEditFile' },
  'file': { component: DocumentText20Regular },
  'image': { component: Image20Regular },
  'image-edit': { component: ImageEdit20Regular },
  'pet': { component: AnimalCat20Regular },
  'search': { name: 'toolSearch' },
  'skill': { component: SkillIcon },
  'system': { component: Wrench20Regular },
  'terminal': { component: WindowConsole20Regular },
  'tool': { name: 'toolUse' },
} satisfies Record<ChatToolIcon, { name: DesktopIconName } | { component: Component }>
</script>

<template>
  <DesktopIcon v-bind="icons[icon]" />
</template>
