import { Key, X } from 'lucide-react';
import { FormEvent, useState } from 'react';

export const OPERATION_PLATFORM_SESSION_KEY = 'kunqing.operationPlatformAccess';
export const ENTERPRISE_PROJECT_SESSION_KEY = 'kunqing.enterpriseProjectAccess';

type OperationsAccessDialogProps = {
  description: string;
  onClose: () => void;
  onVerified: () => void;
};

export function OperationsAccessDialog({ description, onClose, onVerified }: OperationsAccessDialogProps): React.JSX.Element {
  const [accessKey, setAccessKey] = useState('');
  const [error, setError] = useState('');

  const verify = (event: FormEvent): void => {
    event.preventDefault();
    const result = window.kunqing?.app
      ? window.kunqing.app.verifyOperationsAccess({ key: accessKey }).then((res) => {
        const data = res as { ok?: boolean; data?: { granted?: boolean } } | undefined;
        if (data?.data?.granted) onVerified();
        else setError('运维权限密钥错误');
      })
      : Promise.resolve();
    void result;
  };

  return (
    <div className="modal-backdrop modal-backdrop--nested" role="presentation" onMouseDown={(event) => event.target === event.currentTarget && onClose()}>
      <form className="operations-login-dialog" role="dialog" aria-modal="true" aria-labelledby="operations-access-title" onSubmit={verify}>
        <button type="button" className="icon-button operations-login-dialog__close" aria-label="关闭" onClick={onClose}><X size={18} /></button>
        <span className="operations-login-dialog__icon"><Key size={22} /></span>
        <h2 id="operations-access-title">运维权限验证</h2>
        <p>{description}</p>
        <label>
          <span>运维权限密钥</span>
          <input autoFocus type="password" value={accessKey} onChange={(event) => { setAccessKey(event.target.value); setError(''); }} placeholder="请输入密钥" />
          {error && <small>{error}</small>}
        </label>
        <button type="submit" className="primary-button">验证并进入</button>
      </form>
    </div>
  );
}
