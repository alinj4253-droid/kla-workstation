import { create } from 'zustand';

export type ProjectSummary = {
  id: string;
  name: string;
  status: string;
  summary?: string;
  lastActiveAt: string;
  createdAt: string;
};

type ProjectState = {
  projects: ProjectSummary[];
  activeProjectId: string | null;
  loading: boolean;
  setProjects: (projects: ProjectSummary[]) => void;
  setActiveProject: (id: string | null) => void;
  setLoading: (loading: boolean) => void;
};

export const useProjectStore = create<ProjectState>((set) => ({
  projects: [],
  activeProjectId: null,
  loading: false,
  setProjects: (projects) => set({ projects }),
  setActiveProject: (id) => set({ activeProjectId: id }),
  setLoading: (loading) => set({ loading }),
}));
