import { Navigate, Route, Routes } from 'react-router-dom';
import { AppShell } from './components/AppShell';
import { ChatPage } from './pages/ChatPage';
import { HomePage } from './pages/HomePage';
import { OperationPlatformsPage } from './pages/OperationPlatformsPage';
import { EnterpriseProjectsPage } from './pages/EnterpriseProjectsPage';
import { SettingsPage } from './pages/SettingsPage';
import { WorkspacePage } from './pages/WorkspacePage';
import { MeetingsPage } from './pages/MeetingsPage';

export function AppRoutes(): React.JSX.Element {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<HomePage />} />
        <Route path="operations" element={<OperationPlatformsPage />} />
        <Route path="meetings" element={<MeetingsPage />} />
        <Route path="enterprise-projects" element={<EnterpriseProjectsPage />} />
        <Route path="projects/:projectId/chat" element={<ChatPage />} />
        <Route path="projects/:projectId/workspace" element={<WorkspacePage />} />
        <Route path="settings/*" element={<SettingsPage />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
