import { createContext, useContext } from 'react';
import type { RpcClient } from '@/web-agent';

export interface WebAgentContextValue {
  rpcClient: RpcClient;
  vfsPort: MessagePort | null;
  hasWorker: boolean;
}

export const WebAgentContext = createContext<WebAgentContextValue | null>(null);

export function useWebAgent(): WebAgentContextValue {
  const ctx = useContext(WebAgentContext);
  if (!ctx) throw new Error('useWebAgent must be used within <WebAgentProvider>');
  return ctx;
}
