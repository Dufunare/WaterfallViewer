<template>
  <main class="app-shell">
    <section class="foundation-card" aria-labelledby="app-title">
      <p class="eyebrow">WaterfallViewer</p>
      <h1 id="app-title">Core foundation initialized</h1>
      <p class="description">
        The application shell is ready. Media scanning and view integration will be connected through
        explicit ports instead of template-only Tauri commands.
      </p>
    </section>
  </main>
</template>

<style>
:root {
  font-family:
    Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  color: #f5f5f5;
  background: #111;
  font-synthesis: none;
  text-rendering: optimizeLegibility;
  -webkit-font-smoothing: antialiased;
}

* {
  box-sizing: border-box;
}

body {
  margin: 0;
  min-width: 320px;
  min-height: 100vh;
}

button,
input,
select,
textarea {
  font: inherit;
}

.app-shell {
  min-height: 100vh;
  display: grid;
  place-items: center;
  padding: 32px;
}

.foundation-card {
  width: min(640px, 100%);
  padding: 32px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 20px;
  background: rgba(255, 255, 255, 0.04);
}

.eyebrow {
  margin: 0 0 8px;
  font-size: 0.8rem;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  opacity: 0.65;
}

h1 {
  margin: 0;
  font-size: clamp(2rem, 6vw, 3.5rem);
  line-height: 1;
}

.description {
  margin: 20px 0 0;
  line-height: 1.6;
  opacity: 0.72;
}
</style>
