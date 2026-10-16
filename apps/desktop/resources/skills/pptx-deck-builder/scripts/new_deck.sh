#!/usr/bin/env bash
# 初始化一个新 deck 的项目骨架（复制模板 + 建目录）。
#
# 用法：
#   bash new_deck.sh "<目标目录>" [deck名]
# 例：
#   bash new_deck.sh "C:/Users/Administrator/WorkBuddy/demo/我的演示" "我的演示"

set -euo pipefail

TARGET="${1:-}"
if [ -z "$TARGET" ]; then
  echo "用法: new_deck.sh <目标目录> [deck名]"
  exit 1
fi
NAME="${2:-$(basename "$TARGET")}"

SELF_DIR="$(cd "$(dirname "$0")" && pwd)"
TPL="$SELF_DIR/../assets"

mkdir -p "$TARGET/slides" "$TARGET/assets"

[ -f "$TARGET/STORY.md" ]          || cp "$TPL/STORY.template.md"    "$TARGET/STORY.md"
[ -f "$TARGET/DESIGN.md" ]         || cp "$TPL/DESIGN.template.md"   "$TARGET/DESIGN.md"
[ -f "$TARGET/slides/01.slide" ]   || cp "$TPL/slide-cover.slide"    "$TARGET/slides/01.slide"
[ -f "$TARGET/slides/02.slide" ]   || cp "$TPL/slide-content.slide"  "$TARGET/slides/02.slide"

echo "已创建项目骨架: $TARGET"
find "$TARGET" -type f | sed "s|$TARGET/|  |"
echo
echo "下一步："
echo "  1. 编辑 STORY.md（叙事线）与 DESIGN.md（设计常量）—— 两份都必须在动手前锁死"
echo "  2. 生成/准备图片放入 assets/（英文短名，禁止中文与空格）"
echo "  3. 按 assets/ 的两个骨架逐页写 slides/NN.slide（每页第一个 <Text> 前先想好 height）"
echo "  4. 全量构建： bash $SELF_DIR/build_deck.sh \"$TARGET/$NAME.pptx\" \"$TARGET/slides\" --append"
