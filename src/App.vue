<script setup lang="ts">
import type { MediaBrowserController } from "./application/browser/mediaBrowserController";
import BrowserPage from "./presentation/pages/BrowserPage.vue";

defineProps<{
  browser: MediaBrowserController;
}>();
</script>

<template>
  <BrowserPage :browser="browser" />
</template>
