import { PrefillBoard } from '../PrefillBoard';
import { useSanyData } from '../SanyDataContext';
import { MODULES } from '../mock';
import type { SanyView } from '../SanyPlanningSection';

type Props = { onNavigate?: (view: SanyView) => void };

export function OwnerPrefillPage({ onNavigate }: Props): React.JSX.Element {
  const { data } = useSanyData();
  const fields = data.fields.filter(field => field.scope === 'unit');
  const docCount = (key: (typeof MODULES)[number]['k']) =>
    data.documents.filter(document => document.scope === 'unit' && document.moduleKey === key).length;

  return (
    <PrefillBoard
      scope="owner"
      title="内容校验"
      subtitle="系统已根据材料生成四模块初稿，逐项确认、修改或驳回；确认后的内容才会进入正文结论"
      modules={MODULES}
      fields={fields}
      taskId={data.tasks[0]?.id ?? null}
      docCount={docCount}
      onGoUpload={() => onNavigate?.('docs')}
      onFinish={() => onNavigate?.('gaps')}
      finishLabel="查看缺口"
    />
  );
}
