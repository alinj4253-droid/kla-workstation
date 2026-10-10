import { useEffect, useState } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { KnowledgePage } from '../features/knowledge/KnowledgePage';
import '../features/knowledge/tokens.css';
export function KnowledgeSection() {
  const [client] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: false, refetchOnWindowFocus: true } } }));
  useEffect(() => {
    const clear = () => client.clear();
    window.addEventListener('kla:session-changed', clear);
    window.addEventListener('kla:auth-expired', clear);
    return () => { window.removeEventListener('kla:session-changed', clear); window.removeEventListener('kla:auth-expired', clear); client.clear(); };
  }, [client]);
  return <QueryClientProvider client={client}><MemoryRouter initialEntries={['/knowledge']}><Routes>
    <Route path="/knowledge" element={<KnowledgePage />} />
    <Route path="/knowledge/uploads" element={<KnowledgePage view="uploads" />} />
    <Route path="/knowledge/bases/:id" element={<KnowledgePage view="detail" />} />
  </Routes></MemoryRouter></QueryClientProvider>;
}
