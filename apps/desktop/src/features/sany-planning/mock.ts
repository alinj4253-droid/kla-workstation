/* 三一战略规划协同平台 — 演示数据（服务端接口就绪前使用内存数据） */

export type ModuleKey = 'review' | 'market' | 'biz' | 'plan';
export type FieldStatus = 'pending' | 'accepted' | 'edited' | 'rejected' | 'missing';
export type SanyRoleName = 'admin' | 'owner';

export type SanyModule = { k: ModuleKey; n: string; d: string; icon: string };
export type SanyField = {
  k: string;
  n: string;
  type: 'num' | 'text' | 'table';
  ai: string;
  conf: number;
  src: string;
  status: FieldStatus;
  gap?: string;
  human?: string;
  removed?: boolean;
  removedReason?: string;
  custom?: boolean;
};
export type SanyDoc = {
  name: string;
  ext: string;
  size: string;
  color: string;
  pages: number;
  claims: number;
  fields: number;
};
export type DocNeed = { n: string; req: boolean };
export type DocSpec = { need: DocNeed[]; hint: string; docs: SanyDoc[] };

export const DIRECTORY = [
  {
    dept: '集团战略管理部',
    members: [
      { name: '张明远', title: '集团战略总监', level: 'M4', empNo: 'SY10241' },
      { name: '林 静', title: '战略规划经理', level: 'P7', empNo: 'SY10388' },
      { name: '郭 鹏', title: '战略分析师', level: 'P6', empNo: 'SY10512' },
    ],
  },
  {
    dept: '智能家居业务单元',
    members: [
      { name: '李 伟', title: '业务单元总经理', level: 'M3', empNo: 'SY20118' },
      { name: '王 芳', title: '战略专员', level: 'P6', empNo: 'SY20347' },
      { name: '郑 涛', title: '产品总监', level: 'M2', empNo: 'SY20455' },
    ],
  },
  {
    dept: '物联平台业务单元',
    members: [
      { name: '陈 刚', title: '业务单元总经理', level: 'M3', empNo: 'SY30109' },
      { name: '刘 洋', title: '战略与投资经理', level: 'P7', empNo: 'SY30286' },
    ],
  },
  {
    dept: '研发中台',
    members: [
      { name: '赵 敏', title: '研发中台负责人', level: 'M3', empNo: 'SY40077' },
      { name: '孙 磊', title: '平台架构师', level: 'P8', empNo: 'SY40162' },
      { name: '何 静', title: '研发效能经理', level: 'P7', empNo: 'SY40233' },
    ],
  },
  {
    dept: '供应链中心',
    members: [
      { name: '周 强', title: '供应链中心总监', level: 'M3', empNo: 'SY50051' },
      { name: '吴 静', title: '采购经理', level: 'P7', empNo: 'SY50124' },
    ],
  },
  {
    dept: '财务中心',
    members: [
      { name: '徐 立', title: '财务总监', level: 'M4', empNo: 'SY60033' },
      { name: '马 宁', title: '管理会计经理', level: 'P7', empNo: 'SY60148' },
    ],
  },
];

export type SanyMember = {
  id: string;
  name: string;
  title: string;
  unit: string;
  role: SanyRoleName;
  joined: string;
  color: string;
  status: string;
  empNo: string;
};

export const ORG = {
  name: '三一集团',
  unit: '集团战略管理部',
  createdAt: '2026-10-08',
  admin: '张明远',
  planYear: '2027—2029',
};

export const ORG_MEMBERS: SanyMember[] = [
  { id: 'U-01', name: '张明远', title: '集团战略总监', unit: '集团战略管理部', role: 'admin', joined: '2026-10-08', color: '#3a4a63', status: '在职', empNo: 'SY10241' },
  { id: 'U-02', name: '李 伟', title: '业务单元总经理', unit: '智能家居业务单元', role: 'owner', joined: '2026-10-08', color: '#5b626d', status: '在职', empNo: 'SY20118' },
  { id: 'U-03', name: '陈 刚', title: '业务单元总经理', unit: '物联平台业务单元', role: 'owner', joined: '2026-10-08', color: '#4f5a66', status: '在职', empNo: 'SY30109' },
  { id: 'U-04', name: '赵 敏', title: '研发中台负责人', unit: '研发中台', role: 'owner', joined: '2026-10-09', color: '#96631a', status: '在职', empNo: 'SY40077' },
  { id: 'U-05', name: '周 强', title: '供应链中心总监', unit: '供应链中心', role: 'owner', joined: '2026-10-09', color: '#1f7a4d', status: '在职', empNo: 'SY50051' },
];

export type ReqStatus = '待上传' | '分析中' | '校验中' | '待补充' | '已提交' | '已通过' | '已退回';

