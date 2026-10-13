import { QUESTIONS, CHECKS, freshInterview, assessment, candidates, judge, report, reportMarkdown } from './interview.js';
import { STAGES } from './catalog.js';
import { homeAiSessionViewSchema, type HomeAiSessionView } from '@kla-workstation/contracts';

// The migrated JavaScript core keeps its existing state shape and rules.
export type DiagnosticState = Record<string, any>;
export function newDiagnostic(): DiagnosticState { return freshInterview(); }
export function sceneFor(stageId: string) {
  const stage = STAGES.find(stage => stage.id === stageId);
  if (!stage) throw new Error('场景编号无效，请从机会发现返回的场景编号中选择。');
  return stage;
}
export function canConfirm(state: DiagnosticState, stageId: string): boolean {
  const result = judge(state, sceneFor(stageId));
  return state.profileConfirmed === true && CHECKS.every(check => assessment(state,stageId).checks[check.id] === 'yes')
    && result.value.complete === true && !['I','C','D'].includes(result.grade);
}
export function sceneReport(state: DiagnosticState, stageId: string) {
  const copy = structuredClone(state); copy.selected = stageId;
  const result = judge(copy,sceneFor(stageId));
  return {...result, ...report(copy,stageId), grade:result.grade, markdown:reportMarkdown(copy), canConfirm:canConfirm(copy,stageId)};
}
export function sessionView(sessionId: string, revision: number, state: DiagnosticState): HomeAiSessionView {
  const next = QUESTIONS.find(question => !state.answers[question.id]);
  return homeAiSessionViewSchema.parse({sessionId,revision,profileConfirmed:state.profileConfirmed,
    answers:state.answers, candidates:candidates(structuredClone(state)).map(({id,name,title,match}) => ({id,name,title,match})),
    documents:state.documents.map((document: any) => ({id:document.id,name:document.name,chunks:document.chunks.length})),
    scenes:Object.keys(state.scenes).map(stageId => {
      const a = assessment(state,stageId), r = sceneReport(state,stageId);
      return {stageId,checks:a.checks,notes:a.notes,numbers:a.numbers,source:a.source,grade:r.grade,reason:r.reason,
        accepted:r.accepted,canConfirm:r.canConfirm,markdown:r.markdown};
    }), nextQuestion:next ? {id:next.id,text:next.text,hint:next.hint} : null});
}
