/** Change notifications: feeds call bump(); index.ts subscribes with onChange to trigger a (debounced) tick. */
let cb: ((kind: string) => void) | null = null;
export const onChange = (f: (kind: string) => void) => { cb = f; };
export const bump = (kind: string) => { try { cb?.(kind); } catch {} };
