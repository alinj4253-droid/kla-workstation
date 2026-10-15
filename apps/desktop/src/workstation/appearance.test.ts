import { describe, expect, it } from 'vitest';
import { appearanceDefaults, applyAppearance, readAppearance, saveAppearance } from './appearance';

function storage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => { map.set(key, value); },
    dump: () => Object.fromEntries(map) as Record<string, string>,
  };
}

describe('外观偏好（本机）', () => {
  it('默认：浅色 / 标准密度 / 导航常驻 / 保留动效', () => {
    expect(readAppearance(storage())).toEqual(appearanceDefaults);
  });

  it('导航常驻只有显式存 false 才关闭', () => {
    expect(readAppearance(storage({ 'kla.appearance.persistentNav': 'true' })).persistentNav).toBe(true);
    expect(readAppearance(storage({ 'kla.appearance.persistentNav': 'false' })).persistentNav).toBe(false);
  });

  it('未知主题回落浅色，非 "true" 的布尔值不算开启', () => {
    expect(readAppearance(storage({ 'kla.appearance.theme': 'neon' })).theme).toBe('light');
    expect(readAppearance(storage({ 'kla.appearance.compact': 'yes' })).compact).toBe(false);
    expect(readAppearance(storage({ 'kla.appearance.reducedMotion': '1' })).reducedMotion).toBe(false);
  });

  it('落地到 html dataset，且四个键都写回存储（导航常驻不再丢失）', () => {
    const store = storage();
    const prefs = { theme: 'dark' as const, compact: true, persistentNav: false, reducedMotion: true };
    saveAppearance(prefs, store);
    const root = document.createElement('html');
    applyAppearance(prefs, root);
    expect(root.dataset.klaTheme).toBe('dark');
    expect(root.dataset.klaCompact).toBe('true');
    expect(root.dataset.klaPersistentNav).toBe('false');
    expect(root.dataset.klaReducedMotion).toBe('true');
    expect(store.dump()).toMatchObject({ 'kla.appearance.theme': 'dark', 'kla.appearance.compact': 'true', 'kla.appearance.persistentNav': 'false', 'kla.appearance.reducedMotion': 'true' });
  });

  it('应用后能原样读回', () => {
    const store = storage();
    saveAppearance({ theme: 'system', compact: false, persistentNav: true, reducedMotion: false }, store);
    expect(readAppearance(store)).toEqual({ theme: 'system', compact: false, persistentNav: true, reducedMotion: false });
  });
});
