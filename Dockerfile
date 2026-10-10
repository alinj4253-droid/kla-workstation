# KLA Workstation 服务端生产镜像。
# 构建上下文必须为仓库根目录：docker build -t kla-server .

# syntax=docker/dockerfile:1
FROM node:22-alpine AS build
WORKDIR /repo
# 固定 pnpm@10.11：其 store 索引不使用 SQLite（pnpm 10.12+ 的 SQLite store 在
# 部分 CentOS/老内核文件系统上必报 disk I/O error）；仓库锁文件为
# lockfileVersion 9.0，与该版本兼容。packageManager 字段指向 11.9.0：
# package-manager-strict=false 跳过版本校验；manage-package-manager-versions=false
# 禁止 pnpm 自动下载并切换到 11.9.0（默认开启，切换写入 PNPM_HOME 即
# /root/.local/share/pnpm，与下方 store 缓存卷相邻，BuildKit cache mount 下触发 EPERM）。
RUN npm install -g pnpm@10.11.0
ENV npm_config_package_manager_strict=false
ENV npm_config_manage_package_manager_versions=false
# copy 导入替代硬链接：目标主机存储层对 store↔node_modules 的硬链接 +
# chmod 收尾操作兼容性差（SQLite store 曾在其上必报 disk I/O error），
# 收尾阶段触发 EPERM write，copy 方式绕开该路径。
ENV npm_config_package_import_method=copy
COPY pnpm-workspace.yaml pnpm-lock.yaml package.json ./
COPY packages/contracts/package.json packages/contracts/package.json
COPY server/package.json server/package.json
# 【临时排障】基础文件操作探针：在构建真实文件系统上逐项验证 fd 写入、
# chmod 444 后重写、rename、硬链接、symlink、unlink。任一步失败会直接
# 打印失败的 syscall 与路径。定位 EPERM 来源后删除本步。
RUN node -e "const fs=require('fs');for(const d of ['/tmp','/root','/repo']){fs.mkdirSync(d,{recursive:true});const p=d+'/pnpm-probe';const fd=fs.openSync(p,'w');fs.writeSync(fd,'x');fs.closeSync(fd);fs.chmodSync(p,0o444);fs.writeFileSync(p,'y');fs.renameSync(p,p+'.2');fs.linkSync(p+'.2',p+'.3');fs.symlinkSync(p+'.3',p+'.4');fs.unlinkSync(p+'.2');fs.unlinkSync(p+'.3');fs.unlinkSync(p+'.4');console.log('FS-PROBE PASS',d)}"
# 不使用 BuildKit cache mount：目标主机的缓存卷挂载同样触发 EPERM；
# 依赖未变时本层直接命中层缓存。--ignore-scripts：镜像内不执行依赖
# 构建脚本，esbuild 二进制随可选依赖预编译分发，无需 postinstall 校验。
# 【临时排障】ndjson 重定向：失败时输出完整 JSON 错误（含调用栈与路径），定位后还原。
RUN pnpm install --frozen-lockfile --ignore-scripts --loglevel debug --reporter=ndjson > /tmp/install.log 2>&1 \
  || { tail -n 30 /tmp/install.log ; echo '--- 以上为 pnpm 完整错误 JSON ---' ; exit 1 ; }
COPY packages/contracts packages/contracts
COPY server server
RUN pnpm --filter @kla-workstation/contracts build \
  && pnpm --filter @kla-workstation/server build \
  && pnpm --filter @kla-workstation/server deploy --prod /out \
  && test -f /out/dist/server.js \
  && test -d /out/migrations

FROM node:22-alpine
ENV NODE_ENV=production
ENV HOST=0.0.0.0
WORKDIR /app
COPY --from=build /out /app
EXPOSE 8787
USER node
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8787)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist/server.js"]
