import { useCallback, useState } from 'react';
import { Sparkles, FolderPlus, FolderOpen, Loader2, AlertCircle, ShieldCheck } from 'lucide-react';

interface WelcomePageProps {
  onComplete: () => void;
}

function PrivacyNotice({ onAccept }: { onAccept: () => void }): React.JSX.Element {
  return (
    <div className="welcome-inner">
      <div className="welcome-brand">
        <span className="welcome-brand-mark"><ShieldCheck size={32} strokeWidth={2.2} /></span>
        <h1>欢迎使用鲲擎平台</h1>
        <p>K_Studio — 多智能体协作工作台</p>
      </div>

      <div className="privacy-notice">
        <h3>数据说明</h3>
        <ul>
          <li><strong>本地优先：</strong>所有工作区数据存储在您选择的本地目录中，应用不会自动上传数据到云端。</li>
          <li><strong>模型调用：</strong>AI 模型通过您自行配置的 API Key 调用，密钥仅本地加密存储。</li>
          <li><strong>日志：</strong>运行日志仅用于调试和错误排查，存储在本地工作区目录中。</li>
          <li><strong>崩溃报告：</strong>应用崩溃时不会自动收集或上传任何诊断信息。</li>
          <li><strong>第三方服务：</strong>如您配置渠道（飞书、Telegram 等），消息将通过对应服务的 API 转发。</li>
        </ul>
        <p className="privacy-footnote">首次启动后不再显示此说明，您可在设置中重新查看。</p>
      </div>

      <button className="welcome-card privacy-accept-btn" type="button" onClick={onAccept}>
        <ShieldCheck size={24} />
        <strong>同意并继续</strong>
        <span>我已阅读并理解以上数据说明</span>
      </button>
    </div>
  );
}

export function WelcomePage({ onComplete }: WelcomePageProps): React.JSX.Element {
  const [step, setStep] = useState<'privacy' | 'main'>(() => {
    return localStorage.getItem('kq_privacy_accepted') ? 'main' : 'privacy';
  });
  const [busy, setBusy] = useState<'init' | 'open' | null>(null);
  const [error, setError] = useState('');

  const handleAcceptPrivacy = useCallback(() => {
    localStorage.setItem('kq_privacy_accepted', 'true');
    setStep('main');
  }, []);

  const handleInitialize = useCallback(async () => {
    if (!window.kunqing?.studio) {
      setError('应用环境未就绪，请重启应用');
      return;
    }
    setBusy('init');
    setError('');
    try {
      const result = await window.kunqing.studio.chooseAndInitialize() as { ok: boolean; data: { workspaceId: string; rootPath: string } | null; error?: { code: string; message: string } };
      if (result.ok && result.data) {
        await window.kunqing!.app.ensureStudio();
        onComplete();
      } else if (!result.ok) {
        setError(result.error?.message || '操作失败');
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  }, [onComplete]);

  const handleOpenExisting = useCallback(async () => {
    if (!window.kunqing?.studio) {
      setError('应用环境未就绪，请重启应用');
      return;
    }
    setBusy('open');
    setError('');
    try {
      const result = await window.kunqing.studio.chooseAndOpenExisting() as { ok: boolean; data: { workspaceId: string; rootPath: string } | null; error?: { code: string; message: string } };
      if (result.ok && result.data) {
        const ensureResult = await window.kunqing!.app.ensureStudio() as { ok: boolean } | undefined;
        if (ensureResult && !ensureResult.ok) {
          setError('工作区初始化失败，请检查目录是否正确');
          return;
        }
        onComplete();
      } else if (!result.ok) {
        setError(result.error?.message || '操作失败');
      }
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  }, [onComplete]);

  if (step === 'privacy') {
    return (
      <div className="welcome-page">
        <PrivacyNotice onAccept={handleAcceptPrivacy} />
      </div>
    );
  }

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
