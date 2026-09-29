import { create } from 'zustand';

type Message = {
  id: string;
  senderType: 'user' | 'agent' | 'system';
  senderId: string;
  kind: 'text' | 'artifact' | 'system';
  contentJson: string;
  createdAt: string;
};

type ChatState = {
  messages: Record<string, Message[]>;
  setMessages: (projectId: string, messages: Message[]) => void;
  addMessage: (projectId: string, message: Message) => void;
  clearProject: (projectId: string) => void;
};

export const useChatStore = create<ChatState>((set) => ({
  messages: {},
  setMessages: (projectId, messages) =>
    set((state) => ({ messages: { ...state.messages, [projectId]: messages } })),
  addMessage: (projectId, message) =>
    set((state) => ({
      messages: {
        ...state.messages,
        [projectId]: [...(state.messages[projectId] ?? []), message],
      },
    })),
  clearProject: (projectId) =>
    set((state) => {
      const next = { ...state.messages };
      delete next[projectId];
      return { messages: next };
    }),
}));
