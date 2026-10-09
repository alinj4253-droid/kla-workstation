import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  // Electron 通过 loadFile() 以 file:// 加载 dist/index.html，
  // 必须用相对路径（./assets/...），否则绝对路径会被解析到磁盘根目录导致 404、页面白屏。
  base: './',
  plugins: [react(), tailwindcss()],
  // Apply the same browser target to source, prebundled dependencies and builds.
  // Vite's modern defaults otherwise leave class static blocks in dev dependencies.
  oxc: { target: 'es2020' },
  optimizeDeps: { rolldownOptions: { transform: { target: 'es2020' } } },
  build: { target: 'es2020', outDir: 'dist', emptyOutDir: true },
  server: { port: 5173, strictPort: false },
});
