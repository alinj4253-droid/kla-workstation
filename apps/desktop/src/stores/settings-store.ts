import { create } from 'zustand';

type SettingsState = {
  activeTab: string;
  setActiveTab: (tab: string) => void;
};

export const useSettingsStore = create<SettingsState>((set) => ({
  activeTab: 'agents',
  setActiveTab: (tab) => set({ activeTab: tab }),
}));