export type SanyReq = {
  id: string;
  title: string;
  unit: string;
  owner: string;
  type: string;
  typeName: string;
  deadline: string;
  assignedAt: string;
  status: ReqStatus;
  docs: number;
  prefill: number;
  verified: number;
  gaps: number;
};

export const REQS: SanyReq[] = [
  { id: 'R-01', title: '智能家居业务单元 2027—2029 规划', unit: '智能家居业务单元', owner: '李 伟', type: 'T-BG', typeName: '成长型业务', deadline: '2026-11-15', assignedAt: '2026-10-08', status: '校验中', docs: 4, prefill: 18, verified: 3, gaps: 3 },
  { id: 'R-02', title: '物联平台业务单元 2027—2029 规划', unit: '物联平台业务单元', owner: '陈 刚', type: 'T-BN', typeName: '培育型业务', deadline: '2026-11-15', assignedAt: '2026-10-08', status: '分析中', docs: 2, prefill: 12, verified: 2, gaps: 4 },
  { id: 'R-03', title: '研发中台 2027—2029 职能规划', unit: '研发中台', owner: '赵 敏', type: 'T-FM', typeName: '职能中台', deadline: '2026-11-18', assignedAt: '2026-10-08', status: '待上传', docs: 0, prefill: 0, verified: 0, gaps: 0 },
  { id: 'R-04', title: '供应链中心 2027—2029 职能规划', unit: '供应链中心', owner: '周 强', type: 'T-FB', typeName: '职能后台', deadline: '2026-11-18', assignedAt: '2026-10-08', status: '待上传', docs: 0, prefill: 0, verified: 0, gaps: 0 },
];

export const MODULES: SanyModule[] = [
  { k: 'review', n: '经营回顾', d: '复盘经营结果，找出内部瓶颈', icon: '①' },
  { k: 'market', n: '市场洞察', d: '识别外部机会与威胁', icon: '②' },
  { k: 'biz', n: '业务澄清', d: '说清商业模式与增长逻辑', icon: '③' },
  { k: 'plan', n: '三一规划', d: '三年目标、举措、战役、指标', icon: '④' },
];

export const COMPANY_MODULES: SanyModule[] = [
  { k: 'review', n: '集团经营回顾', d: '集团整体经营结果与业务组合表现', icon: '①' },
  { k: 'market', n: '行业趋势洞察', d: '集团视角的外部环境与产业趋势', icon: '②' },
  { k: 'biz', n: '业务组合澄清', d: '各业务定位、协同关系与资源配置', icon: '③' },
  { k: 'plan', n: '集团三一规划', d: '集团三年目标、重大举措与考核体系', icon: '④' },
];

export const MODULE_DOC_SPEC: Record<ModuleKey, DocSpec> = {
  review: {
    need: [
      { n: '近三年经营数据（收入、成本、利润）', req: true },
      { n: '年度目标与实际完成情况', req: true },
      { n: '必胜战役执行复盘', req: true },
      { n: '内部能力诊断或效率分析', req: false },
    ],
    hint: '用于生成经营基线、偏差原因与内部瓶颈判断',
    docs: [
      { name: '经营数据2026.xlsx', ext: 'xlsx', size: '286 KB', color: '#1f7a4d', pages: 12, claims: 26, fields: 9 },
      { name: '2026年度战役复盘.pptx', ext: 'pptx', size: '4.2 MB', color: '#8a6216', pages: 18, claims: 19, fields: 6 },
    ],
  },
  market: {
    need: [
      { n: '行业研究报告或市场数据', req: true },
      { n: '政策与合规要求汇编', req: false },
      { n: '竞品与对标分析', req: true },
      { n: '客户调研或需求洞察', req: false },
    ],
    hint: '用于生成市场规模、增长趋势、机会清单与竞争位势',
    docs: [
      { name: '全屋智能行业研究2026.pdf', ext: 'pdf', size: '6.8 MB', color: '#a83a2d', pages: 42, claims: 31, fields: 8 },
    ],
  },
  biz: {
    need: [
      { n: '客户结构与分层数据', req: true },
      { n: '收入结构与盈利模型', req: true },
      { n: '渠道与能力清单', req: false },
      { n: '商业模式或定价说明', req: false },
    ],
    hint: '用于生成客户画像、价值主张、盈利逻辑与增长路径',
    docs: [
      { name: '市场调研纪要.docx', ext: 'docx', size: '680 KB', color: '#3a4a63', pages: 9, claims: 14, fields: 5 },
      { name: '公司能力清单2026.docx', ext: 'docx', size: '420 KB', color: '#3a4a63', pages: 5, claims: 8, fields: 3 },
    ],
  },
  plan: {
    need: [
      { n: '集团下达的目标或预算框', req: true },
      { n: '历史指标序列与口径说明', req: true },
      { n: '上年度战役与任务清单', req: false },
      { n: '考核办法或指标字典', req: false },
    ],
    hint: '用于生成三年目标、战略举措、年度战役与指标体系',
    docs: [
      { name: '指标口径与历史序列.xlsx', ext: 'xlsx', size: '214 KB', color: '#1f7a4d', pages: 6, claims: 11, fields: 4 },
    ],
  },
};

