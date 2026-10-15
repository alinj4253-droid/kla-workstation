/**
 * 外观偏好（本机生效）：主题 / 紧凑密度 / 左侧导航常驻 / 减少动效。
 *
 * 「设置 → 外观」的读写与落地只在这一个模块里，避免设置页与启动恢复各写一套：
 * 之前「左侧导航常驻」只写进了 localStorage，既没落到 DOM（`data-kla-persistent-nav`
 * 全项目零引用）也没在启动时恢复，开关点了等于没点。
 */
export type AppearanceTheme = 'light' | 'dark' | 'system';

export interface AppearancePreferences {
  theme: AppearanceTheme;
  compact: boolean;
  persistentNav: boolean;
  reducedMotion: boolean;
}

/** 默认值：浅色、标准密度、导航常驻（与交互演示版一致）、保留动效。 */
export const appearanceDefaults: AppearancePreferences = { theme: 'light', compact: false, persistentNav: true, reducedMotion: false };

export const appearanceKeys = {
  theme: 'kla.appearance.theme',
  compact: 'kla.appearance.compact',
  persistentNav: 'kla.appearance.persistentNav',
  reducedMotion: 'kla.appearance.reducedMotion',
} as const;

type Reader = Pick<Storage, 'getItem'>;
type Writer = Pick<Storage, 'setItem'>;

export function readAppearance(storage: Reader = localStorage): AppearancePreferences {
  const theme = storage.getItem(appearanceKeys.theme);
  return {
    theme: theme === 'dark' || theme === 'system' ? theme : 'light',
    compact: storage.getItem(appearanceKeys.compact) === 'true',
    // 只有显式存过 'false' 才关闭：未设置过时保持常驻。
    persistentNav: storage.getItem(appearanceKeys.persistentNav) !== 'false',
    reducedMotion: storage.getItem(appearanceKeys.reducedMotion) === 'true',
  };
}

/** 把偏好落到根节点 dataset；CSS 以 `html[data-kla-*]` 消费（窄屏收折、暗色、动效）。 */
export function applyAppearance(preferences: AppearancePreferences, root: HTMLElement = document.documentElement): void {
  root.dataset.klaTheme = preferences.theme;
  root.dataset.klaCompact = String(preferences.compact);
  root.dataset.klaPersistentNav = String(preferences.persistentNav);
  root.dataset.klaReducedMotion = String(preferences.reducedMotion);
}

export function saveAppearance(preferences: AppearancePreferences, storage: Writer = localStorage): void {
  storage.setItem(appearanceKeys.theme, preferences.theme);
  storage.setItem(appearanceKeys.compact, String(preferences.compact));
  storage.setItem(appearanceKeys.persistentNav, String(preferences.persistentNav));
  storage.setItem(appearanceKeys.reducedMotion, String(preferences.reducedMotion));
  applyAppearance(preferences);
}
