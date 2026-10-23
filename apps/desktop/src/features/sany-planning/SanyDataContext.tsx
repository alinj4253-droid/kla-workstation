import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { sessionChangedEventName } from '../../api/client';
import {
  sanyApi,
  type SanyBootstrapDto,
  type SanyDocumentInput,
  type SanyFieldDto,
  type SanyMemberDto,
  type SanyProjectDto,
  type SanyRole,
  type SanyTaskDto,
} from '../../api/sany';
import { Btn, Card } from './ui';

type SanyActions = {
  reload: () => Promise<void>;
  addMember: (input: { empNo: string; name: string; title: string; unit: string; role?: SanyRole }) => Promise<void>;
  removeMember: (memberId: string) => Promise<void>;
  addDocument: (input: SanyDocumentInput) => Promise<void>;
  removeDocument: (documentId: string) => Promise<void>;
  addField: (input: { scope: 'company' | 'unit'; moduleKey: SanyFieldDto['moduleKey']; taskId?: string | null; label: string; type?: string; ai?: string; human?: string | null }) => Promise<void>;
  patchField: (fieldId: string, patch: { status?: SanyFieldDto['status']; human?: string | null; removed?: boolean; removedReason?: string | null }) => Promise<void>;
  createTask: (input: { title: string; intent: string; deadline: string; owners: Array<{ name: string; unit: string }>; requirements: string[] }) => Promise<void>;
  patchIssue: (issueId: string, status: string) => Promise<void>;
  patchProject: (input: { conclusion?: string; decisions?: Record<string, string>; outputGenerated?: boolean; outputReleased?: boolean; deliveryChecks?: Record<string, boolean> }) => Promise<void>;
  addFeedback: (content: string) => Promise<void>;
  addVersion: (outputKey: string, input: { summary: string; changes: string; size: string; file: string; status?: string }) => Promise<void>;
};

type SanyDataValue = {
  data: SanyBootstrapDto;
  actions: SanyActions;
  actionError: string | null;
  clearActionError: () => void;
};

const SanyDataContext = createContext<SanyDataValue | null>(null);

type Props = { children: ReactNode };