export const COMPANY_DOC_SPEC: Record<ModuleKey, DocSpec> = {
  review: {
    need: [
      { n: '集团合并报表（近三年）', req: true },
      { n: '集团经营分析会纪要', req: true },
      { n: '分部报告与业务组合数据', req: true },
      { n: '跨业务协同测算材料', req: false },
    ],
    hint: '用于生成集团合并口径的基线、业务组合表现与集团层面经营问题',
    docs: [
      { name: '集团合并报表2026.xlsx', ext: 'xlsx', size: '1.2 MB', color: '#1f7a4d', pages: 16, claims: 42, fields: 8 },
      { name: '集团经营分析会纪要.docx', ext: 'docx', size: '540 KB', color: '#3a4a63', pages: 11, claims: 17, fields: 4 },
    ],
  },
  market: {
    need: [
      { n: '行业研究与产业趋势报告', req: true },
      { n: '政策与合规要求汇编', req: true },
      { n: '竞争格局与对标数据', req: true },
      { n: '集团可及市场测算', req: false },
    ],
    hint: '用于生成集团视角的产业趋势、政策影响与竞争位势判断',
    docs: [
      { name: '全屋智能行业研究2026.pdf', ext: 'pdf', size: '6.8 MB', color: '#a83a2d', pages: 42, claims: 31, fields: 6 },
      { name: '政策汇编2026.pdf', ext: 'pdf', size: '3.4 MB', color: '#a83a2d', pages: 28, claims: 12, fields: 2 },
    ],
  },
  biz: {
    need: [
      { n: '集团战略纲要或业务定位文件', req: true },
      { n: '集团管控与协同机制制度', req: true },
      { n: '资源配置原则说明', req: false },
      { n: '盈利模式与财务结构', req: false },
    ],
    hint: '用于生成业务组合定位、资源配置原则与管控协同机制',
    docs: [
      { name: '集团战略纲要2026-2028.docx', ext: 'docx', size: '860 KB', color: '#3a4a63', pages: 14, claims: 23, fields: 5 },
    ],
  },
  plan: {
    need: [
      { n: '集团三年目标与财务预算框', req: true },
      { n: '各单元申报目标汇总', req: true },
      { n: '集团考核办法与指标体系', req: false },
      { n: '董事会议事规则', req: false },
    ],
    hint: '用于生成集团三年目标、重大举措、资源投入与考核体系',
    docs: [
      { name: '集团预算框与目标汇总.xlsx', ext: 'xlsx', size: '680 KB', color: '#1f7a4d', pages: 8, claims: 19, fields: 6 },
    ],
  },
};

