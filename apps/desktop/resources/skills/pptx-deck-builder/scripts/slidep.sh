#!/usr/bin/env bash
# slidep 引擎直调封装 —— 绕过 shim 的「引擎尚未就绪」(exit 69) 问题。
#
# 为什么需要它：node/versions/<ver>/ 下的 slidep / slidep.cmd / slidep.ps1 会去
# node_modules/ 找包，而包实际装在 lib/node_modules/，路径差一层 → 永远报错。
# 本脚本直接定位 dist/index.js 并用 node 调用，稳定可用。
#
# 用法：
#   bash slidep.sh create     "<deck>.pptx"
#   bash slidep.sh lint       "<deck>.pptx" --dsl-file slides/07.slide
#   bash slidep.sh upsert-dsl "<deck>.pptx" --dsl-file slides/07.slide [--page-index N]
#
# 路径覆盖（换机器时用）：
#   SLIDEP_ENGINE    直接指定引擎入口 dist/index.js 的绝对路径（优先级最高）
#   SLIDEP_NODE      直接指定 node 可执行文件
#   SLIDEP_NODE_ROOT 指定 Node 安装根目录，脚本在其中找 lib/node_modules/@tencent/slidep
# 不设任何变量时，脚本会自动扫 ~/.workbuddy/binaries/node/versions/* 取第一个可用组合。

set -uo pipefail

find_engine_in_root() {
  local root="$1"
  [ -n "$root" ] || return 1
  local c
  for c in \
    "$root/lib/node_modules/@tencent/slidep/dist/index.js" \
    "$root/node_modules/@tencent/slidep/dist/index.js"; do
    [ -f "$c" ] && { printf '%s\n' "$c"; return 0; }
  done
  return 1
}

find_node_in_root() {
  local root="$1"
  [ -n "$root" ] || return 1
  local c
  for c in "$root/node.exe" "$root/bin/node" "$root/node"; do
    [ -x "$c" ] && { printf '%s\n' "$c"; return 0; }
  done
  return 1
}

NODE=""
ENGINE=""

# 1) 显式指定引擎时，用它
if [ -n "${SLIDEP_ENGINE:-}" ]; then
  [ -f "$SLIDEP_ENGINE" ] || { echo "[slidep.sh] SLIDEP_ENGINE 指向的文件不存在：$SLIDEP_ENGINE" >&2; exit 1; }
  ENGINE="$SLIDEP_ENGINE"
fi

# 2) 候选 Node 根目录（按优先级）
ROOTS=()
[ -n "${SLIDEP_NODE_ROOT:-}" ] && ROOTS+=("$SLIDEP_NODE_ROOT")
for d in "$HOME"/.workbuddy/binaries/node/versions/*/; do
  [ -d "$d" ] && ROOTS+=("${d%/}")
done
ROOTS+=("/c/Program Files/nodejs" "/usr/local" "/usr")

for R in "${ROOTS[@]}"; do
  if [ -z "$ENGINE" ]; then
    ENGINE="$(find_engine_in_root "$R")" || ENGINE=""
  fi
  if [ -z "$NODE" ]; then
    NODE="$(find_node_in_root "$R")" || NODE=""
  fi
  [ -n "$ENGINE" ] && [ -n "$NODE" ] && break
done

# 3) 兜底：PATH 上的 node
if [ -z "$NODE" ]; then
  NODE="$(command -v node 2>/dev/null || true)"
fi
if [ -n "${SLIDEP_NODE:-}" ]; then
  [ -x "$SLIDEP_NODE" ] || { echo "[slidep.sh] SLIDEP_NODE 不可执行：$SLIDEP_NODE" >&2; exit 1; }
  NODE="$SLIDEP_NODE"
fi

if [ -z "$ENGINE" ]; then
  echo "[slidep.sh] 找不到 slidep 引擎入口（@tencent/slidep/dist/index.js）。" >&2
  echo "  已扫描的 Node 根目录：${ROOTS[*]}" >&2
  echo "  修法：装好引擎后设 SLIDEP_ENGINE=<...>/@tencent/slidep/dist/index.js" >&2
  echo "  详见 references/portability.md" >&2
  exit 1
fi
if [ -z "$NODE" ]; then
  echo "[slidep.sh] 找不到 node 可执行文件。用 SLIDEP_NODE=<node 路径> 指定。" >&2
  exit 1
fi

exec "$NODE" "$ENGINE" "$@"
