# 命令行速查

> 前置：**不要用 `slidep` shim**（会误报引擎未就绪，exit 69）。用 `scripts/slidep.sh`，或直接：

```bash
NODE="C:/Users/Administrator/.workbuddy/binaries/node/versions/22.22.2-6/node.exe"
ENGINE="C:/Users/Administrator/.workbuddy/binaries/node/versions/22.22.2-6/lib/node_modules/@tencent/slidep/dist/index.js"
"$NODE" "$ENGINE" <子命令> [参数]
```

## 三条实用命令

### create — 建空白 pptx

```bash
slidep.sh create "<deck>.pptx"
```
只有第一次需要。重复执行会报文件已存在（无副作用）。

### lint — 校验单页布局（门禁）

```bash
slidep.sh lint "<deck>.pptx" --dsl-file slides/07.slide
```

**返回 JSON，关键字段 `ok`**：

```json
{"ok": true, "diagnostics": []}
```
```json
{"ok": false, "diagnostics": [
  {"ruleId": "child-containment", "severity": "error",
   "message": "Child element exceeds parent container by bottom+44px: …"}
]}
```

**取 JSON 的写法**（stdout 里会混有 Node 的告警行，过滤掉）：
```bash
slidep.sh lint "<deck>.pptx" --dsl-file slides/07.slide 2>/dev/null | grep '^{'
```

`lint` 是**纯本地**的（Yoga 算数），不需要联网、不需要后端。

### upsert-dsl — 写入 / 替换一页

```bash
slidep.sh upsert-dsl "<deck>.pptx" --dsl-file slides/07.slide                 # 追加新页
slidep.sh upsert-dsl "<deck>.pptx" --dsl-file slides/07.slide --page-index 6  # 替换第 7 页（0 基）
```

省略 `--page-index` = **追加**；指定 = **替换该页**。这就是全部的"增删页"能力。
写入前引擎会自动把旧 pptx 备份到 `.slidep/bak/`。

## 核心原则：先 lint 再 upsert

**绝不要跳过 lint 直接写入。** 正确循环：

```bash
for f in slides/*.slide; do
  r=$(slidep.sh lint "<deck>.pptx" --dsl-file "$f" 2>/dev/null | grep '^{')
  case "$r" in
    *'"ok":true'*)  slidep.sh upsert-dsl "<deck>.pptx" --dsl-file "$f" ;;
    *)              echo "$f 未通过: $r" ;;
  esac
done
```

`scripts/build_deck.sh` 已封装这个循环，并会汇总"通过 N 页 / 未通过 M 页（列出文件名）"。

## 其他命令（本机不可用，仅作知识）

| 命令 | 状态 |
|---|---|
| `screenshot` | ❌ 引擎写死 Linux CI 路径，本机不可用 |
| `validate` | 存在，但 `lint` 已覆盖布局校验，流程不用 |
| `lint --visual` | ❌ 依赖 screenshot |
| `script` / `template search` | ❌ README 有、二进制无 |

## 别做的事

- ❌ 不要在 shim 报错后重试或排查 shim —— 直接换直调入口。
- ❌ 不要用 `screenshot` 出预览图 —— 那条链路在本机是死的。
- ❌ 不要用裸解释器 `python/versions/3.13.12/python.exe` 测依赖（它没有任何第三方包）。