export const OWNER_PREFILL: Record<ModuleKey, SanyField[]> = {
  review: [
    { k: 'revenue', n: '2026 年营业收入', type: 'num', ai: '186,000 万元', conf: 96, src: '经营数据2026.xlsx · 第 1 页 · 损益表', status: 'accepted' },
    { k: 'revenueTarget', n: '2026 年营业收入目标', type: 'num', ai: '180,000 万元', conf: 94, src: '经营数据2026.xlsx · 第 1 页 · 年度目标列', status: 'accepted' },
    { k: 'completeRate', n: '目标完成率', type: 'num', ai: '103.2%', conf: 98, src: '系统计算：186,000 ÷ 180,000', status: 'accepted' },
    { k: 'battleReview', n: '必胜战役完成情况', type: 'text', ai: '2026 年共设 4 项必胜战役：\n· 战役 1「高端产品线突破」达成，营收贡献 4.2 亿元，完成率 112%\n· 战役 2「渠道下沉」部分达成，新增门店 420 家，完成率 84%\n· 战役 3「服务化转型」达成，服务收入占比 8%，完成率 100%\n· 战役 4「供应链降本」未达成，采购成本下降 2.1%，目标 4%', conf: 91, src: '2026年度战役复盘.pptx · 第 4—9 页', status: 'pending' },
    { k: 'deviation', n: '主要经营偏差及原因', type: 'text', ai: '全年营收超目标 3.2%，但结构不均：\n· 一线城市增速 18%，三四线城市仅 6%，渠道下沉未达预期\n· 高端产品占比从 21% 升至 24%，超年度目标 2 个百分点\n· 供应链降本未达目标，主因铜材价格上涨 14%', conf: 87, src: '2026年度战役复盘.pptx · 第 10—12 页', status: 'pending' },
    { k: 'bottleneck', n: '内部瓶颈与突破机会', type: 'text', ai: '（现有材料不足以支撑本项内容，请补充相关材料）', conf: 0, src: '', status: 'missing', gap: '缺少对渠道能力、组织效率的内部诊断材料' },
  ],
  market: [
    { k: 'marketSize', n: '目标市场规模（2029 年）', type: 'num', ai: '1,240 亿元', conf: 89, src: '全屋智能行业研究2026.pdf · P23 · 表 4', status: 'pending' },
    { k: 'cagr', n: '未来三年复合增长率', type: 'num', ai: '11.8%', conf: 92, src: '全屋智能行业研究2026.pdf · P23 · 表 4', status: 'pending' },
    { k: 'opportunity', n: '主要外部机会', type: 'text', ai: '按机会价值与自身能力匹配度排序：\n1. 中高端全屋智能整装（规模 380 亿，增速 16.2%，与现有产品线匹配度高）\n2. 存量房智能化改造（规模 210 亿，增速 22.5%，需新建服务能力）\n3. 商用空间智能（规模 190 亿，增速 12.1%，需渠道调整）', conf: 84, src: '全屋智能行业研究2026.pdf · P24—P28', status: 'pending' },
    { k: 'threat', n: '主要威胁与风险', type: 'text', ai: '· 头部家电厂商加速进入，价格战风险上升（研究 P31）\n· 数据安全与隐私合规要求趋严，可能增加产品成本\n· 房地产新开工面积持续下滑，新房配套需求承压', conf: 78, src: '全屋智能行业研究2026.pdf · P30—P32', status: 'pending' },
    { k: 'benchmark', n: '对标对象与差距', type: 'text', ai: '（现有材料仅提及 2 家竞品，缺少关键指标对比数据，需补充）', conf: 0, src: '', status: 'missing', gap: '缺少对标企业的营收、毛利、渠道结构等指标数据' },
  ],
  biz: [
    { k: 'customer', n: '目标客户群体', type: 'text', ai: '核心客群：30—45 岁、家庭年收入 40 万元以上的城市中产家庭；\n次级客群：精装房开发商、家装公司（B 端渠道）；\n决策特征：重视整装体验与售后保障，价格敏感度中等偏低。', conf: 82, src: '市场调研纪要.docx · 第 2—5 页', status: 'pending' },
    { k: 'value', n: '核心价值主张', type: 'text', ai: '以「场景联动体验 + 5 年整机质保 + 一站式交付」形成差异化，客单价高于行业均值 32%，复购与转介绍率 27%。', conf: 85, src: '市场调研纪要.docx · 第 6—8 页', status: 'pending' },
    { k: 'revenueModel', n: '收入来源结构', type: 'text', ai: '硬件销售 82%、服务订阅 8%、渠道返利 10%；\n服务订阅收入同比 +64%，是当前增长最快的收入项。', conf: 93, src: '经营数据2026.xlsx · 第 4 页 · 收入结构表', status: 'pending' },
    { k: 'resource', n: '关键资源与能力', type: 'text', ai: '· 自研中控协议栈（专利 27 项）\n· 全国 1,840 家签约门店\n· 5 大区域仓配中心', conf: 88, src: '公司能力清单2026.docx · 第 1—3 页', status: 'pending' },
    { k: 'growthPath', n: '增长关键路径', type: 'text', ai: '（以下方向为推算结果，缺少目标值，请确认）\n1. 渠道下沉：三四线城市门店从 21% 覆盖率提升至 40%\n2. 服务化：服务订阅占比从 8% 提升至 18%\n3. 高端化：高端产品线占比从 24% 提升至 35%', conf: 64, src: '多份材料交叉推算，无直接原文', status: 'pending' },
  ],
  plan: [
    { k: 'goals', n: '三年战略目标', type: 'text', ai: '2027 年：营业收入 216,000 万元（+16.1%）\n2028 年：营业收入 252,000 万元（+16.7%）\n2029 年：营业收入 292,000 万元（+15.9%）\n（目标值基于历史增速与行业增速推断，需业务确认）', conf: 71, src: '推算依据：近三年 CAGR 15.2% + 行业增速 11.8%', status: 'pending' },
    { k: 'moves', n: '战略举措', type: 'table', ai: 'I-01 渠道下沉与门店扩张 → 支撑目标 G-01\nI-02 服务化转型与订阅体系 → 支撑目标 G-01\nI-03 高端产品线扩容 → 支撑目标 G-02\nI-04 供应链降本增效 → 支撑目标 G-03', conf: 79, src: '推算自战役复盘与经营偏差分析', status: 'pending' },
    { k: 'battles', n: '年度必胜战役', type: 'table', ai: 'B-01 下沉市场千店计划（承接 I-01）\nB-02 服务订阅破亿计划（承接 I-02）\nB-03 高端系列上新（承接 I-03）\nB-04 采购降本 4%（承接 I-04）', conf: 77, src: '沿用 2026 年度战役框架并调整', status: 'pending' },
    { k: 'metrics', n: '衡量指标', type: 'table', ai: 'K-01 营业收入（万元）｜期末合并口径｜2029 目标 292,000｜财务系统\nK-02 门店数量（家）｜期末在营｜2029 目标 3,200｜渠道系统\nK-03 服务收入占比（%）｜服务收入÷总收入｜2029 目标 18｜财务系统\nK-04 高端产品占比（%）｜高端 SKU 收入÷总收入｜2029 目标 35｜销售系统', conf: 83, src: '推算自增长路径与现有指标口径表', status: 'pending' },
    { k: 'share', n: '市场占有率目标', type: 'num', ai: '（缺少年度目标值，现有材料仅有当前值 12%）', conf: 0, src: '', status: 'missing', gap: '缺少市场占有率的历史序列与三年目标测算材料' },
  ],
};

