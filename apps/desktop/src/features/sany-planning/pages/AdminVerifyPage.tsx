import { PrefillBoard } from '../PrefillBoard';
import { useSanyData } from '../SanyDataContext';
import { COMPANY_MODULES } from '../mock';
import type { SanyView } from '../SanyPlanningSection';

type Props = { onNavigate?: (view: SanyView) => void };

export function AdminVerifyPage({ onNavigate }: Props): React.JSX.Element {
  const { data } = useSanyData();
  const fields = data.fields.filter(field => field.scope === 'company');
  const docCount = (key: (typeof COMPANY_MODULES)[number]['k']) =>
    data.documents.filter(document => document.scope === 'company' && document.moduleKey === key).length;

  return (
    <PrefillBoard
      scope="company"
      title="校验公司层内容"
      subtitle="集团口径的四模块初稿，逐项确认或修正；预设项不适用的可标记不适用"
      modules={COMPANY_MODULES}
      fields={fields}
      docCount={docCount}
      onGoUpload={() => onNavigate?.('company')}
      onFinish={() => onNavigate?.('review')}
      finishLabel="去合并汇总"
    />
  );
}
