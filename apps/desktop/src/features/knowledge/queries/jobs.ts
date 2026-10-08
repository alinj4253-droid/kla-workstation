import { useEffect, useRef } from 'react';
import { v4 as randomUUID } from 'uuid';
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import type { KnowledgeContext, SourceJobBinding, JobSnapshot } from '@kla-workstation/contracts/knowledge';
import { bridge, knowledgeApi, knowledgeKeys, unwrap, KnowledgeApiError } from '../api';
import type { KnowledgeSlots } from '../slots';

export function latestJobSnapshot(current: JobSnapshot | undefined, incoming: JobSnapshot): JobSnapshot {
  if (!current || current.job_id !== incoming.job_id) return incoming;
  const currentTerminal = !['queued', 'running'].includes(current.state);
  if ((currentTerminal && ['queued', 'running'].includes(incoming.state)) || current.updated_at > incoming.updated_at) return current;
  return incoming;
}

export function latestJobHistory(current: { count: number; jobs: JobSnapshot[] } | undefined, incoming: { count: number; jobs: JobSnapshot[] }) {
  const previous = new Map(current?.jobs.map(job => [job.job_id, job]));
  const jobs = incoming.jobs.map(job => latestJobSnapshot(previous.get(job.job_id), job));
  return { count: jobs.length, jobs };
}

export function useJobs(context: KnowledgeContext, bindings: SourceJobBinding[], onChanged?: KnowledgeSlots['sourceChanged'], pollIntervalMs = 4000) {
  const client = useQueryClient();
  const seen = useRef(new Map<string, string>());
  const ids = Array.from(new Set(bindings.map(b => b.jobId))).sort();
  const identity = ids.join('|');
  const history = useQuery({ queryKey: knowledgeKeys.jobs(context.serviceInstanceId, context.collection), queryFn: async () => { const incoming = await knowledgeApi.jobs(context.serviceInstanceId); return latestJobHistory(client.getQueryData(knowledgeKeys.jobs(context.serviceInstanceId, context.collection)), incoming); }, enabled: bindings.length > 0, retry: false });
  const queries = useQueries({ queries: ids.map(id => ({
    queryKey: knowledgeKeys.job(context.serviceInstanceId, context.collection, id),
    queryFn: async () => {
      const incoming = await knowledgeApi.job(context.serviceInstanceId, id);
      return latestJobSnapshot(client.getQueryData<JobSnapshot>(knowledgeKeys.job(context.serviceInstanceId, context.collection, id)), incoming);
    }, retry: false,
    initialData: () => history.data?.jobs.find(job => job.job_id === id),
    refetchInterval: (query: { state: { data: JobSnapshot | undefined; error: unknown } }) => {
      if (query.state.error instanceof KnowledgeApiError && !query.state.error.error.retryable) return false;
      // SSE supplies immediate updates; polling also watches a silent or stalled stream.
      if (query.state.error) return pollIntervalMs;
      return !query.state.data || ['queued', 'running'].includes(query.state.data.state) ? pollIntervalMs : false;
    },
  })) });
  useEffect(() => {
    const service = context.serviceInstanceId;
    const collection = context.collection;
    const subscriptions = new Map<string, string>(ids.map(id => [randomUUID(), id]));
    const remove = bridge().onJobEvent(event => {
      if (event.serviceInstanceId !== service || subscriptions.get(event.subscriptionId) !== event.jobId) return;
      if (event.snapshot) {
        const snapshot = event.snapshot;
        client.setQueryData<JobSnapshot>(knowledgeKeys.job(service, collection, event.jobId), current => latestJobSnapshot(current, snapshot));
      }
      if (event.disconnected) {
        void client.invalidateQueries({ queryKey: knowledgeKeys.job(service, collection, event.jobId) });
      }
    });
    for (const [subscriptionId, jobId] of subscriptions) {
      void unwrap(bridge().subscribeJob({ serviceInstanceId: service, jobId, subscriptionId })).catch(() => undefined);
    }
    return () => {
      remove();
      for (const subscriptionId of subscriptions.keys()) void unwrap(bridge().unsubscribeJob({ subscriptionId })).catch(() => undefined);
    };
    // An unchanged ID set must retain subscriptions through every snapshot update.
  }, [identity, context.serviceInstanceId, context.collection, client]);
  useEffect(() => {
    for (const query of queries) {
      const job = query.data; if (!job) continue;
      const key = `${context.serviceInstanceId}:${context.collection}:${job.job_id}`;
      const binding = bindings.find(b => b.jobId === job.job_id);
      const signature = `${binding?.docId ?? ''}:${job.state}:${job.updated_at}:${JSON.stringify(job.progress)}`;
      if (seen.current.get(key) === signature) continue;
      seen.current.set(key, signature);
      if (binding) onChanged?.(binding, job);
      client.setQueryData<{ count: number; jobs: JobSnapshot[] }>(knowledgeKeys.jobs(context.serviceInstanceId, context.collection), current => {
        const records = current?.jobs ?? [];
        const previous = records.find(record => record.job_id === job.job_id);
        const updated = latestJobSnapshot(previous, job);
        const next = previous ? records.map(record => record.job_id === job.job_id ? updated : record) : [...records, updated];
        return { count: next.length, jobs: next };
      });
      if (binding?.docId && !['queued', 'running'].includes(job.state)) {
        void client.invalidateQueries({ queryKey: knowledgeKeys.sourceContent(context.serviceInstanceId, context.collection, binding.docId) });
      }
      if (!['queued', 'running'].includes(job.state)) {
        void client.invalidateQueries({ queryKey: knowledgeKeys.sources(context.serviceInstanceId, context.collection) });
        void client.invalidateQueries({ queryKey: knowledgeKeys.bindings(context.serviceInstanceId, context.collection) });
      }
    }
  }, [queries, bindings, context.serviceInstanceId, context.collection, client, onChanged]);
  return { queries, ids, history, refresh: () => { void history.refetch(); for (const query of queries) void query.refetch(); } };
}