/** 三一规划数据源：进入分区时从服务端 /v1/sany/bootstrap 读取，写操作直接落库并回写本地缓存。 */
export function SanyDataProvider({ children }: Props): React.JSX.Element {
  const [data, setData] = useState<SanyBootstrapDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const started = useRef(false);

  const load = useCallback(async () => {
    try {
      const next = await sanyApi.bootstrap();
      setData(next);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '规划数据加载失败');
    }
  }, []);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void load();
  }, [load]);

  // 身份切换会换一套账号数据，必须重新拉取，不能复用上一个身份的项目。
  useEffect(() => {
    const onSessionChanged = () => {
      setData(null);
      setError(null);
      void load();
    };
    window.addEventListener(sessionChangedEventName, onSessionChanged);
    return () => window.removeEventListener(sessionChangedEventName, onSessionChanged);
  }, [load]);

  const run = useCallback(async (task: () => Promise<void>) => {
    try {
      setActionError(null);
      await task();
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : '操作失败，请稍后重试');
    }
  }, []);

  const actions = useMemo<SanyActions>(() => ({
    reload: load,
    addMember: input => run(async () => {
      const member: SanyMemberDto = await sanyApi.addMember(input);
      setData(prev => (prev ? { ...prev, members: [...prev.members, member] } : prev));
    }),
    removeMember: memberId => run(async () => {
      await sanyApi.removeMember(memberId);
      setData(prev => (prev ? { ...prev, members: prev.members.filter(member => member.id !== memberId) } : prev));
    }),
    addDocument: input => run(async () => {
      const document = await sanyApi.addDocument(input);
      setData(prev => (prev ? { ...prev, documents: [...prev.documents, document] } : prev));
    }),
    removeDocument: documentId => run(async () => {
      await sanyApi.removeDocument(documentId);
      setData(prev => (prev ? { ...prev, documents: prev.documents.filter(document => document.id !== documentId) } : prev));
    }),
    addField: input => run(async () => {
      const field = await sanyApi.addField(input);
      setData(prev => (prev ? { ...prev, fields: [...prev.fields, field] } : prev));
    }),
    patchField: (fieldId, patch) => run(async () => {
      const field = await sanyApi.patchField(fieldId, patch);
      setData(prev => (prev ? { ...prev, fields: prev.fields.map(item => (item.id === fieldId ? { ...item, ...field } : item)) } : prev));
    }),
    createTask: input => run(async () => {
      await sanyApi.createTask(input);
      // 新任务带服务端生成的编号与统计值，重新拉取一次最稳妥。
      await load();
    }),
    patchIssue: (issueId, status) => run(async () => {
      const result = await sanyApi.patchIssue(issueId, status);
      setData(prev => (prev ? { ...prev, issues: prev.issues.map(issue => (issue.id === issueId ? { ...issue, status: result.status } : issue)) } : prev));
    }),
    patchProject: input => run(async () => {
      await sanyApi.patchProject(input);
      setData(prev => {
        if (!prev) return prev;
        const project: SanyProjectDto = {
          ...prev.project,
          ...(input.conclusion !== undefined ? { conclusion: input.conclusion } : {}),
          ...(input.decisions ? { decisions: input.decisions } : {}),
          ...(input.outputGenerated !== undefined ? { outputGenerated: input.outputGenerated } : {}),
          ...(input.outputReleased !== undefined ? { outputReleased: input.outputReleased } : {}),
          ...(input.deliveryChecks ? { deliveryChecks: input.deliveryChecks } : {}),
        };
        return { ...prev, project };
      });
    }),
    addFeedback: content => run(async () => {
      const item = await sanyApi.addFeedback(content);
      setData(prev => (prev ? { ...prev, feedback: [item, ...prev.feedback] } : prev));
    }),
    addVersion: (outputKey, input) => run(async () => {
      const version = await sanyApi.addVersion(outputKey, input);
      setData(prev => (prev ? {
        ...prev,
        outputs: prev.outputs.map(output => (output.key === outputKey ? { ...output, versions: [...output.versions, version] } : output)),
      } : prev));
    }),
  }), [load, run]);

  if (error) {
    return (
      <section className="sany-page">
        <Card className="sany-card--pad sany-center">
          <div className="sany-empty">
            <div className="sany-empty__i">!</div>
            <div className="sany-empty__t">规划数据加载失败</div>
            <div className="sany-empty__s">{error}</div>
            <Btn tone="pri" onClick={() => { setError(null); void load(); }}>重新加载</Btn>
          </div>
        </Card>
      </section>
    );
  }

  if (!data) {
    return (
      <section className="sany-page">
        <Card className="sany-card--pad sany-center">
          <div className="sany-empty">
            <div className="sany-empty__t">正在从数据库加载规划数据…</div>
            <div className="sany-empty__s">项目、成员、任务、材料与校验内容均以服务端数据为准</div>
          </div>
        </Card>
      </section>
    );
  }

  const value: SanyDataValue = {
    data,
    actions,
    actionError,
    clearActionError: () => setActionError(null),
  };

  return (
    <SanyDataContext.Provider value={value}>
      {actionError ? (
        <div className="sany-alert r sany-mb12">
          <span className="sany-alert__i">!</span>
          <div className="sany-row">
            <span className="sany-grow">{actionError}</span>
            <button type="button" className="sany-link" onClick={() => setActionError(null)}>关闭</button>
          </div>
        </div>
      ) : null}
      {children}
    </SanyDataContext.Provider>
  );
}

export function useSanyData(): SanyDataValue {
  const value = useContext(SanyDataContext);
  if (!value) throw new Error('useSanyData 必须在 SanyDataProvider 内使用');
  return value;
}
