/** Supplied by A. No credential, service configuration or generic HTTP capability crosses IPC. */
export interface KnowledgeTransportRequest {
  method: 'GET' | 'POST'; path: string;
  query?: { para: number; limit: number }; body?: unknown;
}
export type KnowledgeTransport = (request: KnowledgeTransportRequest) => Promise<unknown>;
export type KnowledgeFailureKind = 'unconfigured' | 'validation' | 'unauthorized' | 'forbidden' | 'not_found' | 'slices_pending' | 'network' | 'timeout' | 'protocol' | 'server' | 'cancelled';
export class KnowledgeBFailure extends Error {
  constructor(public readonly kind: KnowledgeFailureKind) { super(kind); }
}
