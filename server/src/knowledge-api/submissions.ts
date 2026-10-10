import { moduleState, readStored } from './context.js';
function state() { return moduleState('submissions', () => ({submissions: [] as Submission[],writes: Promise.resolve()})); }
import { z } from 'zod';
import type { UnconfirmedSubmission } from '@kla-workstation/contracts/knowledge';
import { atomicJson } from './config.js';
const schema = z.object({ clientUploadId: z.string(), displayName: z.string(), physicalName: z.string(), collection: z.string(), submittedAt: z.string(), serverOrigin: z.string(), credentialRef: z.string().nullable() });
type Submission = z.infer<typeof schema>;
export async function loadSubmissions(): Promise<void> {
    try {
        state().submissions = z.array(schema).parse(await readStored('submissions.json'));
    }
    catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
            throw error;
    }
}
function persist(): Promise<void> { state().writes = state().writes.catch(() => undefined).then(() => atomicJson('submissions.json', state().submissions)); return state().writes; }
export async function beginSubmission(input: Submission): Promise<void> { state().submissions.push(input); await persist(); }
export async function confirmSubmission(id: string): Promise<void> { state().submissions = state().submissions.filter(item => item.clientUploadId !== id); await persist(); }
export function getUnconfirmed(origin: string, collection: string, credentialRef: string | null): UnconfirmedSubmission[] {
    return state().submissions.filter(item => item.serverOrigin === origin && item.collection === collection && item.credentialRef === credentialRef).map(({ serverOrigin: _origin, credentialRef: _ref, ...item }) => item);
}
export function hasSubmission(id: string): boolean { return state().submissions.some(item => item.clientUploadId === id); }
export function reservedSubmissionNames(origin: string, credentialRef: string | null): string[] {
    return state().submissions.filter(item => item.serverOrigin === origin && item.credentialRef === credentialRef).map(item => item.displayName);
}
