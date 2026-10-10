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
      knowledgeServiceUrl: string;
      agentRuntime: {
        connect(session: {accessToken:string;identityId:string}):Promise<{connected:boolean;deviceId:string|null;error:string|null}>;
        disconnect():Promise<void>;
        status():Promise<{connected:boolean;deviceId:string|null;error:string|null}>;
      };
    };
  }
}

export {};
