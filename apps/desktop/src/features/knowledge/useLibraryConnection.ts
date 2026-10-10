import { useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { KnowledgeConnection } from '@kla-workstation/contracts/knowledge';
import { knowledgeApi, knowledgeKeys } from './api';
import { KNOWLEDGE_SERVICE_URL } from './catalog';

export function useLibraryConnection(config: KnowledgeConnection | undefined, collection: string | undefined, paused: boolean) {
  const client = useQueryClient();
  const [connecting, setConnecting] = useState(false);
  const [confirmed, setConfirmed] = useState<{ previousId: string; connection: KnowledgeConnection } | null>(null);
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null);
  const inFlight = useRef(false);
  const mounted = useRef(true);
  const key = collection ? KNOWLEDGE_SERVICE_URL + ':' + collection : '';
  const current = confirmed && (!config || config.serviceInstanceId === confirmed.previousId || config.serviceInstanceId === confirmed.connection.serviceInstanceId) ? confirmed.connection : config;
  const matches = Boolean(current && current.baseUrl === KNOWLEDGE_SERVICE_URL && current.collection === collection);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (!current || !collection || matches || paused || inFlight.current || failure?.key === key) return;
    inFlight.current = true; setConnecting(true);
    const previousId = current.serviceInstanceId;
    const publish = (next: KnowledgeConnection) => {
      if (next.baseUrl !== KNOWLEDGE_SERVICE_URL || next.collection !== collection) throw new Error('服务返回的集合与目标知识库不一致，请重新连接。');
      client.setQueryData(knowledgeKeys.connection, next);
      // Keep active observers and the independent collection statistics cache attached.
      void client.cancelQueries({ queryKey: knowledgeKeys.all, predicate: query => !['connection', 'statistics'].includes(String(query.queryKey[1])) });
      client.removeQueries({ queryKey: knowledgeKeys.all, type: 'inactive', predicate: query => !['connection', 'statistics'].includes(String(query.queryKey[1])) });
      if (mounted.current) { setConfirmed({ previousId, connection: next }); setFailure(null); }
    };
    void (async () => {
      // An old connection read must not overwrite the confirmed result after switching.
      await client.cancelQueries({ queryKey: knowledgeKeys.connection });
      try { publish(await knowledgeApi.configure({ baseUrl: KNOWLEDGE_SERVICE_URL, collection, settings: current.settings })); }
      catch (reason) {
        // A timed out response can follow a successful server-side configuration.
        const next = await knowledgeApi.connection().catch(() => undefined);
        if (next && next.baseUrl === KNOWLEDGE_SERVICE_URL && next.collection === collection) publish(next);
        else throw reason;
      }
    })().catch((reason: unknown) => { if (mounted.current) setFailure({ key, message: reason instanceof Error ? reason.message : '连接失败，请重试。' }); }).finally(() => {
      inFlight.current = false;
      if (mounted.current) setConnecting(false);
    });
  }, [current, collection, matches, paused, failure?.key, key, client, connecting]);
  return { connecting, matches, connection: current, error: failure?.key === key ? failure.message : '', retry: () => setFailure(null) };
}
