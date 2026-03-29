<script setup lang="ts">
import { ref } from "vue";
import { invoke } from "@tauri-apps/api/core";

const message = ref("还没有调用 Rust");
const loading = ref(false);
const error = ref("");

async function callRustHello() {
  loading.value = true;
  error.value = "";

  try {
    const result = await invoke<string>("hello_from_rust");
    message.value = result;
  } catch (err) {
    error.value = String(err);
  } finally {
    loading.value = false;
  }
}
</script>

<template>
  <main class="page">
    <h1>WaterfallViewer</h1>
    <p class="desc">第一步：先打通 Vue → Tauri → Rust</p>

    <button class="btn" @click="callRustHello" :disabled="loading">
      {{ loading ? "调用中..." : "调用 Rust" }}
    </button>

    <section class="panel">
      <h2>返回结果</h2>
      <p v-if="!error">{{ message }}</p>
      <p v-else class="error">{{ error }}</p>
    </section>
  </main>
</template>

<style scoped>
.page {
  min-height: 100vh;
  padding: 32px;
  box-sizing: border-box;
  font-family: Arial, Helvetica, sans-serif;
  background: #f7f7f8;
  color: #222;
}

h1 {
  margin: 0 0 8px;
  font-size: 32px;
}

.desc {
  margin: 0 0 20px;
  color: #666;
}

.btn {
  border: none;
  border-radius: 10px;
  padding: 12px 18px;
  font-size: 16px;
  cursor: pointer;
  background: #222;
  color: white;
}

.btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.panel {
  margin-top: 24px;
  padding: 16px;
  border-radius: 12px;
  background: white;
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.06);
}

.panel h2 {
  margin: 0 0 12px;
  font-size: 18px;
}

.error {
  color: #c62828;
}
</style>