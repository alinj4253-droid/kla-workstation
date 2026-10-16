# lint 报溢出的排查与修复

## 真实报错长什么样

这是实测拿到的一条（故意写溢出触发的）：

```json
{"ok": false, "diagnostics": [{
  "ruleId": "child-containment",
  "severity": "error",
  "message": "Child element exceeds parent container by bottom+44px:
    3 | <Box style={{ left: 100, top: 100, width: 300, height: 100 ... }}>
    4 | <Text style={{ fontSize: 20 ... }}>这是一个故意写超长的文本块…</Text>
        ~~~~~~~~~~~~~~~~~~~~~~~~ bottom+44px"
}]}
```

**注意两点**：
- `bottom+44px` 是**精确算出的超出量**，不是关键词匹配；
- 它**指到源码行号**，直接告诉你哪个 `<Text>` 撑破了哪个 `<Box>`。

这是真·排版计算（Yoga）的产物，不是规则白名单。

## 根因

**Yoga 对没写 `height` 的文本节点只能估算高度，估出来通常偏高**，于是内容撑破父容器。
第一轮 16 页里 6 页报错，全部是这个原因的直接或间接后果。

## 三种修法（按优先级用）

### ① 给文本块显式声明 height（**根本修法**）

```jsx
// 前：lint 只能估，常估高
<Text style={{ fontSize: 18, color: INK, opacity: 0.78, lineHeight: 1.55 }}>长段落…</Text>

// 后：写死高度，lint 有确定值可校验
<Text style={{ fontSize: 18, color: INK, opacity: 0.78, lineHeight: 1.55, height: 58 }}>长段落…</Text>
```

估算公式：`height ≈ 字号 × 行高 × 行数`。
例：18px × 1.6 × 2 行 ≈ 58；21px × 1.6 × 3 行 ≈ 101。

### ② 压缩内边距 / 缩短文案

- 把容器的 `padding` 调小（如 `'22px 26px'` → `'18px 22px'`）；
- 或直接删减文案里的冗余字（通常删 10–15% 字数就够）。

### ③ 给"巨型数字"所在行容器写死高度

巨型数字是最容易溢出的元素（字号大、行高敏感）：

```jsx
// 行容器写死高度 + 数字本身也写 height
<Box style={{ height: 100, flexDirection: 'row', alignItems: 'flex-end', marginTop: 10 }}>
  <Text style={{ fontSize: 96, fontWeight: 'bold', color: PINK, fontFamily: FONT_NUM,
                 lineHeight: 1, letterSpacing: -3, height: 96 }}>10亿</Text>
</Box>
```

## 排查顺序（照着走）

1. 读报错里的**行号**，定位到那个 `<Text>`。
2. 给它补 `height`（用上面公式估）。
3. 若父容器本身高度也是靠内容撑的，把父 `<Box>` 也写死 `height`。
4. 重跑 `lint`。
5. 仍报 → 说明是**字数溢出**（不是估算问题），走修法 ②（删字或压 padding）。

## 一条反向经验

**不要试图靠"用 fontSize 调小"来消溢出**——那会破坏字号表的一致性，
而且往往只压住当前页，换页又冒出来。溢出几乎总是"缺 height 声明"，
补 `height` 比改字号有效得多，且不动版式观感。

## 收敛判据

全 N 页 `lint` 全部 `"ok":true` 才允许开始 `upsert-dsl`。
`build_deck.sh` 会打印通过/未通过清单，未通过的**不写入**。
