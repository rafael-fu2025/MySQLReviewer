export type WorkspaceAction =
  'new-tab' | 'run' | 'run-selection' | 'explain' | 'review' | 'format' | 'history' | 'snippets';

const EVENT_NAME = 'mylens:workspace';

export function emitWorkspace(action: WorkspaceAction, payload?: unknown): void {
  window.dispatchEvent(new CustomEvent(EVENT_NAME, { detail: { action, payload } }));
}

export function onWorkspace(
  handler: (action: WorkspaceAction, payload?: unknown) => void,
): () => void {
  const listener = (event: Event): void => {
    const detail = (event as CustomEvent<{ action: WorkspaceAction; payload?: unknown }>).detail;
    if (!detail) return;
    handler(detail.action, detail.payload);
  };
  window.addEventListener(EVENT_NAME, listener);
  return () => window.removeEventListener(EVENT_NAME, listener);
}
