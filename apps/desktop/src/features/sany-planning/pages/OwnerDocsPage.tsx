import { useRef, useState } from 'react';
import { PageHead, Card, Tag, Btn, Alert, Pbar } from '../ui';
import { useSanyData } from '../SanyDataContext';
import { MODULE_DOC_SPEC, MODULES, type ModuleKey } from '../mock';
import type { SanyView } from '../SanyPlanningSection';

type Props = { onNavigate?: (view: SanyView) => void };

const EXT_COLOR: Record<string, string> = {
  pdf: '#a83a2d',
  xlsx: '#1f7a4d',
  xls: '#1f7a4d',
  csv: '#1f7a4d',
  docx: '#3a4a63',
  doc: '#3a4a63',
  pptx: '#96631a',
  ppt: '#96631a',
  txt: '#6e747d',
};

const extOf = (name: string): string => {
  const part = name.split('.').pop() ?? '';
  return part.toLowerCase().slice(0, 8);
};

const sizeLabel = (bytes: number): string => {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  if (bytes >= 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${bytes} B`;
};

export function OwnerDocsPage({ onNavigate }: Props): React.JSX.Element {
  const { data, actions, ownerTask, ownerTasks, setOwnerTaskId } = useSanyData();
  const task = ownerTask;
  const docsOf = (key: ModuleKey) => data.documents.filter(document => document.scope === 'unit' && document.moduleKey === key && document.taskId === (ownerTask?.id ?? null));
  const withDocs = MODULES.filter(module => docsOf(module.k).length > 0).length;

  const [parsing, setParsing] = useState<Record<string, number>>({});
  const [dragOver, setDragOver] = useState<ModuleKey | null>(null);
  const timers = useRef<Record<string, ReturnType<typeof setInterval>>>({});
  const inputs = useRef<Record<string, HTMLInputElement | null>>({});

  const stopTimer = (key: ModuleKey) => {
    const timer = timers.current[key];
    if (timer) clearInterval(timer);
    delete timers.current[key];
  };

  const startParsing = (key: ModuleKey, added: number) => {
    stopTimer(key);
    setParsing(prev => ({ ...prev, [key]: 5 }));
    timers.current[key] = setInterval(() => {
      setParsing(prev => {
        const current = prev[key] ?? 100;
        if (current >= 100) {
          stopTimer(key);
          return prev;
        }
        return { ...prev, [key]: Math.min(100, current + Math.ceil(90 / Math.max(2, added * 2))) };
      });
    }, 400);
  };

  const uploadFiles = (key: ModuleKey, files: FileList | File[]) => {
    const list = Array.from(files);
    if (!list.length) return;
    for (const file of list) {
      const ext = extOf(file.name);
      void actions.addDocument({
        scope: 'unit',
        moduleKey: key,
        taskId: task?.id ?? null,
        name: file.name,
        ext,
        size: sizeLabel(file.size),
        color: EXT_COLOR[ext] ?? '#6e747d',
        pages: 0,
        claims: 0,
        fields: 0,
      });
    }
    startParsing(key, list.length);
  };

  const removeDoc = (documentId: string, key: ModuleKey) => {
    void actions.removeDocument(documentId);
    if (!docsOf(key).length) {
      stopTimer(key);
      setParsing(prev => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
    }
  };

  const loadModule = (key: ModuleKey) => {
    const existing = docsOf(key);
    const preset = MODULE_DOC_SPEC[key].docs
      .filter(doc => !existing.some(item => item.name === doc.name));
    preset.forEach(doc => void actions.addDocument({
      scope: 'unit',
      moduleKey: key,
      taskId: task?.id ?? null,
      name: doc.name,
      ext: doc.ext,
      size: doc.size,
      color: doc.color,
      pages: doc.pages,
      claims: doc.claims,
      fields: doc.fields,
    }));
    if (preset.length) startParsing(key, preset.length);
  };

  const loadAll = () => MODULES.forEach(module => loadModule(module.k));

  const progressOf = (key: ModuleKey): number | null => parsing[key] ?? null;

  return (
    <section className="sany-page">
      {ownerTasks.length > 1 ? (
        <div className="sany-taskbar">
          <span className="sany-taskbar__l">当前任务</span>
          <select className="sany-sel sany-taskbar__grow" value={ownerTask?.id ?? ''} onChange={event => setOwnerTaskId(event.target.value)}>
            {ownerTasks.map(item => <option key={item.id} value={item.id}>{item.code} · {item.title}</option>)}
          </select>
          <span className="sany-taskbar__t">{ownerTask?.unit}</span>
        </div>
      ) : null}
      <PageHead
        title="材料准备"
        sub="四模块分别上传本单元材料；系统自动读取结论并生成初稿；无需你逐行阅读，缺料会自动列出"
        actions={(
          <>
            {withDocs ? <Btn tone="pri" onClick={() => onNavigate?.('prefill')}>查看生成内容 →</Btn> : null}
            <Btn onClick={loadAll}>一键加载演示材料</Btn>
          </>
        )}
      />

      <Card className="sany-card--pad sany-card--soft sany-mb20">
        <div className="sany-row sany-mb12">
          <b>我的任务</b>
          <span className="sany-small sany-mono">{task?.title ?? '尚未收到任务'}</span>
          <span className="sany-spacer" />
          <span className="sany-small">{withDocs} / 4 个模块已有材料</span>
        </div>
        <div className="sany-grid g4 sany-gap12">
          {MODULES.map(module => {
            const list = docsOf(module.k);
            const progress = progressOf(module.k);
            return (
              <div className="sany-modstat" key={module.k}>
                <span className="sany-modstat__ic">{module.icon}</span>
                <div className="sany-grow">
                  <div className="sany-strong">{module.n}</div>
                  <div className="sany-small">
                    {progress !== null && progress < 100
                      ? `解析中 ${progress}%`
                      : list.length ? `${list.length} 份材料` : '未上传'}
                  </div>
                </div>
                <span className={`sany-dot ${list.length ? 'ok' : ''}`} />
              </div>
            );
          })}
        </div>
      </Card>

      <div className="sany-grid g2 sany-align-stretch">
        {MODULES.map(module => {
          const list = docsOf(module.k);
          const spec = MODULE_DOC_SPEC[module.k];
          const required = spec.need.filter(item => item.req).length;
          const progress = progressOf(module.k);
          return (
            <Card className="sany-card--pad sany-modcard" key={module.k}>
              <div className="sany-row sany-mb4">
                <span className="sany-modstat__ic">{module.icon}</span>
                <b>{module.n}</b>
                <span className="sany-spacer" />
                {progress !== null && progress < 100
                  ? <Tag tone="v">解析中 {progress}%</Tag>
                  : list.length ? <Tag tone="g">{list.length} 份 · 已登记</Tag> : <Tag>未上传</Tag>}
              </div>
              <div className="sany-small sany-mb12">{spec.hint}</div>

              <div className="sany-mb12">
                <div className="sany-row sany-mb8">
                  <span className="sany-small sany-strong">建议你准备这些材料</span>
                  <span className="sany-spacer" />
                  {list.length
                    ? list.length >= required
                      ? <Tag tone="g">已覆盖必需项</Tag>
                      : <Tag tone="w">建议再补 {required - list.length} 项</Tag>
                    : null}
                </div>
                {spec.need.map(item => (
                  <div className="sany-needrow" key={item.n}>
                    <span className="sany-needrow__d">·</span>
                    <span className="sany-grow">{item.n}</span>
                    {item.req ? <Tag>必需</Tag> : <Tag tone="line">可选</Tag>}
                  </div>
                ))}
              </div>

              <div className="sany-modcard__foot">
                <div
                  className={`sany-drop ${dragOver === module.k ? 'over' : ''}`}
                  onClick={() => inputs.current[module.k]?.click()}
                  onDragOver={event => { event.preventDefault(); setDragOver(module.k); }}
                  onDragLeave={() => setDragOver(null)}
                  onDrop={event => {
                    event.preventDefault();
                    setDragOver(null);
                    if (event.dataTransfer?.files?.length) uploadFiles(module.k, event.dataTransfer.files);
                  }}
                >
                  <div className="sany-drop__i">↑</div>
                  <div className="sany-drop__t">{list.length ? '继续添加材料' : `为「${module.n}」上传材料`}</div>
                  <div className="sany-drop__s">点击选择或拖入文件 · PDF / Excel / Word / PPT</div>
                  <input
                    ref={el => { inputs.current[module.k] = el; }}
                    type="file"
                    multiple
                    hidden
                    accept=".pdf,.xlsx,.xls,.csv,.docx,.doc,.pptx,.ppt,.txt"
                    onChange={event => {
                      if (event.target.files?.length) uploadFiles(module.k, event.target.files);
                      event.target.value = '';
                    }}
                  />
                </div>

                {progress !== null && progress < 100 ? (
                  <div className="sany-mt8">
                    <Pbar value={progress} />
                    <div className="sany-small sany-muted sany-mt4">正在解析新上传的材料，可继续其他操作</div>
                  </div>
                ) : null}

                {list.length ? (
                  <>
                    <div className="sany-doclist">
                      {list.map(doc => (
                        <div className="sany-fitem" key={doc.id}>
                          <span className="sany-fico" style={{ background: doc.color }}>{doc.ext.toUpperCase().slice(0, 4)}</span>
                          <div className="sany-grow">
                            <div className="sany-fname">{doc.name}</div>
                            <div className="sany-fmeta">
                              {doc.size}
                              {doc.pages ? ` · 解析 ${doc.pages} 页 · 提取 ${doc.claims} 条结论` : ' · 已登记待解析'}
                            </div>
                          </div>
                          <button type="button" className="sany-link" onClick={() => removeDoc(doc.id, module.k)}>移除</button>
                        </div>
                      ))}
                    </div>
                    <div className="sany-row sany-mt8">
                      <span className="sany-small">
                        {list.some(doc => doc.fields > 0)
                          ? `已提取 ${list.reduce((sum, doc) => sum + doc.fields, 0)} 个结论字段 → 下一步校验`
                          : '材料已登记，解析结果将在内容校验中呈现'}
                      </span>
                      <span className="sany-spacer" />
                      <button type="button" className="sany-link" onClick={() => onNavigate?.('prefill')}>
                        查看生成内容 →
                      </button>
                    </div>
                  </>
                ) : null}
              </div>
            </Card>
          );
        })}
      </div>

      <div className="sany-mt20">
        <Alert icon="i">
          AI 不编造内容，材料里没有的会给你留空标注「缺材料」，不替你做取舍。四模块是分析框架，不适用的内容可以标记不适用。
        </Alert>
      </div>
    </section>
  );
}
