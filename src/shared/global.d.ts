import type { WpmApi } from './ipc';

declare global {
  interface Window {
    api: WpmApi;
  }
}

export {};
