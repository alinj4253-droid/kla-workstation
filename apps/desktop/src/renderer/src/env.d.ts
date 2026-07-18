/// <reference types="vite/client" />

import type { KunqingDesktopApi } from '../../preload';

declare global {
  interface Window {
    kunqing?: KunqingDesktopApi;
  }
}

export {};
