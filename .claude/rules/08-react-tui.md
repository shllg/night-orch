# React TUI Rules

These rules apply to React-based terminal UI code.

## MUST

- Keep container/controller logic separate from view components.
- Scope keybindings by active view or mode to prevent global shortcuts from leaking into nested screens.
- Keep render functions pure and side-effect free; run polling, I/O, and timers in effects/hooks.
- Use stable keys for dynamic lists (`id` over array index) unless the list is static.
- Cap in-memory buffers (logs, events, history) to bounded sizes to prevent unbounded growth.
- Reset or clamp view-local cursor/scroll state when source data changes.
- Prefer derived data with `useMemo` for expensive DB-backed calculations during refresh loops.
- Keep keyboard hint text in sync with actual keybindings.
- Place reusable component families in `src/components/<component-name>/` with shared contracts in `types.ts`.
- Keep cross-surface API parity by implementing sibling `*.tui.tsx` and `*.web.tsx` files that consume the same shared props.

## NEVER

- Put all TUI state, views, and formatting helpers in one giant component file.
- Bind `q`/`esc` globally when a focused modal/detail view needs close behavior first.
- Trigger async work directly during render.
- Depend on implicit shared mutable module state for UI interaction flow.
- Split the same conceptual component into unrelated prop contracts between web and TUI implementations.
