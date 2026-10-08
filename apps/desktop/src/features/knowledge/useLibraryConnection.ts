import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { KnowledgeConnection } from '@kla-workstation/contracts/knowledge';
import { knowledgeApi, knowledgeKeys } from './api';
import { KNOWLEDGE_SERVICE_URL } from './catalog';

export function useLibraryConnection(config: KnowledgeConnection | undefined, collection: string | undefined, paused: boolean) {
  const client = useQueryClient();
  const [connecting, setConnecting] = useState(false);
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  const key = collection ? `${KNOWLEDGE_SERVICE_URL}:${collection}` : '';
  const matches = Boolean(config && config.baseUrl === KNOWLEDGE_SERVICE_URL && config.collection === collection);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (!config || !collection || matches || paused || inFlight.current || failure?.key === key) return;
    inFlight.current = true; setConnecting(true);
    void knowledgeApi.configure({ baseUrl: KNOWLEDGE_SERVICE_URL, collection, settings: config.settings }).then(async next => {
      // Publish even if the route changed: IPC already changed the Main context.
      // The next effect then switches to the latest route, one request at a time.
      await client.cancelQueries({ queryKey: knowledgeKeys.all, predicate: query => query.queryKey[1] !== 'connection' });
      client.removeQueries({ queryKey: knowledgeKeys.all, predicate: query => query.queryKey[1] !== 'connection' });
      client.setQueryData(knowledgeKeys.connection, next);
      if (mounted.current) setFailure(null);
    }).catch((reason: Error) => { if (mounted.current) setFailure({ key, message: reason.message }); }).finally(() => {
      inFlight.current = false;
      if (mounted.current) setConnecting(false);
    });
  }, [config, collection, matches, paused, failure?.key, key, client, connecting]);
  return { connecting, matches, error: failure?.key === key ? failure.message : '', retry: () => setFailure(null) };
}
