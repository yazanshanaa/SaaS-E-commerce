/**
 * `src/shared/site-contract` — the shape A1, A2 and B2 all agree on, consumed from three
 * parallel worktrees. Nothing here may import from `src/templates` or `src/app`: this is the
 * bottom of the dependency graph, not a convenience barrel.
 */
export * from './templates';
export * from './sections';
export * from './colors';
export * from './contrast';
