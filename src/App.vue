<script setup lang="ts">
import type { MasonryBrowserController } from "./application/browser/masonryBrowserController";
import BrowserPage from "./presentation/pages/BrowserPage.vue";

defineProps<{
  browser: MasonryBrowserController;
}>();
</script>

<template>
  <BrowserPage :browser="browser" />
</template>
