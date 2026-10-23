// Shared dashboard alert list (red banner messages). Keyed so a condition can be raised and cleared idempotently.
const alerts = new Map<string, string>();
export const setAlert = (key: string, msg: string) => { alerts.set(key, msg); };
export const clearAlert = (key: string) => { alerts.delete(key); };
export const getAlerts = (): string[] => [...alerts.values()];
export const resetAlerts = () => alerts.clear();