export const COMPANY_PREFILL: Record<ModuleKey, SanyField[]> = {
  review: [
    { k: 'gRev', n: '集团 2026 年合并营业收入', type: 'num', ai: '250,000 万元', conf: 97, src: '集团合并报表2026.xlsx · 第 1 页 · 合并利润表', status: 'accepted' },
    { k: 'gGrowth', n: '集团营业收入同比增长', type: 'num', ai: '18.4%', conf: 96, src: '集团合并报表2026.xlsx · 第 1 页 · 同比列', status: 'accepted' },
    { k: 'gProfit', n: '集团净利润与净利率', type: 'num', ai: '净利润 28,600 万元，净利率 11.4%', conf: 94, src: '集团合并报表2026.xlsx · 第 3 页', status: 'pending' },
    { k: 'gMix', n: '业务组合贡献结构', type: 'text', ai: '智能家居 74.4%（186,000 万元）、物联平台 25.6%（64,000 万元）；\n物联平台增速 42.1%，远高于智能家居 16.8%，但尚未盈利（净利率 -6.2%）。', conf: 93, src: '集团合并报表2026.xlsx · 第 4 页 · 分部报告', status: 'pending' },
    { k: 'gIssue', n: '集团层面主要经营问题', type: 'text', ai: '· 增长依赖单一业务，智能家居贡献 74% 收入\n· 物联平台投入期亏损扩大，尚未验证单位经济模型\n· 两大业务客户重叠率仅 12%，协同未释放', conf: 76, src: '集团经营分析会纪要.docx · 第 2—4 页', status: 'pending' },
    { k: 'gSynergy', n: '跨业务协同价值测算', type: 'text', ai: '（集团层面尚无成体系的协同测算材料，需补充）', conf: 0, src: '', status: 'missing', gap: '缺少跨业务客户重叠、交叉销售与共享成本的测算材料' },
  ],
  market: [
    { k: 'gTrend', n: '产业趋势判断', type: 'text', ai: '· 全屋智能从单品智能向场景智能迁移，软件与服务价值占比上升\n· 行业集中度提升，CR5 从 2023 年 31% 升至 2026 年 39%\n· 数据合规与互联互通标准趋严，利好具备协议栈自研能力的企业', conf: 88, src: '全屋智能行业研究2026.pdf · P8—P14', status: 'pending' },
    { k: 'gPolicy', n: '政策与合规影响', type: 'text', ai: '《智能家居互联互通规范》2027 年实施，需完成协议适配；数据出境与隐私合规成本预计增加 3—5%。', conf: 81, src: '政策汇编2026.pdf · 第 6 页', status: 'pending' },
    { k: 'gSpace', n: '集团可及市场空间', type: 'num', ai: '1,240 亿元（2030 年），集团当前份额 20.2%', conf: 85, src: '全屋智能行业研究2026.pdf · P23 + 集团合并报表2026.xlsx', status: 'pending' },
    { k: 'gCompete', n: '集团层面竞争位势', type: 'text', ai: '规模位列行业第 3，但高端市场（单价 8 万元以上）份额仅 9.4%，落后头部两家。', conf: 79, src: '全屋智能行业研究2026.pdf · P31—P34', status: 'pending' },
    { k: 'gBet', n: '战略赛道的取舍判断', type: 'text', ai: '（需董事会层面决策，材料未包含集团战略取舍结论）', conf: 0, src: '', status: 'missing', gap: '缺少董事会战略研讨结论与集团战略纲要' },
  ],
  biz: [
    { k: 'gPortfolio', n: '业务组合与定位', type: 'text', ai: '智能家居：现金流业务，保增长、提毛利；\n物联平台：第二曲线，投入期、抢份额；\n研发中台：共用能力供给，支撑两大业务；\n供应链：成本中心，降本与交付保障。', conf: 90, src: '集团战略纲要2026-2028.docx · 第 3 页', status: 'pending' },
    { k: 'gResource', n: '集团资源配置原则', type: 'text', ai: '研发投入向平台与共性技术倾斜；营销投入向高毛利区域与高端产品倾斜；资本开支优先保障产能瓶颈环节。', conf: 84, src: '集团战略纲要2026-2028.docx · 第 5—6 页', status: 'pending' },
    { k: 'gModel', n: '集团盈利模式', type: 'text', ai: '硬件销售为主（82%），服务与订阅占比 8%，目标 2029 年提升至 18%；集团整体毛利率 31.2%。', conf: 92, src: '集团合并报表2026.xlsx · 第 5 页', status: 'pending' },
    { k: 'gControl', n: '集团管控与协同机制', type: 'text', ai: '（现有材料仅提及财务管控，缺少业务协同与共享机制的说明）', conf: 0, src: '', status: 'missing', gap: '缺少集团管控模式、共享中心与协同机制的制度文件' },
  ],
  plan: [
    { k: 'gGoal', n: '集团三年战略目标', type: 'text', ai: '2027 年：营业收入 280,000 万元（+12.0%）\n2028 年：316,000 万元（+12.9%）\n2029 年：356,000 万元（+12.7%）\n（按各业务单元申报目标加总，需集团层面确认是否接受）', conf: 74, src: '按智能家居、物联平台申报目标加总', status: 'pending' },
    { k: 'gMoves', n: '集团重大战略举措', type: 'text', ai: 'GI-01 双引擎协同（客户互通、渠道共享）\nGI-02 平台技术底座统一\nGI-03 高端市场突破\nGI-04 供应链与成本领先', conf: 72, src: '推算自业务组合定位，缺集团层面举措清单', status: 'pending' },
    { k: 'gInvest', n: '三年资源投入计划', type: 'text', ai: '研发投入 2027—2029 累计 8.6 亿元；资本开支累计 5.2 亿元；\n各业务单元申报合计 3.9 亿元/年，超出可用预算 0.7 亿元，需集团裁定。', conf: 68, src: '各单元申报汇总 + 集团财务预算框', status: 'pending' },
    { k: 'gKPI', n: '集团考核指标体系', type: 'text', ai: '结果指标：营业收入、净利率、市场份额、现金流\n过程指标：服务收入占比、高端产品占比、客户重叠转化率\n（培育型业务是否改用里程碑考核，需集团决策）', conf: 70, src: '推算自现有考核办法，缺制度依据', status: 'pending' },
    { k: 'gBoard', n: '董事会决策事项清单', type: 'text', ai: '（需梳理本次规划需上报董事会决策的事项，材料未包含）', conf: 0, src: '', status: 'missing', gap: '缺少董事会议事规则与本次规划需决议事项范围' },
  ],
};

