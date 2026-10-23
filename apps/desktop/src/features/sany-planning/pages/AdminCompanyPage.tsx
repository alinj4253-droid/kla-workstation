import { PageHead, Card, Tag, Btn, Alert } from '../ui';
import { useSanyData } from '../SanyDataContext';
import { COMPANY_DOC_SPEC, COMPANY_MODULES, type ModuleKey } from '../mock';
import type { SanyView } from '../SanyPlanningSection';

type Props = { onNavigate?: (view: SanyView) => void };

export function AdminCompanyPage({ onNavigate }: Props): React.JSX.Element {
  const { data, actions } = useSanyData();
  const docsOf = (key: ModuleKey) => data.documents.filter(document => document.scope === 'company' && document.moduleKey === key);
  const fieldsOf = (key: ModuleKey) => data.fields.filter(field => field.scope === 'company' && field.moduleKey === key && !field.removed);
  const withDocs = COMPANY_MODULES.filter(module => docsOf(module.k).length > 0).length;

  const loadModule = (key: ModuleKey) => {
    const existing = docsOf(key);
    COMPANY_DOC_SPEC[key].docs
      .filter(doc => !existing.some(item => item.name === doc.name))
      .forEach(doc => void actions.addDocument({
        scope: 'company',
        moduleKey: key,
        taskId: null,
        name: doc.name,
        ext: doc.ext,
        size: doc.size,
        color: doc.color,
        pages: doc.pages,
        claims: doc.claims,
        fields: doc.fields,
      }));
  };

  const loadAll = () => COMPANY_MODULES.forEach(module => loadModule(module.k));

  const removeDoc = (documentId: string) => void actions.removeDocument(documentId);

  return (
    <section className="sany-page">
      <PageHead
        title="公司层填报"
        sub="集团层面内容由你自己准备，按四个模块分别上传集团材料。上传后后台解析，可继续传其他模块"
        actions={(
          <>
            {withDocs ? <Btn tone="pri" onClick={() => onNavigate?.('verify')}>校验生成内容 →</Btn> : null}
            <Btn onClick={loadAll}>一键加载全部集团材料</Btn>
          </>
        )}
      />

      <Card className="sany-card--pad sany-card--soft sany-mb20">
        <div className="sany-row sany-mb12">
          <b>集团材料准备情况</b>
          <span className="sany-small">{withDocs} / 4 个模块已有材料</span>
          <span className="sany-spacer" />
          {withDocs === 4 ? <Tag tone="g">可开始生成</Tag> : <Tag>未上传的模块将标记为缺材料</Tag>}
        </div>
        <div className="sany-grid g4 sany-gap12">
          {COMPANY_MODULES.map(module => {
            const list = docsOf(module.k);
            const generated = fieldsOf(module.k).filter(field => field.status !== 'missing').length;
            return (
              <div className="sany-modstat" key={module.k}>
                <span className="sany-modstat__ic">{module.icon}</span>
                <div className="sany-grow">
                  <div className="sany-strong">{module.n}</div>
                  <div className="sany-small">{list.length ? `${list.length} 份 · 生成 ${generated} 项` : '未上传'}</div>
                </div>
                <span className={`sany-dot ${list.length ? 'ok' : ''}`} />
              </div>
            );
          })}
        </div>
      </Card>

      <div className="sany-grid g2 sany-align-stretch">
        {COMPANY_MODULES.map(module => {
          const list = docsOf(module.k);
          const spec = COMPANY_DOC_SPEC[module.k];
          const required = spec.need.filter(item => item.req).length;
          const fields = fieldsOf(module.k);
          const generated = fields.filter(field => field.status !== 'missing').length;
          const missing = fields.filter(field => field.status === 'missing').length;
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
                  <span className="sany-small sany-strong">建议准备的集团材料</span>
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
                  <div className="sany-drop__t">{list.length ? '继续添加材料' : `为「${module.n}」上传集团材料`}</div>
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
                        已生成 {generated}/{fields.length} 项{missing ? ` · 缺 ${missing} 项` : ''}
                      </span>
                      <span className="sany-spacer" />
                      <button type="button" className="sany-link" onClick={() => onNavigate?.('verify')}>查看生成内容 →</button>
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
          公司层内容是<b>集团口径</b>，与各业务单元提交的内容在汇总时会做交叉校验：口径不一致、目标加总与集团目标不符的，会自动标出。
        </Alert>
      </div>
    </section>
  );
}
