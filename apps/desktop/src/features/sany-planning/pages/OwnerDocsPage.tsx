import { PageHead, Card, Tag, Btn, Alert } from '../ui';
import { useSanyData } from '../SanyDataContext';
import { MODULE_DOC_SPEC, MODULES, type ModuleKey } from '../mock';
import type { SanyView } from '../SanyPlanningSection';

type Props = { onNavigate?: (view: SanyView) => void };

export function OwnerDocsPage({ onNavigate }: Props): React.JSX.Element {
  const { data, actions } = useSanyData();
  const task = data.tasks[0];
  const docsOf = (key: ModuleKey) => data.documents.filter(document => document.scope === 'unit' && document.moduleKey === key);
  const withDocs = MODULES.filter(module => docsOf(module.k).length > 0).length;

  const loadModule = (key: ModuleKey) => {
    const existing = docsOf(key);
    MODULE_DOC_SPEC[key].docs
      .filter(doc => !existing.some(item => item.name === doc.name))
      .forEach(doc => void actions.addDocument({
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
  };

  const loadAll = () => MODULES.forEach(module => loadModule(module.k));

  const removeDoc = (documentId: string) => void actions.removeDocument(documentId);

  return (
    <section className="sany-page">
      <PageHead
        title="材料准备"
        sub="四模块分别上传本单元材料；系统自动读取结论并生成初稿；无需你逐行阅读，缺料会自动列出"
        actions={(
          <>
            {withDocs ? <Btn tone="pri" onClick={() => onNavigate?.('prefill')}>查看生成内容 →</Btn> : null}
            <Btn onClick={loadAll}>一键加载全部材料</Btn>
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
            return (
              <div className="sany-modstat" key={module.k}>
                <span className="sany-modstat__ic">{module.icon}</span>
                <div className="sany-grow">
                  <div className="sany-strong">{module.n}</div>
                  <div className="sany-small">{list.length ? `${list.length} 份材料` : '未上传'}</div>
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
          return (
            <Card className="sany-card--pad sany-modcard" key={module.k}>
              <div className="sany-row sany-mb4">
                <span className="sany-modstat__ic">{module.icon}</span>
                <b>{module.n}</b>
                <span className="sany-spacer" />
                {list.length ? <Tag tone="g">{list.length} 份 · 已解析</Tag> : <Tag>未上传</Tag>}
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
                <button type="button" className="sany-drop" onClick={() => loadModule(module.k)}>
                  <div className="sany-drop__i">↑</div>
                  <div className="sany-drop__t">{list.length ? '继续添加材料' : `为「${module.n}」上传材料`}</div>
                  <div className="sany-drop__s">PDF / Excel / Word / PPT</div>
                </button>

                {list.length ? (
                  <>
                    <div className="sany-doclist">
                      {list.map(doc => (
                        <div className="sany-fitem" key={doc.id}>
                          <span className="sany-fico" style={{ background: doc.color }}>{doc.ext.toUpperCase().slice(0, 4)}</span>
                          <div className="sany-grow">
                            <div className="sany-fname">{doc.name}</div>
                            <div className="sany-fmeta">{doc.size} · 解析 {doc.pages} 页 · 提取 {doc.claims} 条结论</div>
                          </div>
                          <button type="button" className="sany-link" onClick={() => removeDoc(doc.id)}>移除</button>
                        </div>
                      ))}
                    </div>
                    <div className="sany-row sany-mt8">
                      <span className="sany-small">
                        已提取 {list.reduce((sum, doc) => sum + doc.fields, 0)} 个结论字段 → 下一步校验
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