export type IssueLevel = '阻断' | '重要' | '一般';
export type SanyIssue = { id: string; lv: IssueLevel; t: string; d: string; o: string; st: string };

export const ISSUES: SanyIssue[] = [
  { id: 'ISS-01', lv: '阻断', t: '集团合并目标与单元申报加总不一致', d: '单元申报三年营收加总 356,000 万元，集团财务框为 342,000 万元，差 14,000 万元（4.1%）。', o: '张明远 / 财务中心', st: '待裁定' },
  { id: 'ISS-02', lv: '阻断', t: '2026 年营收基线存在两个口径', d: '智能家居提交 186,000 万元，集团合并报表同口径为 179,400 万元，差异 3.7%。', o: '李 伟 / 财务中心', st: '待裁定' },
  { id: 'ISS-03', lv: '重要', t: '物联平台尚未验证单位经济模型', d: '该单元净利率 -6.2%，客户获取成本与 LTV 未测算，集团层面无法判断投入节奏。', o: '陈 刚', st: '待补充' },
  { id: 'ISS-04', lv: '重要', t: '公司层「战略赛道取舍」缺董事会结论', d: '四模块中该项因缺材料未生成，集团战略方向未定，影响业务组合判断。', o: '张明远', st: '待补充' },
  { id: 'ISS-05', lv: '一般', t: '跨业务协同价值无量化测算', d: '客户重叠率仅 12%，协同溢价未测算，集团举措 GI-01 缺少量化依据。', o: '张明远', st: '待补充' },
];

export type OutputVersion = {
  v: number;
  at: string;
  by: string;
  status: '已归档' | '待审核' | '已退回' | '已通过';
  summary: string;
  changes: string;
  size: string;
  file: string;
  audit?: string;
  pageNames?: string[];
};

export type SanyOutput = {
  k: 'doc' | 'ppt' | 'diag' | 'package';
  n: string;
  d: string;
  note: string;
  versions: OutputVersion[];
};

