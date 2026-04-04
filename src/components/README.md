# Components

Reusable UI components live in `src/components/<component-name>/`.

## Folder Convention

- `types.ts` holds shared props/contracts for all surfaces.
- `view-model.ts` (optional) holds formatting and derived labels shared by all surfaces.
- `*.web.tsx` renders the web variant.
- `*.tui.tsx` renders the Ink/TUI variant.
- `*.stories.tsx` contains Storybook stories (web renderer).
- `index.ts` exports the component API.

This keeps behavior and data contracts shared, while render details remain surface-specific.
