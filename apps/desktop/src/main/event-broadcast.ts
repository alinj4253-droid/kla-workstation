import { BrowserWindow } from 'electron';

/**
 * 将事件发送到主窗口，并补发给其余未销毁的渲染窗口。
 * 事件自身携带 projectId，由渲染端按当前项目过滤；
 * 多窗口场景下所有窗口都能实时收到各自项目的消息与运行状态。
 * 对未提供 getAllWindows 的测试 mock 环境安全降级为仅发送主窗口。
 */
export function broadcastEvent(primaryWindow: BrowserWindow, payload: unknown): void {
  if (!primaryWindow.isDestroyed()) {
    try {
      primaryWindow.webContents.send('event:dispatch', payload);
    } catch {
      // 窗口可能在发送瞬间被关闭
    }
  }
  const others = typeof BrowserWindow.getAllWindows === 'function'
    ? BrowserWindow.getAllWindows()
    : [];
  for (const window of others) {
    if (window === primaryWindow || window.isDestroyed()) continue;
    try {
      window.webContents.send('event:dispatch', payload);
    } catch {
      // 窗口可能在发送瞬间被关闭
    }
  }
}
