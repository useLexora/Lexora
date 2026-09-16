<script setup lang="ts">
import { useData } from 'vitepress'
import DefaultTheme from 'vitepress/theme-without-fonts'
import LandingPage from './components/landing/LandingPage.vue'

const { frontmatter } = useData()
const DocLayout = DefaultTheme.Layout
</script>

<template>
  <LandingPage v-if="frontmatter.layout === 'landing'" />
  <DocLayout v-else />
</template>
