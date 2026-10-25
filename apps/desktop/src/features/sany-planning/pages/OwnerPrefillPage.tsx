import { PrefillBoard } from '../PrefillBoard';
import { useSanyData } from '../SanyDataContext';
import { MODULES } from '../mock';
import type { SanyView } from '../SanyPlanningSection';

type Props = { onNavigate?: (view: SanyView) => void };

export function OwnerPrefillPage({ onNavigate }: Props): React.JSX.Element {
  const { data, ownerTask, ownerTasks, setOwnerTaskId } = useSanyData();
  const fields = data.fields.filter(field => field.scope === 'unit' && field.taskId === (ownerTask?.id ?? ''));
  const docCount = (key: (typeof MODULES)[number]['k']) =>
    data.documents.filter(document => document.scope === 'unit' && document.moduleKey === key && document.taskId === (ownerTask?.id ?? null)).length;

  return (
    <>
      {ownerTasks.length > 1 ? (
        <div className="sany-taskbar">
          <span className="sany-taskbar__l">当前任务</span>
          <select className="sany-sel sany-taskbar__grow" value={ownerTask?.id ?? ''} onChange={event => setOwnerTaskId(event.target.value)}>
            {ownerTasks.map(item => <option key={item.id} value={item.id}>{item.code} · {item.title}</option>)}
          </select>
          <span className="sany-taskbar__t">{ownerTask?.unit}</span>
        </div>
      ) : null}
      <PrefillBoard
        scope="owner"
        title="内容校验"
        subtitle="系统已根据材料生成四模块初稿，逐项确认、修改或驳回；确认后的内容才会进入正文结论"
        modules={MODULES}
        fields={fields}
        taskId={ownerTask?.id ?? null}
        docCount={docCount}
        onGoUpload={() => onNavigate?.('docs')}
        onFinish={() => onNavigate?.('gaps')}
        finishLabel="查看缺口"
      />
    </>
  );
}
