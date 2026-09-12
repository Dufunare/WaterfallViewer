# WaterfallViewer

WaterfallViewer is a local-first, session-oriented multimedia browser for recursively exploring media stored across directory trees. The project targets a high-performance traditional waterfall/justified flow and a future free-form infinite canvas while keeping media functionality independent from visual presentation.

## Architecture

The current architecture baseline is documented in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

The Rust foundation is intentionally split from Tauri:

- `crates/waterfall-core`: domain models, scan contracts, ports, and application-level types. It must not depend on Tauri.
- `crates/waterfall-infra`: concrete infrastructure adapters such as local filesystem discovery.
- `src-tauri`: desktop/mobile application shell and future IPC adapter.
- `src`: Vue presentation, frontend application state, layout/view core, renderers, themes, and effects.

## Development

Frontend:

```bash
pnpm install
pnpm build
pnpm tauri dev
```

Rust core/infrastructure:

```bash
cargo test --manifest-path crates/Cargo.toml --workspace
cargo clippy --manifest-path crates/Cargo.toml --workspace --all-targets -- -D warnings
```

Tauri shell:

```bash
cargo check --manifest-path src-tauri/Cargo.toml --locked
```

## Current phase

The repository is in **Core Foundation**. The first implementation establishes independent Rust contracts, a recursive local filesystem scanner with batch/cancellation semantics, and CI. Tauri IPC, metadata header parsing, thumbnails, frontend session orchestration, virtualization, and the free canvas are deliberately kept out of this first foundation step.
