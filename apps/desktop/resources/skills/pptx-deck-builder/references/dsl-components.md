# DSL 组件写法

`.slide` 文件本质是一段 **JSX 片段**。文件顶部先声明常量，根节点是 `<Slide>`。

## 文件结构

```jsx
const FONT_CN  = '"Source Han Sans SC", "Noto Sans SC", "Microsoft YaHei", sans-serif';
const FONT_NUM = '"Space Grotesk", "Bahnschrift", "Segoe UI", sans-serif';
const BG = '#0E0E12';
const INK = '#F2F0EC';
const PINK = '#FF3D7F';
const ORANGE = '#FF8A3D';
const DIM = '#8A8A96';
const GRAD = 'linear-gradient(135deg, #FF3D7F 0%, #FF8A3D 100%)';
const LINE = 'rgba(242,240,236,0.14)';

<Slide style={{ width: 1280, height: 720, background: BG, fontFamily: FONT_CN, padding: '20px 72px' }}>
  …
</Slide>
```

- **常量写在使用之前**，同一文件内可复用；跨文件不共享，每页都要重新声明（保持一致）。
- 常量在 `<svg>` 的属性里要写成 JS 表达式（`stroke={LINE}`），在 `<Box>/<Text>` 的 style 里可直接用（`color: INK`）。

## 组件清单（本方案实际用到的 5 种）

| 组件 | 数量级 | 作用 |
|---|---|---|
| `<Box>` | 最多（~260/16页） | Flexbox 布局容器，也是色块/遮罩/圆角裁切框 |
| `<Text>` | 第二多（~230/16页） | 所有文字；**必须显式写 height** |
| `<Image>` | 十余张 | 主视觉图；**必须显式写 width+height** |
| `<svg>` | 少量 | 手绘矢量：时间轴、关系图、背景网格 |
| `<Chart>` | 少量 | 声明式图表 |

### Slide

```jsx
<Slide style={{ width: 1280, height: 720, background: BG, fontFamily: FONT_CN, padding: '20px 72px' }}>
```

全幅页版式：`position: 'relative'` + `overflow: 'hidden'`，不写 padding（内容自定内缩）。

### Box

```jsx
<Box style={{
  flexDirection: 'row' | 'column',
  flex: 1,                       // 按比例分剩余空间
  width: 690, height: 310,
  padding: '22px 26px', gap: 10,
  alignItems: 'center' | 'flex-start' | 'flex-end' | 'stretch',
  justifyContent: 'space-between' | 'center' | 'flex-end',
  background: BG, borderRadius: 20, overflow: 'hidden',
  borderLeft: '0.5px solid ' + LINE,
  boxShadow: '0 8px 32px rgba(0,0,0,0.45)',
  position: 'absolute', top: 0, left: 0, marginTop: 12,
}}>
```

- `position: 'relative'` 的 Box 是子元素绝对定位的锚点（卡片内嵌图必备）。
- `marginTop: 'auto'` 把尾部元素钉到容器底部（底栏锚定）。

### Text

```jsx
<Text style={{
  fontSize: 21, fontWeight: 'bold', color: INK, opacity: 0.78,
  lineHeight: 1.6, letterSpacing: -0.5,
  fontFamily: FONT_NUM,          // 数字/英文才写
  height: 58,                    // ★ 必须写
}}>文字内容</Text>
```

**height 估算**：`字号 × 行高 × 行数`。例：18×1.6×2 ≈ 58；21×1.6×3 ≈ 101。

### Image

```jsx
<Image src='assets/xxx.png' style={{
  position: 'absolute', top: 0, left: 0,
  width: 1136, height: 310,      // ★ 必须写宽高
  objectFit: 'cover',
}} />
```

`src` 用**相对项目根目录**的路径（`assets/xxx.png`）。**不要给 Image 设 opacity**。

### svg（内联矢量）

```jsx
<Box style={{ height: 306, marginTop: 16 }}>
  <svg width={730} height={306} viewBox='0 0 730 306'>
    <line x1='33' y1='64' x2='330' y2='164' stroke={LINE} strokeWidth='1.5' />
    <circle cx='24' cy='64' r='9' fill={ORANGE} opacity='0.85' />
    <rect x='0' y='0' width='100' height='40' fill={PINK} rx='6' />
    <text x='40' y='40' fill={INK} fontSize='15'>标签</text>
  </svg>
</Box>
```

- svg 必须包在写了 `height` 的 `<Box>` 里（否则 Yoga 算不准）。
- `width` / `height` 属性用花括号数字：`width={730}`；内部坐标用字符串。颜色用 `{常量}`。

### Chart（声明式图表）

```jsx
<Box style={{ height: 380, marginTop: 16 }}>
  <Chart
    style={{ width: 662, height: 380 }}
    chartType='barChart'          // barChart | lineChart | pieChart 等
    barDirection='column'         // column | bar
    title='标题'
    titleColor='#F2F0EC'
    showLegend={false}
    showDataLabels={true}
    dataLabelColor='#F2F0EC'
    axisColor='#8A8A96'
    colors={['linear-gradient(180deg, #FF3D7F 0%, #FF8A3D 100%)']}
    background='#0E0E12'
    data={[
      ['年份', '累计销量'],          // 第一行是表头
      ['2014', 36],
      ['2025', 215],
    ]}
  />
</Box>
```

- `data` 第一行是表头，其余是数据行。
- 配色必须取自 DESIGN.md 的色彩池，禁止卡通配色。

## 未用到但存在的组件

规范里还有 `component-table` / `animation` / `qrcode` / `faicon` / `codeblock` / `math` /
`hyperlink` / `diagram` / `slide`（页面级设置）等能力。**不是做不到，是本类题材不需要。**
真需要时去读 tencent-pptx 的 `references/component-*.md`（如已安装）。

## 语法坑（都是实测踩过的）

1. **文件顶层的注释只能用 `//`，绝不能用 `{/* … */}`**。
   用 `{/* … */}` 会让整份 `.slide` 求值成 `undefined`，引擎直接报
   `JSX input must evaluate to a JSX element, but received undefined`。
   `{/* … */}` 只在 `<Slide>` **内部**（JSX children 位置）合法。
2. **文件最后一条语句必须是 `<Slide>` 元素**，不要在它后面再写任何语句或注释块。
3. 不能用 HTML 注释 `<!-- -->`。
4. 字符串拼接用 `+`：`borderLeft: '0.5px solid ' + LINE`。
5. 数字属性用花括号：`width={730}`；CSS 字符串在 style 里像普通对象一样写。
6. 常量名不能与组件名冲突。
7. **不需要 import 任何东西** —— `Slide`/`Box`/`Text`/`Image`/`Chart` 是引擎注入的全局组件。
