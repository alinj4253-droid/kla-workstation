#!/usr/bin/env bash
# 环境自检 —— 换一台机器（或换一个智能体）时先跑这个，确认能不能做 PPT。
#
# 用法：
#   bash check_env.sh
#
# 退出码：0 = 核心依赖齐全（可做 PPT）；1 = 缺必需依赖。
#
# 检查项分三档：
#   [必需] bash / node / slidep 引擎 + 引擎冒烟测试
#   [可选] python / Pillow（只影响图片预处理，缺了可跳过）
#   [说明] 平台提示与已知失效项

set -uo pipefail

OK=0; WARN=0; BAD=0
pass(){ printf '  [PASS] %s\n' "$1"; OK=$((OK+1)); }
warn(){ printf '  [WARN] %s\n' "$1"; WARN=$((WARN+1)); }
fail(){ printf '  [FAIL] %s\n' "$1"; BAD=$((BAD+1)); }

echo "=============================================="
echo " pptx-deck-builder 环境自检"
echo " 时间: $(date '+%Y-%m-%d %H:%M:%S')   主机: $(hostname 2>/dev/null)"
echo "=============================================="

# ---------- 1. bash ----------
echo
echo "[1/5] Shell（必需）"
if command -v bash >/dev/null 2>&1; then
  pass "bash $(bash --version 2>/dev/null | head -1 | grep -o -E '[0-9]+\.[0-9]+\.[0-9]+' | head -1)  @ $(command -v bash)"
else
  fail "找不到 bash —— .sh 脚本全部无法运行"
  echo "         修法：装 Git for Windows，或不使用脚本、直接写引擎命令行（见 references/commands.md）"
fi

# ---------- 2. node ----------
echo
echo "[2/5] Node 运行时（必需）"
NODE=""
if [ -n "${SLIDEP_NODE:-}" ] && [ -x "${SLIDEP_NODE}" ]; then
  NODE="$SLIDEP_NODE"
  pass "来自 SLIDEP_NODE：$NODE"
else
  for R in "$HOME"/.workbuddy/binaries/node/versions/*/; do
    [ -d "$R" ] || continue
    for c in "${R%/}/node.exe" "${R%/}/bin/node"; do
      [ -x "$c" ] && NODE="$c" && break 2
    done
  done
  if [ -n "$NODE" ]; then
    pass "托管 Node：$NODE"
  else
    NODE="$(command -v node 2>/dev/null || true)"
    if [ -n "$NODE" ]; then
      warn "只用到了 PATH 上的 node：$NODE"
    else
      fail "找不到 node —— 引擎无法运行"
    fi
  fi
fi
[ -n "$NODE" ] && printf '        版本：%s\n' "$("$NODE" --version 2>/dev/null)"

# ---------- 3. 引擎 ----------
echo
echo "[3/5] slidep 引擎（必需）"
ENGINE=""
if [ -n "${SLIDEP_ENGINE:-}" ] && [ -f "${SLIDEP_ENGINE}" ]; then
  ENGINE="$SLIDEP_ENGINE"
  pass "来自 SLIDEP_ENGINE：$ENGINE"
else
  ROOTS=()
  [ -n "${SLIDEP_NODE_ROOT:-}" ] && ROOTS+=("$SLIDEP_NODE_ROOT")
  for d in "$HOME"/.workbuddy/binaries/node/versions/*/; do
    [ -d "$d" ] && ROOTS+=("${d%/}")
  done
  for R in "${ROOTS[@]:-}"; do
    for c in "$R/lib/node_modules/@tencent/slidep/dist/index.js" \
             "$R/node_modules/@tencent/slidep/dist/index.js"; do
      [ -f "$c" ] && ENGINE="$c" && break 2
    done
  done
  [ -n "$ENGINE" ] && pass "自动定位到引擎：$ENGINE"
fi

if [ -n "$ENGINE" ]; then
  PKG="$(cd "$(dirname "$ENGINE")/.." && pwd)"
  V="$(grep -m1 -o '"version"[^,]*' "$PKG/package.json" 2>/dev/null | grep -o -E '[0-9]+\.[0-9]+\.[0-9]+' | head -1)"
  [ -n "$V" ] && printf '        引擎版本：@tencent/slidep %s\n' "$V"
  if [ -d "$PKG/node_modules" ]; then
    printf '        自带依赖：%s 个包（自包含，无需 npm install）\n' "$(ls "$PKG/node_modules" 2>/dev/null | wc -l | tr -d ' ')"
  else
    warn "引擎目录下没有 node_modules —— 可能不是完整解包"
  fi
  if [ -f "$PKG/dist/resources/pptx/blank.pptx" ]; then
    printf '        空白底版：可用（dist/resources/pptx/blank.pptx）\n'
  else
    warn "缺少 dist/resources/pptx/blank.pptx —— create 命令可能失败"
  fi
  # 主题契约库（参考资料，缺了不影响出 PPT）
  THEMES_DIR_T="$PKG/dist/resources/themes"
  if [ -d "$THEMES_DIR_T" ]; then
    printf '        主题契约库：%s 套（themes.sh list 可查）\n' \
      "$(ls "$THEMES_DIR_T"/*.DESIGN.md 2>/dev/null | wc -l | tr -d ' ')"
  else
    warn "缺少 dist/resources/themes —— themes.sh 不可用（主链路不受影响）"
  fi
