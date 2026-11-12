import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { useUiStore, LEGACY_UI_STORAGE_KEY } from '@/store/ui-store';

const backing = new Map<string, string>();
const storage = {
  getItem: (key: string) => backing.get(key) ?? null,
  setItem: (key: string, value: string) => void backing.set(key, value),
  removeItem: (key: string) => void backing.delete(key),
  clear: () => backing.clear(),
  key: (index: number) => Array.from(backing.keys())[index] ?? null,
  get length() {
    return backing.size;
  },
};

const windowStub = {
  localStorage: storage,
  matchMedia: () => ({ matches: false }),
};

describe('per-user UI preference isolation', () => {
  beforeAll(() => {
    vi.stubGlobal('window', windowStub);
  });

  beforeEach(() => {
    storage.clear();
    useUiStore.getState().hydrateForUser(null);
  });

  afterEach(() => {
    useUiStore.getState().hydrateForUser(null);
  });

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  it('keeps layout and formatter choices isolated across A -> logout -> B -> A', () => {
    useUiStore.getState().hydrateForUser('user-a');
    useUiStore.getState().setSidebarCollapsed(true);
    useUiStore.getState().setEditorPct(68);
    useUiStore.getState().setFormatOptions({ keywordCase: 'lower', indent: 'tab' });

    useUiStore.getState().hydrateForUser(null);
    expect(useUiStore.getState().ownerId).toBeNull();
    expect(useUiStore.getState().editorPct).toBe(42);
    expect(useUiStore.getState().formatKeywordCase).toBe('upper');

    useUiStore.getState().hydrateForUser('user-b');
    expect(useUiStore.getState().sidebarCollapsed).toBe(false);
    expect(useUiStore.getState().editorPct).toBe(42);
    expect(useUiStore.getState().formatKeywordCase).toBe('upper');
    useUiStore.getState().setEditorPct(31);
    useUiStore.getState().setFormatOptions({ keywordCase: 'preserve', indent: '4' });

    useUiStore.getState().hydrateForUser('user-a');
    expect(useUiStore.getState().sidebarCollapsed).toBe(true);
    expect(useUiStore.getState().editorPct).toBe(68);
    expect(useUiStore.getState().formatKeywordCase).toBe('lower');
    expect(useUiStore.getState().formatIndent).toBe('tab');

    useUiStore.getState().hydrateForUser('user-b');
    expect(useUiStore.getState().editorPct).toBe(31);
    expect(useUiStore.getState().formatKeywordCase).toBe('preserve');
    expect(useUiStore.getState().formatIndent).toBe('4');
  });

  it('removes the unowned legacy global preference key instead of adopting it', async () => {
    vi.resetModules();
    storage.setItem(
      LEGACY_UI_STORAGE_KEY,
      JSON.stringify({ editorPct: 77, formatKeywordCase: 'lower' }),
    );
    const { useUiStore: freshStore } = await import('@/store/ui-store');
    freshStore.getState().hydrateForUser('user-b');

    expect(storage.getItem(LEGACY_UI_STORAGE_KEY)).toBeNull();
    expect(freshStore.getState().editorPct).toBe(42);
    expect(freshStore.getState().formatKeywordCase).toBe('upper');
  });
});