export const OUTPUTS: SanyOutput[] = [
  {
    k: 'doc', n: '规划正文', d: '四模块合并成稿，整份留底', note: '按章节结构合并四模块已确认内容，一次成文',
    versions: [
      { v: 1, at: '2026-11-09 20:40', by: '李 伟', status: '已归档', summary: '四模块合并首稿', changes: '首次成稿：经营回顾 / 市场洞察 / 业务澄清 / 三一规划 四章', size: '21 项字段 · 5 份材料 · 6 章', file: '智能家居_规划正文_V1.pdf' },
      { v: 2, at: '2026-11-12 17:52', by: '李 伟', status: '待审核', summary: '补充市场占有率三年目标，营收基线改按财务中心口径', changes: '改 2 章：经营回顾（营收口径）、三一规划（市占率目标）；新增 1 份材料', size: '21 项字段 · 6 份材料 · 6 章', file: '智能家居_规划正文_V2.pdf' },
    ],
  },
  {
    k: 'ppt', n: '汇报 PPT', d: '给本单元与下级汇报用，不进交付包', note: '页面由汇报 PPT 智能体按内容自行组织；每页可下钻到数据来源',
    versions: [
      { v: 1, at: '2026-11-10 09:15', by: '李 伟', status: '已归档', summary: '首次生成，当时三一规划还没填报，智能体按已有内容组织', changes: '智能体编排，含封面', size: '4 张图表 · 含封面', file: '智能家居_单元汇报_V1.pptx', pageNames: ['封面与汇报范围', '经营结果与目标达成', '战役复盘与经营偏差', '市场规模与增长判断', '机会取舍与对标差距', '客户与价值主张'] },
      { v: 2, at: '2026-11-12 18:05', by: '李 伟', status: '待审核', summary: '补齐业务澄清与三一规划后重排', changes: '智能体重排；比上一版多出「资源能力与增长路径」「三年战略目标」', size: '7 张图表 · 含封面', file: '智能家居_单元汇报_V2.pptx', pageNames: ['封面与汇报范围', '经营结果与目标达成', '战役复盘与经营偏差', '市场规模与增长判断', '机会取舍与对标差距', '客户与价值主张', '资源能力与增长路径', '三年战略目标'] },
    ],
  },
  {
    k: 'diag', n: '内容诊断报告', d: '完整性、承接链、依据充分度诊断', note: '交付前自检，每条问题给处理建议',
    versions: [
      { v: 1, at: '2026-11-12 18:20', by: '李 伟', status: '待审核', summary: '4 个阻断项、3 个提醒项', changes: '首次生成诊断报告', size: '7 项问题 · 覆盖 4 模块', file: '智能家居_内容诊断_V1.pdf' },
    ],
  },
  {
    k: 'package', n: '提交包', d: '正文 + 诊断 + 原始材料（不含汇报 PPT）', note: '交给管理员的交付件，只读留底',
    versions: [
      { v: 1, at: '2026-11-09 21:30', by: '李 伟', status: '已退回', summary: '首次提交，因市场占有率目标缺失被退回', changes: '正文 V1 + 5 份材料 + 24 条引用', size: '21 项字段 · 5 份材料 · 88 条结论', file: '智能家居_三一规划_提交包_V1.zip', audit: '管理员意见：市场占有率缺三年目标值，请补充后重提' },
      { v: 2, at: '2026-11-12 18:30', by: '李 伟', status: '待审核', summary: '补充市占率目标测算，修正营收基线口径，附内容诊断报告', changes: '正文 V2 + 诊断 V1 + 6 份材料', size: '21 项字段 · 6 份材料 · 96 条结论', file: '智能家居_三一规划_提交包_V2.zip' },
    ],
  },
];

export const ADMIN_NOTIFICATIONS = [
  { t: '李伟 已完成 3 份材料上传，已完成内容生成 31 项，18 项待校验', time: '18 分钟前', unread: true },
  { t: '陈刚 上传 2 份材料，材料解析中（已生成 24 项）', time: '1 小时前', unread: true },
  { t: '赵敏、周强 尚未上传材料，距截止 28 天', time: '今天 09:12', unread: false },
];

export const ASSIGN_REQ_DEFAULT = [
  { t: '上传近三年经营数据与年度目标', on: true },
  { t: '上传市场/行业研究报告', on: true },
  { t: '上传内部诊断或复盘材料', on: true },
  { t: '未确定事项标注「待决策」，不要估算', on: true },
];

export const PLAN_INTENT_TEXT = '围绕「智能家居 + 物联平台」双引擎，明确未来三年增长路径与资源投向，形成可执行的年度必胜战役与考核指标体系。';

