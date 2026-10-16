# 排版配方（骨架 / Flexbox / 字号 / 图片）

> 一条铁律贯穿全篇：**所有 `<Text>` 显式声明 `height`。**
> 引擎对没写高度的文本只能估算行数，估出来常常偏高，导致 lint 持续报容器溢出。
> 源码里满屏的 `height` 不是冗余，是让校验能收敛的**必需条件**。

## 1. 单页骨架公式（所有内容页共用）

```jsx
<Slide style={{ width: 1280, height: 720, background: BG, fontFamily: FONT_CN, padding: '20px 72px' }}>
  <Box style={{ flexDirection: 'column', height: '100%' }}>

    {/* A · 标题区 */}
    <Box style={{ height: 100, flexDirection: 'row', alignItems: 'flex-start' }}>
      <Box style={{ flexDirection: 'column' }}>
        <Text style={{ fontSize: 34, fontWeight: 'bold', color: INK, letterSpacing: -0.5 }}>页面主标题</Text>
        <Box style={{ width: 56, height: 4, background: GRAD, borderRadius: 2, marginTop: 10 }} />
      </Box>
    </Box>

    {/* B · 内容区（唯一被替换的部分） */}
    <Box style={{ height: 540, flexDirection: 'column' }}>
      …
    </Box>

    {/* C · 页脚条 */}
    <Box style={{ height: 40, flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
      <Box style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}>
        <Box style={{ width: 32, height: 32, borderRadius: 8, background: GRAD, justifyContent: 'center', alignItems: 'center' }}>
          <Text style={{ fontSize: 16, fontWeight: 'bold', color: BG, fontFamily: FONT_NUM }}>标</Text>
        </Box>
        <Text style={{ fontSize: 13, color: DIM, letterSpacing: 2 }}>项目名</Text>
      </Box>
      <Text style={{ fontSize: 14, color: DIM, letterSpacing: 1, fontFamily: FONT_NUM }}>07 / 16</Text>
    </Box>

  </Box>
</Slide>
```

**三段高度 100 / 540 / 40，加上外层 `padding: '20px 72px'` 的上下各 20 → 合计 720。**
规范文档里写的 A/B/C = 120/540/60 是**含 padding 的口径**，两者等价（20+100=120，40+20=60）。

封面 / 章节扉页 / 结语页**省略 C 区**，用自定义全幅版式。

## 2. 定位只有两种范式

| 范式 | 怎么写 | 何时用 |
|---|---|---|
| **流式（Flexbox）** | 不写 `position`，用 `flexDirection` / `flex` / `gap` / `justifyContent` / `padding` | **默认选择**。三栏 = 三个 `flex: 1`，引擎自动平分 |
| **绝对定位** | `position: 'absolute'` + `top` / `left` + 显式宽高 | **只有两种**：满版铺底图、需要叠在其他元素之上的层 |

判断规则：**能用流式就用流式**（它不容易溢出）。绝对定位只留给"铺底"和"叠层"。
三栏等宽用 `flex: 1`，比例栏用 `flex: 1 / 2 / 1`。
兄弟元素间距用 `gap`；`alignItems: 'stretch'`（默认）让同行卡片自动等高。

## 3. 字号层级表（示例：一套表、不越界）

> 下表数值取自一份**高信息密度、深色题材**的实际 deck。它演示的是方法——**把全篇字号收敛成一套固定的表**，
> 不是通用答案。**每个项目都要在 `design-md.md` 给出的区间内重新取值**，然后写进本项目的 `DESIGN.md`。
> 换题材时这张表必须重定，不要照搬。

