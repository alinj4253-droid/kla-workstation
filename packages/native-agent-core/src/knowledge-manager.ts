import { Annotation, END, StateGraph } from '@langchain/langgraph';
import { KM_SYSTEM_PROMPT } from './prompts.js';
import type { KMGraphState, IGraphContext } from './types.js';

const KMAnnotation = Annotation.Root({
  projectId: Annotation<string>(),
  agentInstanceId: Annotation<string>(),
  runId: Annotation<string>(),
  instruction: Annotation<string>(),
  triggerMessageId: Annotation<string>(),
  sourceFileId: Annotation<string>({ value: (_a: string, b: string) => b, default: () => '' }),
  sourceFilePath: Annotation<string>({ value: (_a: string, b: string) => b, default: () => '' }),
  sourceId: Annotation<string>({ value: (_a: string, b: string) => b, default: () => '' }),
  scopeType: Annotation<string>({ value: (_a: string, b: string) => b, default: () => 'project' }),
  scopeId: Annotation<string>({ value: (_a: string, b: string) => b, default: () => '' }),
  parsedText: Annotation<string>({ value: (_a: string, b: string) => b, default: () => '' }),
  mimeType: Annotation<string>({ value: (_a: string, b: string) => b, default: () => '' }),
  chunks: Annotation<any>({ value: (_a: any, b: any) => b, default: () => [] }),
  extractedGraph: Annotation<any>({ value: (_a: any, b: any) => b, default: () => null }),
  validatedEntities: Annotation<any>({ value: (_a: any, b: any) => b, default: () => [] }),
  validatedRelationships: Annotation<any>({ value: (_a: any, b: any) => b, default: () => [] }),
  wikiPages: Annotation<any>({ value: (_a: any, b: any) => b, default: () => [] }),
  visualizationProjection: Annotation<string>({ value: (_a: string, b: string) => b, default: () => '' }),
  pipelineCompleted: Annotation<boolean>({ value: (_a: boolean, b: boolean) => b, default: () => false }),
  entityCount: Annotation<number>({ value: (_a: number, b: number) => b, default: () => 0 }),
  relationshipCount: Annotation<number>({ value: (_a: number, b: number) => b, default: () => 0 }),
  wikiPageCount: Annotation<number>({ value: (_a: number, b: number) => b, default: () => 0 }),
  error: Annotation<string>({ value: (_a: string, b: string) => b, default: () => '' }),
  report: Annotation<string>({ value: (_a: string, b: string) => b, default: () => '' }),
});

export type KMState = KMGraphState;

export interface KMGraphNodes {
  discoverSource: (state: KMState, config: { configurable: { ctx: IGraphContext } }) => Promise<Partial<KMState>>;
  extractText: (state: KMState, config: { configurable: { ctx: IGraphContext } }) => Promise<Partial<KMState>>;
  normalizeAndChunk: (state: KMState, config: { configurable: { ctx: IGraphContext } }) => Promise<Partial<KMState>>;
  extractEntitiesAndRelations: (state: KMState, config: { configurable: { ctx: IGraphContext } }) => Promise<Partial<KMState>>;
  validateSchema: (state: KMState, config: { configurable: { ctx: IGraphContext } }) => Promise<Partial<KMState>>;
  upsertGraph: (state: KMState, config: { configurable: { ctx: IGraphContext } }) => Promise<Partial<KMState>>;
  buildProvenance: (state: KMState, config: { configurable: { ctx: IGraphContext } }) => Promise<Partial<KMState>>;
  buildWikiPages: (state: KMState, config: { configurable: { ctx: IGraphContext } }) => Promise<Partial<KMState>>;
  materializeGraphFiles: (state: KMState, config: { configurable: { ctx: IGraphContext } }) => Promise<Partial<KMState>>;
  buildVisualizationProjection: (state: KMState, config: { configurable: { ctx: IGraphContext } }) => Promise<Partial<KMState>>;
  generateReport: (state: KMState, config: { configurable: { ctx: IGraphContext } }) => Promise<Partial<KMState>>;
}

function routeAfter(state: KMState, target: string): string {
  return state.error ? 'generateReport' : target;
}

export function buildKMGraph(nodes: KMGraphNodes) {
  const builder = new StateGraph(KMAnnotation)
    .addNode('discoverSource', nodes.discoverSource as any)
    .addNode('extractText', nodes.extractText as any)
    .addNode('normalizeAndChunk', nodes.normalizeAndChunk as any)
    .addNode('extractEntitiesAndRelations', nodes.extractEntitiesAndRelations as any)
    .addNode('validateSchema', nodes.validateSchema as any)
    .addNode('upsertGraph', nodes.upsertGraph as any)
    .addNode('buildProvenance', nodes.buildProvenance as any)
    .addNode('buildWikiPages', nodes.buildWikiPages as any)
    .addNode('materializeGraphFiles', nodes.materializeGraphFiles as any)
    .addNode('buildVisualizationProjection', nodes.buildVisualizationProjection as any)
    .addNode('generateReport', nodes.generateReport as any)
    .addEdge('__start__', 'discoverSource')
    .addConditionalEdges('discoverSource', (s: KMState) => routeAfter(s, 'extractText'), ['extractText', 'generateReport'])
    .addConditionalEdges('extractText', (s: KMState) => routeAfter(s, 'normalizeAndChunk'), ['normalizeAndChunk', 'generateReport'])
    .addConditionalEdges('normalizeAndChunk', (s: KMState) => routeAfter(s, 'extractEntitiesAndRelations'), ['extractEntitiesAndRelations', 'generateReport'])
    .addConditionalEdges('extractEntitiesAndRelations', (s: KMState) => routeAfter(s, 'validateSchema'), ['validateSchema', 'generateReport'])
    .addConditionalEdges('validateSchema', (s: KMState) => routeAfter(s, 'upsertGraph'), ['upsertGraph', 'generateReport'])
    .addConditionalEdges('upsertGraph', (s: KMState) => routeAfter(s, 'buildProvenance'), ['buildProvenance', 'generateReport'])
    .addConditionalEdges('buildProvenance', (s: KMState) => routeAfter(s, 'buildWikiPages'), ['buildWikiPages', 'generateReport'])
    .addConditionalEdges('buildWikiPages', (s: KMState) => routeAfter(s, 'materializeGraphFiles'), ['materializeGraphFiles', 'generateReport'])
    .addConditionalEdges('materializeGraphFiles', (s: KMState) => routeAfter(s, 'buildVisualizationProjection'), ['buildVisualizationProjection', 'generateReport'])
    .addConditionalEdges('buildVisualizationProjection', (s: KMState) => 'generateReport', ['generateReport'])
    .addEdge('generateReport', END);

  return builder.compile();
}

export { KM_SYSTEM_PROMPT };

export function createKMInitialState(ctx: IGraphContext): KMState {
  return {
    projectId: ctx.projectId,
    agentInstanceId: ctx.agentInstanceId,
    runId: ctx.runId,
    instruction: ctx.instruction,
    triggerMessageId: ctx.triggerMessageId,
    sourceFileId: '',
    sourceFilePath: '',
    sourceId: '',
    scopeType: 'project',
    scopeId: ctx.projectId,
    parsedText: '',
    mimeType: '',
    chunks: [],
    extractedGraph: null,
    validatedEntities: [],
    validatedRelationships: [],
    wikiPages: [],
    visualizationProjection: '',
    pipelineCompleted: false,
    entityCount: 0,
    relationshipCount: 0,
    wikiPageCount: 0,
    error: '',
    report: '',
  };
}
