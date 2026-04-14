/**
 * Canonical design-system vocabulary shared across every component.
 *
 * `Tone` is a superset — individual components declare narrower subsets via
 * `Exclude<Tone, …>` so the shared vocabulary stays aligned without forcing
 * every primitive to accept every tone.
 */
export type Tone =
  | 'neutral'
  | 'primary'
  | 'secondary'
  | 'accent'
  | 'info'
  | 'success'
  | 'warning'
  | 'error'
  | 'ghost'

export type Size = 'xs' | 'sm' | 'md' | 'lg'
