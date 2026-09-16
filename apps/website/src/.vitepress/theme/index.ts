import type { Theme } from 'vitepress'
import DefaultTheme from 'vitepress/theme-without-fonts'
import SiteLayout from './SiteLayout.vue'
// eslint-disable-next-line ts/ban-ts-comment
// @ts-ignore
import './style.css'

export default {
  extends: DefaultTheme,
  Layout: SiteLayout,
} satisfies Theme
