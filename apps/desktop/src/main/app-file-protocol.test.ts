// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { parseAppFileRequest } from './app-file-protocol';

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/mock/app/path') },
  protocol: { handle: vi.fn() },
}));

describe('app-file preview URL', () => {
  it('parses the host-based file URL used by Electron previews', () => {
    expect(parseAppFileRequest('app-file://file/1234567890abcdef12345678')).toEqual({
      resourceType: 'file',
      resourceId: '1234567890abcdef12345678',
      assetPath: '',
    });
  });

  it('keeps relative assets inside the selected HTML preview', () => {
    expect(parseAppFileRequest('app-file://preview/1234567890abcdef12345678/assets/app.css')).toEqual({
      resourceType: 'preview',
      resourceId: '1234567890abcdef12345678',
      assetPath: 'assets/app.css',
    });
  });
});
