import { app } from 'electron';
import { join } from 'node:path';

let _studioRootOverride = '';

export const getStudioRoot = (): string => _studioRootOverride || join(app.getPath('documents'), 'K_Studio');
export const setStudioRoot = (root: string): void => { _studioRootOverride = root; };

const assertProjectId = (projectId: string): string => {
  if (!/^[a-z0-9-]{1,64}$/i.test(projectId)) throw new Error('群聊标识不合法');
  return projectId;
};

export const getProjectRoot = (projectId: string): string => join(getStudioRoot(), 'group-chats', `${assertProjectId(projectId)}-workspace`);

/** User-visible intermediate artifacts for a group chat.  The run directory
 * is intentionally derived from the system-owned root Run ID so every task
 * gets an isolated, inspectable folder without allowing the model to choose a
 * filesystem path. */
export const getProjectTempRoot = (projectId: string): string => join(getProjectRoot(projectId), 'temp');

export const getProjectTempRunRoot = (projectId: string, rootRunId: string): string => {
  if (!/^[a-zA-Z0-9_-]{1,128}$/.test(rootRunId)) throw new Error('任务标识不合法');
  return join(getProjectTempRoot(projectId), rootRunId);
};

/** Enterprise projects own a workspace independently from their linked groups. */
export const getEnterpriseProjectRoot = (projectId: string): string => join(getStudioRoot(), 'projects', assertProjectId(projectId));

/** Keep the existing on-disk enterprise knowledge directory compatible. */
export const getEnterpriseWorkspaceRoot = (): string => join(getStudioRoot(), 'shared-knowledge');

export const getMeetingRoot = (meetingId: string): string => join(getStudioRoot(), 'meetings', `${assertProjectId(meetingId)}-workspace`);
