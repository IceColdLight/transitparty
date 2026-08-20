/**
 * Keyboard. Four directions and one verb, which is the whole control scheme —
 * everything difficult about this game is meant to be the decision, not the
 * hands.
 */
export const keys = new Set<string>();

/** Edge-triggered actions, drained once per frame so a held key fires once. */
const pending = new Set<string>();

const typing = () => document.activeElement?.tagName === 'INPUT';

window.addEventListener('keydown', (e) => {
  if (typing()) {
    if (e.key === 'Enter' || e.key === 'Escape') (document.activeElement as HTMLElement).blur();
    return;
  }
  const k = e.key.toLowerCase();
  if (k === 'tab') e.preventDefault();
  if (!keys.has(k)) {
    if (k === 'e' || k === ' ') pending.add('interact');
    if (k === 'r') pending.add('reset');
  }
  keys.add(k);
});
window.addEventListener('keyup', (e) => keys.delete(e.key.toLowerCase()));
window.addEventListener('blur', () => keys.clear());

const held = (...names: string[]) => names.some((n) => keys.has(n));

/** World-space wish direction. +y is south, matching the city's coordinates. */
export function readWalkWish(): { x: number; y: number } {
  let x = 0, y = 0;
  if (held('a', 'arrowleft')) x -= 1;
  if (held('d', 'arrowright')) x += 1;
  if (held('w', 'arrowup')) y -= 1;
  if (held('s', 'arrowdown')) y += 1;
  const len = Math.hypot(x, y);
  return len > 0 ? { x: x / len, y: y / len } : { x: 0, y: 0 };
}

/** Legging it. Held, and it runs out — see STAMINA. */
export function sprintHeld(): boolean {
  return held('shift', 'shiftleft', 'shiftright');
}

/** The map is HELD, not toggled: it should cost you the walk you are not doing. */
export function mapHeld(): boolean { return keys.has('tab'); }

export function take(action: string): boolean {
  if (!pending.has(action)) return false;
  pending.delete(action);
  return true;
}
