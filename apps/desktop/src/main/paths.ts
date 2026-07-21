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
