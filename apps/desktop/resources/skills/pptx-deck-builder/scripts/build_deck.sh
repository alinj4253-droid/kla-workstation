#!/usr/bin/env bash
# 逐页校验 + 通过才写入 —— lint 门禁的批量封装。
#
# 用法：
#   bash build_deck.sh "<deck>.pptx" [slides目录]          # 默认 slides，按文件名数字替换对应页
#   bash build_deck.sh "<deck>.pptx" slides --append       # 强制追加（首次构建）
#
# 规则：文件名形如 01.slide / 07.slide 的，写入时自动推导 page-index（0 基）= 数字 - 1，
#       即「替换该页」；文件名不含数字的，走追加。
# lint 不通过（"ok": false）的页会被跳过并列入未通过清单，绝不写入。

set -uo pipefail

DECK="${1:-}"
DIR="${2:-slides}"
MODE="${3:-replace}"

if [ -z "$DECK" ]; then
  echo "用法: build_deck.sh <deck.pptx> [slides目录] [--append]"
  exit 1
fi

SELF_DIR="$(cd "$(dirname "$0")" && pwd)"
SLIDEP="$SELF_DIR/slidep.sh"

# 关键：.slide 里的 src='assets/xxx.png' 是相对「项目根」解析的，
# 所以必须切到 deck 所在目录再调用引擎。先把 slides 目录解析成绝对路径。
DECK_DIR="$(cd "$(dirname "$DECK")" && pwd)" || { echo "[build] 找不到 deck 所在目录"; exit 1; }
DIR_ABS="$(cd "$DIR" 2>/dev/null && pwd)" || { echo "[build] 找不到 slides 目录：$DIR"; exit 1; }
cd "$DECK_DIR"
DECK="$(basename "$DECK")"
DIR="$DIR_ABS"

if [ ! -f "$DECK" ]; then
  echo "[build] 目标不存在，先创建空白文件：$DECK"
  bash "$SLIDEP" create "$DECK" || exit 1
fi

ok=0
fail=0
failed=()

for f in "$DIR"/*.slide; do
  [ -e "$f" ] || { echo "[build] $DIR 下没有 .slide 文件"; exit 1; }

  result="$(bash "$SLIDEP" lint "$DECK" --dsl-file "$f" 2>/dev/null | grep '^{' || true)"

  if echo "$result" | grep -q '"ok":true'; then
    base="$(basename "$f" .slide)"
    if [ "$MODE" != "--append" ] && [[ "$base" =~ ^[0-9]+$ ]]; then
      idx=$(( 10#$base - 1 ))
      if bash "$SLIDEP" upsert-dsl "$DECK" --dsl-file "$f" --page-index "$idx" >/dev/null 2>&1; then
        echo "OK    $f  -> page-index $idx"
        ok=$((ok + 1))
      else
        echo "ERR   $f  写入失败"
        fail=$((fail + 1)); failed+=("$f")
      fi
    else
      if bash "$SLIDEP" upsert-dsl "$DECK" --dsl-file "$f" >/dev/null 2>&1; then
        echo "OK    $f  -> append"
        ok=$((ok + 1))
      else
        echo "ERR   $f  写入失败"
        fail=$((fail + 1)); failed+=("$f")
      fi
    fi
  else
    echo "FAIL  $f"
    [ -n "$result" ] && echo "        $result"
    fail=$((fail + 1)); failed+=("$f")
  fi
done

echo "----------------------------------------"
echo "通过 $ok 页 / 未通过 $fail 页"
if [ "$fail" -gt 0 ]; then
  printf '未通过: %s\n' "${failed[*]}"
  echo "（未通过的页没有写入 pptx。按 references/lint-troubleshooting.md 修完再重跑本脚本）"
  exit 1
fi
echo "全部通过，已写入 $DECK"