| 层级 | 字号 | 字重 | 行高 | 字距 | 用途 |
|---|---|---|---|---|---|
| 封面主标题 | 84 | bold | 1.05 | -1 | 仅封面 |
| 章节大字 | 64 | bold | 1.1 | 0 | 章节扉页 |
| 巨型数字（背景） | 220–300 | bold | 1.0 | -6 | 章节编号底图（低 opacity） |
| 巨型数据 / 锚点 | 96–132 | bold | 1.0 | -3 | 数据页 / 结语 |
| 页标题（A 区） | 34 | bold | 1.3 | -0.5 | 所有内容页固定 |
| 大图区标题 | 40 | bold | 1.2 | -0.5 | 主图上的标题带 |
| 副标题 / 卡片标题 | 26 / 23 | bold | 1.4 | 0 | 卡片头 |
| 正文 | 21 | normal | 1.6 | 0 | 段落 |
| 卡片正文（小） | 19 / 18 | normal | 1.55–1.6 | 0 | 三栏卡片 |
| 小正文 | 17 | normal | 1.6 | 0 | 次要说明 |
| 标签 / 眉标 | 15 / 13 | normal | 1.4 | +2~5 | 全大写英文小标 |
| 页码 / 脚注 | 14 | normal | 1.4 | +1 | C 区 |

**字重只有两档**：normal / bold。
**层次用 `opacity` 做**（0.55–0.88），不要靠引入更多灰色。
**规范给的区间**（页标题 32–40、正文 22–28、锚点 72–120）——在区间内取值即可，
但见 `design-md.md` 里那条"字数下限 vs 字号下限"的冲突说明。

## 4. 字体栈：两个常量，中英分开

```js
const FONT_CN  = '"Microsoft YaHei", "Noto Sans SC", "Source Han Sans SC", sans-serif';
const FONT_NUM = '"Bahnschrift", "Segoe UI", "Space Grotesk", sans-serif';
```

中文走系统黑体；**数字 / 英文 / 巨型数字必须走 `FONT_NUM`**，
否则中文字体里的数字形态会偏窄难看。改一处 → 全篇同时生效。

**首位必须是本机确实存在的字体**。写不存在的字体不会报错，但会被**静默替换**；
引擎**不嵌字体**，成品换机器就会变样，而 lint 的度量与字体无关，**它不会帮你发现**。
在本机实测存在的是 `Microsoft YaHei`（msyh.ttc）、`Noto Sans SC`（NotoSansSC-VF.ttf）、
`Bahnschrift`（bahnschrift.ttf）——所以它们排在前面。

## 5. 颜色收敛：一套常量，多套主题

结构是固定的 —— **4 个色角色 + 若干中性辅助**，全部写成源码顶部的常量，全篇共用：

```js
const BG     = '#FFFFFF';   // 主色：页面背景
const INK    = '#1B1E23';   // 文本色
const CARD   = '#F1F2F4';   // 辅色：卡片底 / 次级块
const ACCENT = '#2F6BE4';   // 强调色：≤10%，只用于焦点元素
// 中性辅助（不计入 4 色池）
const DIM    = '#767B84';   // 次级文字
const ONIMG  = '#F7F8FA';   // 图上白字
const LINE   = 'rgba(27,30,35,0.12)';
const GRAD   = 'linear-gradient(135deg, #2F6BE4 0%, #7FA9FF 100%)';
const MASK   = 'linear-gradient(90deg, rgba(18,20,24,0.94) 0%, rgba(18,20,24,0.72) 48%, rgba(18,20,24,0.12) 86%)';
```

上面这组是**中性占位**，不含题材倾向 —— 换成你项目的色值只需改这几行，**版式一行不用动**。

**面积分配**：主色 ≤60% / 辅色 ≤30% / 强调色 ≤10%（hero 页可到 15–20%）。
强调色只出现在焦点元素：巨型数字、章节编号、关键下划线、图表主系列。

**配色从哪来**：见 `references/theme-presets.md` —— 四个起步预设（中性商务浅色 / 深色科技 / 学术人文 /
政务红金），外加"题材不在预设里时如何自创并自证"。规范里的色彩参考表只覆盖科技金融 / 人文哲学 /
教育消费 / 政务党建四类，**游戏娱乐一类的题材没有现成答案，必须自配并自证**。

