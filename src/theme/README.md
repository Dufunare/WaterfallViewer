# Theme boundary

`base.css` owns the visual values that should vary coherently when WaterfallViewer gains additional themes. Presentation components consume these values through semantic CSS custom properties instead of embedding their own color/effect constants.

## Token groups

- **Core palette** — application background, surfaces, borders, text, accent.
- **Semantic state** — status and error/danger colors.
- **Overlay/effects** — modal backdrops, floating surfaces, HUD surfaces, shadows and blur strengths.

Tokens describe visual meaning rather than a specific component. Prefer `--wf-danger-surface` over `--wf-canvas-error-background`, for example, so the same state can be rendered consistently in another view.

Layout remains local to components. Widths, spacing, media-query breakpoints and view-specific geometry should not be moved into global theme variables merely to remove numeric literals.

This boundary is intentionally smaller than a full design system. Runtime theme packs can override these semantic variables later without changing Flow, Canvas or Preview behavior.