export const OWNER_DECKS = [
  { n: '封面与汇报范围', d: '汇报对象与本次规划范围', kind: 'summary', filled: 3, missing: [] as string[] },
  { n: '经营结果与目标达成', d: '2026 经营基线、目标完成率', kind: 'data', filled: 4, missing: [] as string[] },
  { n: '战役复盘与经营偏差', d: '四项必胜战役完成情况与偏差原因', kind: 'data', filled: 6, missing: [] as string[] },
  { n: '市场规模与增长判断', d: '2029 市场规模与三年复合增速', kind: 'data', filled: 4, missing: [] as string[] },
  { n: '机会取舍与对标差距', d: '机会排序、对标对象与差距', kind: 'issues', filled: 3, missing: ['对标差距'] },
  { n: '客户与价值主张', d: '目标客群、价值主张与收入结构', kind: 'data', filled: 5, missing: [] as string[] },
  { n: '资源能力与增长路径', d: '关键资源、能力与三条增长路径', kind: 'issues', filled: 3, missing: ['内部瓶颈'] },
  { n: '三年战略目标', d: '2027—2029 年目标与必胜战役', kind: 'issues', filled: 4, missing: ['市场占有率目标'] },
];

export const COMPANY_RESULT_PAGES = [
  { n: '封面与集团规划范围', d: '规划周期、口径与未决项说明', kind: 'summary', filled: 3, missing: [] as string[] },
  { n: '集团经营结果与业务组合', d: '合并收入、净利率、分部贡献', kind: 'data', filled: 5, missing: [] as string[] },
  { n: '行业趋势与竞争位势', d: '产业趋势、政策影响、竞争格局', kind: 'data', filled: 4, missing: [] as string[] },
  { n: '业务定位与协同逻辑', d: '四类业务定位与协同关系', kind: 'data', filled: 4, missing: [] as string[] },
  { n: '集团三年战略目标', d: '2027—2029 目标与年度节奏', kind: 'issues', filled: 3, missing: ['目标口径待裁定'] },
  { n: '重大举措与资源配置', d: '四项集团举措与三年资源投入', kind: 'issues', filled: 3, missing: ['预算缺口 0.7 亿'] },
  { n: '考核体系与董事会事项', d: '结果/过程指标与待决事项', kind: 'issues', filled: 2, missing: ['董事会事项'] },
  { n: '未决问题与缺报单元', d: '阻断项、缺报单元与风险承担人', kind: 'issues', filled: 5, missing: [] as string[] },
];

export const DIAG_FINDINGS = [
  { lv: 'block' as const, mod: '经营回顾', t: '内部瓶颈与突破机会', d: '缺少对渠道能力、组织效率的内部诊断材料', act: '补材料，或直接手工填写并在提交说明里注明' },
  { lv: 'block' as const, mod: '市场洞察', t: '对标对象与差距', d: '缺少对标企业的营收、毛利、渠道结构等指标数据', act: '补材料，或直接手工填写并在提交说明里注明' },
  { lv: 'block' as const, mod: '三一规划', t: '市场占有率目标', d: '缺少市场占有率的历史序列与三年目标测算材料', act: '补材料，或直接手工填写并在提交说明里注明' },
  { lv: 'block' as const, mod: '全部模块', t: '18 项内容未确认', d: '已生成但未确认的内容不会进入正文结论，只作为占位', act: '逐项确认，或一键采纳高依据项' },
  { lv: 'warn' as const, mod: '三一规划', t: '三年战略目标', d: '依据充分度 71%，为多份材料交叉推算，无直接原文', act: '核对原文后确认，或改成你们自己的口径' },
  { lv: 'warn' as const, mod: '业务澄清', t: '增长关键路径', d: '依据充分度 64%，为多份材料交叉推算，无直接原文', act: '核对原文后确认，或改成你们自己的口径' },
  { lv: 'warn' as const, mod: '三一规划', t: '三年目标与集团下达指标未对齐', d: '目标值由历史增速推算得出，尚未与集团预算框核对', act: '与财务/战略确认后再确认该项' },
];

export const MODULE_GAP_ROWS = [
  { unit: '智能家居业务单元', field: '内部瓶颈与突破机会', need: '渠道能力诊断、组织效率评估材料' },
  { unit: '智能家居业务单元', field: '对标对象与差距', need: '对标企业营收、毛利、渠道结构数据' },
  { unit: '物联平台业务单元', field: '市场占有率目标', need: '市场占有率历史序列与测算依据' },
  { unit: '物联平台业务单元', field: '三年目标基线', need: '近三年财务报表（同口径）' },
];

export const companyAllFields = () =>
  (Object.keys(COMPANY_PREFILL) as ModuleKey[]).flatMap(k => COMPANY_PREFILL[k]);

export const ownerAllFields = () =>
  (Object.keys(OWNER_PREFILL) as ModuleKey[]).flatMap(k => OWNER_PREFILL[k]);