## 6. 图片三种用法（所有图都落在这三类里）

### ① 满版铺底（封面 / 章节扉页 / 结语）

```jsx
<Image src='assets/xxx.png' style={{ position: 'absolute', top: 0, left: 0, width: 1280, height: 720, objectFit: 'cover' }} />
{/* 遮罩是独立一层，绝不设 Image 的 opacity。基色取主色（浅色主题取深灰，不用纯黑） */}
<Box style={{ position: 'absolute', top: 0, left: 0, width: 1280, height: 720, background: MASK }} />
{/* 文字内容另起一层 */}
<Box style={{ position: 'absolute', top: 0, left: 0, width: 1280, height: 720,
  flexDirection: 'column', justifyContent: 'space-between', padding: '72px 88px 150px 88px' }}>
  …
</Box>
```

左边压到 0.92–0.97 让白字能读，右边只压到 0.12–0.34 露出画面。
`MASK` 写成常量放源码顶部，要调明暗只改这一行。

### ② 卡片内嵌（父 Box 负责圆角裁切）

```jsx
<Box style={{ height: 310, position: 'relative', borderRadius: 20, overflow: 'hidden' }}>
  <Image src='assets/xxx.png' style={{ position: 'absolute', top: 0, left: 0, width: 1136, height: 310, objectFit: 'cover' }} />
  <Box style={{ position: 'absolute', top: 0, left: 0, width: 1136, height: 310, background: MASK }} />
  <Box style={{ position: 'absolute', top: 0, left: 0, width: 1136, height: 310, flexDirection: 'column', justifyContent: 'center', padding: '0 44px' }}>
    …标题带文字…
  </Box>
</Box>
```

父容器必须 `borderRadius` + `overflow: 'hidden'`；`position: 'relative'` 是子绝对定位的锚点。

### ③ 并排小图（窄栏堆叠）

三张切好的横带，各自显式宽高，用 `flexDirection: 'column'` + `gap` 堆叠。

### 三条硬规则
- **每张图都显式写 `width` + `height`** —— 否则 Yoga 无法计算。
- **统一 `objectFit: 'cover'`** —— 允许裁切，但不留白、不变形。
- **图上不写字时不设 opacity，压暗靠独立遮罩层** —— 要调明暗只改遮罩那一行，图片本身不动。

## 7. 尾部落位与对齐（密度门禁相关）

- **底栏锚定**：卡片尾部的标签条 / 引文条用 `marginTop: 'auto'` 钉到容器底部，
  禁止"自然紧跟正文"导致它悬在卡片中段。
- **同行兄弟卡对齐**：同一行卡片的标题块 / 正文块 / 尾部条三段在 y 轴上必须等高，**误差 ≤ 16px**。
- **填充率 ≥ 85%**：卡片内文字+图标垂直占用 ≥ 容器高度 85%。高 ≥380px 的卡片正文 ≥100 字；
  ≥480px 的卡片正文 ≥130 字。

## 8. 六个可复制骨架（见 assets/）

- `slide-cover.slide` — 封面：全幅底图 + 遮罩 + 骑线文字 + 角标
- `slide-content.slide` — 内容页：A/B/C 三区 + 大图卡 + 三栏
- 其余四类（章节扉页 / 巨型数字页 / 非对称双栏 / 图表页）按上面配方的规则组合即可，
  关键差别只是 B 区内部结构：

| 类型 | B 区结构 |
|---|---|
| 章节扉页 | 全幅底图 + 巨型编号（低 opacity，绝对定位）+ 居中大字 |
| 巨型数字页 | 左侧巨型数字（96–132，`FONT_NUM`）+ 右侧洞察段落；背景可叠 SVG 网格 |
| 非对称双栏 | 左宽 62–65% / 右窄 35–38%，用 `flex: 62` / `flex: 38` |
| 图表页 | 左宽栏放 `<Chart>`（`flex: 62`）+ 右窄栏放判断句 |
