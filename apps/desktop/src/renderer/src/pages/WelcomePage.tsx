import { useCallback, useState } from 'react';
import { Sparkles, FolderPlus, FolderOpen, Loader2, AlertCircle } from 'lucide-react';

interface WelcomePageProps {
  onComplete: () => void;
}

export function WelcomePage({ onComplete }: WelcomePageProps): React.JSX.Element {
  const [busy, setBusy] = useState<'init' | 'open' | null>(null);
  const [error, setError] = useState('');

  const handleInitialize = useCallback(async () => {
    setBusy('init');
    setError('');
    try {
      const result = await window.kunqing!.studio.chooseAndInitialize() as { ok: boolean; data: { workspaceId: string; rootPath: string } | null };
      if (result.ok && result.data) {
        await window.kunqing!.app.ensureStudio();
        onComplete();
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  }, [onComplete]);

  const handleOpenExisting = useCallback(async () => {
    setBusy('open');
    setError('');
    try {
      const result = await window.kunqing!.studio.chooseAndOpenExisting() as { ok: boolean; data: { workspaceId: string; rootPath: string } | null };
      if (result.ok && result.data) {
        await window.kunqing!.app.ensureStudio();
        onComplete();
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  }, [onComplete]);

  return (
    <div className="welcome-page">
      <div className="welcome-inner">
        <div className="welcome-brand">
          <span className="welcome-brand-mark"><Sparkles size={32} strokeWidth={2.2} /></span>
          <h1>鲲擎平台</h1>
          <p>K_Studio — 多智能体协作工作台</p>
        </div>

        <div className="welcome-cards">
          <button className="welcome-card" type="button" onClick={handleInitialize} disabled={busy !== null}>
            {busy === 'init' ? <Loader2 size={24} className="spin" /> : <FolderPlus size={24} />}
            <strong>创建新的 K_Studio</strong>
            <span>选择一个空目录，自动初始化工作区和内置 Agent 定义</span>
          </button>

          <button className="welcome-card" type="button" onClick={handleOpenExisting} disabled={busy !== null}>
            {busy === 'open' ? <Loader2 size={24} className="spin" /> : <FolderOpen size={24} />}
            <strong>打开已有的 K_Studio</strong>
            <span>选择已包含 workspace.json 的 K_Studio 目录</span>
          </button>
        </div>

        {error && (
          <div className="welcome-error">
            <AlertCircle size={16} />
            <span>{error}</span>
          </div>
        )}

        <p className="welcome-footer-hint">首次使用请选择「创建新的 K_Studio」开始</p>
      </div>
    </div>
  );
}
