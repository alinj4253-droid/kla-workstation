/// <reference types="vite/client" />

declare global {
  interface Window {
    /**
     * Legacy desktop bridge retained while renderer calls are migrated to the
     * HTTP/SSE client adapter. The independent web build does not implement it.
     */
    kunqing?: Record<string, any>;
    klaPlatform?: {
      runtime: 'electron';
      apiBaseUrl: string;
    };
  }
}

export {};
