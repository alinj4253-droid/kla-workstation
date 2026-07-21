import React, { useCallback, useEffect, useState } from 'react';
import ReactDOM from 'react-dom/client';
import { HashRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { AppRoutes } from './App';
import { WelcomePage } from './pages/WelcomePage';
import './styles.css';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

function BootstrapGate({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [ready, setReady] = useState<'loading' | 'welcome' | 'app'>('loading');

  useEffect(() => {
    window.kunqing!.studio.getStatus()
      .then((result: unknown) => {
        const status = result as { ok: boolean; data: { initialized: boolean } };
        if (status.ok && status.data.initialized) {
          return window.kunqing!.app.ensureStudio().then(() => setReady('app'));
        }
        setReady('welcome');
      })
      .catch(() => setReady('welcome'));
  }, []);

  const handleComplete = useCallback(() => {
    setReady('app');
  }, []);

  if (ready === 'loading') {
    return (
      <div className="welcome-page">
        <div className="welcome-inner">
          <p style={{ color: 'var(--kq-text-tertiary)', fontSize: 14 }}>加载中...</p>
        </div>
      </div>
    );
  }

  if (ready === 'welcome') {
    return <WelcomePage onComplete={handleComplete} />;
  }

  return <>{children}</>;
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <HashRouter>
        <BootstrapGate>
          <AppRoutes />
        </BootstrapGate>
      </HashRouter>
    </QueryClientProvider>
  </React.StrictMode>,
);