else
  fail "找不到 slidep 引擎入口（@tencent/slidep/dist/index.js）"
  echo "         修法见 references/portability.md「引擎从哪来」三条路"
fi

# ---------- 4. 冒烟测试 ----------
echo
echo "[4/5] 引擎冒烟测试（跑一次真实 lint）"
if [ -n "$NODE" ] && [ -n "$ENGINE" ]; then
  PKG="$(cd "$(dirname "$ENGINE")/.." && pwd)"
  TMP="$(mktemp -d 2>/dev/null || echo "${TMPDIR:-/tmp}/slidep-check-$$")"
  mkdir -p "$TMP" 2>/dev/null
  BLANK="$PKG/dist/resources/pptx/blank.pptx"
  if [ -f "$BLANK" ]; then
    cp "$BLANK" "$TMP/smoke.pptx" 2>/dev/null
  else
    "$NODE" "$ENGINE" create "$TMP/smoke.pptx" >/dev/null 2>&1
  fi
  cat > "$TMP/smoke.slide" <<'EOF'
const FONT_CN = '"Microsoft YaHei", "Noto Sans SC", sans-serif';
<Slide style={{ width: 1280, height: 720, background: '#FFFFFF', fontFamily: FONT_CN }}>
    <Box style={{ position: 'absolute', left: 40, top: 40, width: 600, height: 80, flexDirection: 'column' }}>
        <Text style={{ fontSize: 24, color: '#111111', height: 34 }}>环境自检 smoke test</Text>
    </Box>
</Slide>
EOF
  if [ -f "$TMP/smoke.pptx" ]; then
    RES="$(cd "$TMP" && "$NODE" "$ENGINE" lint "smoke.pptx" --dsl-file "smoke.slide" 2>/dev/null | grep '^{' | head -1)"
    if printf '%s' "$RES" | grep -q '"ok":true'; then
      pass "lint 正常返回 ok:true"
      printf '        %s\n' "$RES"
    elif [ -n "$RES" ]; then
      warn "lint 有输出但不是 ok:true：$RES"
    else
      fail "lint 无任何 JSON 输出 —— 引擎无法执行"
    fi
  else
    fail "无法创建测试用 pptx（create 失败或底版不可用）"
  fi
  rm -rf "$TMP" 2>/dev/null
else
  warn "跳过（node 或引擎缺失）"
fi

# ---------- 5. Python（可选） ----------
echo
echo "[5/5] Python + Pillow（可选，仅图片预处理用）"
PY=""
for c in "$HOME"/.workbuddy/binaries/python/envs/*/Scripts/python.exe \
         "$HOME"/.workbuddy/binaries/python/envs/*/bin/python \
         "$HOME"/.workbuddy/binaries/python/versions/*/python.exe \
         "$HOME"/.workbuddy/binaries/python/versions/*/bin/python; do
  [ -x "$c" ] && PY="$c" && break
done
if [ -z "$PY" ]; then
  PY="$(command -v python3 2>/dev/null || command -v python 2>/dev/null || true)"
fi
if [ -n "$PY" ]; then
  if "$PY" -c "import PIL" >/dev/null 2>&1; then
    pass "Python + Pillow 可用：$PY"
    printf '        Pillow 版本：%s\n' "$("$PY" -c "import PIL;print(PIL.__version__)" 2>/dev/null)"
  else
    warn "有 Python 但没有 Pillow：$PY"
    echo "         影响：prep_images.py（裁水印 / 切横带）不可用；不影响出 PPT"
  fi
  printf '        注意：Windows 下 venv 的解释器在 Scripts/ 不是 bin/\n'
else
  warn "没有 Python —— prep_images.py 不可用，其余流程不受影响"
fi

# ---------- 汇总 ----------
echo
echo "=============================================="
printf ' 结果：PASS %s / WARN %s / FAIL %s\n' "$OK" "$WARN" "$BAD"
if [ "$BAD" -gt 0 ]; then
  echo " 核心依赖不齐，先按上面的修法补齐；详见 references/portability.md"
  echo "=============================================="
  exit 1
fi
echo " 核心依赖齐全，可以开始做 PPT。"
echo "=============================================="

# ---------- 已知限制（说明，不计入结果） ----------
echo
echo "已知失效项（与机器无关，不必排查）："
echo "  · screenshot / lint --visual 不可用 —— 引擎内写死一条 Linux CI 构建路径，"
echo "    且依赖包 docs-slide-view-sdk-node 未随发布件安装 → 无法修复。视觉把关只能靠人。"
echo "  · 绝不使用 slidep / slidep.cmd / slidep.ps1 这三个 shim（会误报 exit 69），"
echo "    统一用 scripts/slidep.sh。"
exit 0
