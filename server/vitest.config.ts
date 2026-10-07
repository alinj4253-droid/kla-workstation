import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // 只跑 src 下的源码测试，避免 vitest 拾取 dist 里的编译产物测试
    exclude: ['**/node_modules/**', 'dist/**'],
  },
});
