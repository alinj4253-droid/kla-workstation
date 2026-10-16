#!/usr/bin/env bash
# 主题契约库浏览器 —— 薄封装，实体逻辑在 themes.py（只依赖 Python 标准库）。
#
# 用法：
#   bash themes.sh dir                          打印主题库绝对路径
#   bash themes.sh list                         列出 30 套（编号 / 名称 / 主色 / 分类）
#   bash themes.sh search <关键词>               按名称/描述/受众检索
#   bash themes.sh show   <编号|关键词> [节名]    打印完整契约；给节名则只打该节
#   bash themes.sh palette <编号|关键词>         输出可直接粘进 .slide「主题区」的常量块
#
# 覆盖：
#   THEMES_PYTHON  指定 Python 解释器
#   THEMES_DIR     直接指定主题库目录
#   SLIDEP_ENGINE / SLIDEP_NODE_ROOT  由引擎路径反推主题库

set -uo pipefail

SELF_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PY_SCRIPT="$SELF_DIR/themes.py"

if [ ! -f "$PY_SCRIPT" ]; then
  echo "[themes.sh] 找不到 $PY_SCRIPT" >&2
  exit 1
fi

# ── 找 Python（只要标准库，裸解释器就够用）─────────────────────────────
PY="${THEMES_PYTHON:-}"
if [ -z "$PY" ]; then
  for c in \
    "$HOME"/.workbuddy/binaries/python/envs/*/Scripts/python.exe \
    "$HOME"/.workbuddy/binaries/python/envs/*/bin/python \
    "$HOME"/.workbuddy/binaries/python/versions/*/python.exe \
    "$HOME"/.workbuddy/binaries/python/versions/*/bin/python; do
    [ -x "$c" ] && { PY="$c"; break; }
  done
fi
if [ -z "$PY" ]; then
  PY="$(command -v python3 2>/dev/null || command -v python 2>/dev/null || true)"
fi
if [ -z "$PY" ]; then
  echo "[themes.sh] 找不到 Python 解释器。用 THEMES_PYTHON=<python 路径> 指定。" >&2
  echo "  说明：主题库浏览是**可选便利功能**，不影响 PPT 主链路（写版式 → lint → 写入）。" >&2
  echo "  不用脚本时，直接翻目录也行：<Node根>/lib/node_modules/@tencent/slidep/dist/resources/themes/" >&2
  exit 1
fi

exec "$PY" "$PY_SCRIPT" "$@"
