// Shared "a note failed to open" failure boundary: an `openLinkText` rejection must never fail
// silently (per the design spec's plan — "No silent catch"). Used by both the click-to-open path
// (`node-element.ts`'s `attachNodeInteractions`) and the context menu's Open/Open in new tab
// items (`actions-ui.ts`'s `StructureActions`).

import { Notice } from 'obsidian';
import { displayName, type Snapshot } from '../core/snapshot.js';

export function reportOpenFailure(snapshot: Snapshot, path: string, error: unknown): void {
  console.error('[bases-structure]', error);
  new Notice(`Structure: could not open "${displayName(snapshot, path)}"`);
}
