// Public-source snapshot. Standards metadata is not a licensed full-text rulebook.
export const RESEARCH_DATE='2026-09-20';
export const SOURCES=[
{id:'design',title:'GB/T 39016—2020 定制家具 通用设计规范',url:'https://openstd.samr.gov.cn/bzgk/std/newGbInfo?hcno=2CB9E6DE13EC80AC29E4BC8DDBE8D039',text:'现行推荐性国家标准，2021-02-01实施。用于追问需求、设计确认及交付衔接；未把标准元数据当作完整条文。'},
{id:'chain',title:'国家标准技术审评中心：定制家具标准解读',url:'https://cc.sacinfo.org.cn/course?id=8a6dd8717cbb818f017f1fdb03d02ab9',text:'官方课程介绍强调按客户订单组织业务、个性化需求及多环节协同。产品由多种零部件和五金组成，交接与版本一致性值得核实。'},
{id:'wood',title:'GB/T 3324—2024 木家具通用技术条件：官方解读',url:'https://cc.sacinfo.org.cn/course?id=8a6dd871917d1d720193281a7c5971a9',text:'官方介绍涉及质量要求、检验、标志、使用说明、包装、运输和贮存。需按产品类别核实适用要求。'},
{id:'emissions',title:'GB 18584—2024 家具中有害物质限量',url:'https://openstd.samr.gov.cn/bzgk/std/newGbInfo?hcno=EDD0806C77509639A8CF71A08588AFE8',text:'现行强制性国家标准，2025-07-01实施。访谈核实企业采用的标准版本、检测报告与对应产品；AI文本判断不能替代检测。'},
{id:'safety',title:'GB 28008—2024 家具结构安全技术规范',url:'https://openstd.samr.gov.cn/bzgk/std/newGbInfo?hcno=4E869C8EBF3CD4591D4F4DFD96D54185',text:'现行强制性国家标准，2025-07-01实施。涉及结构安全的方案，需要专业复核、测量与相应验证。'},
{id:'manufacturing',title:'国家统计局：2026年1—7月工业企业财务指标',url:'https://www.stats.gov.cn/sj/zxfb/202608/t20260827_1965126.html',text:'家具制造业营业收入3004.4亿元，同比−8.6%；利润总额58.5亿元，同比−58.2%。口径为规模以上工业企业，不能等同于定制家居市场或单家企业表现。'},
{id:'retail',title:'国家统计局：2026年1—8月社会消费品零售数据',url:'https://www.stats.gov.cn/sj/zxfb/202609/t20260915_1965311.html',text:'限额以上单位家具类零售额1149亿元，同比−4.9%（名义增速）。零售与制造业统计范围不同，不可相加，也不用于代填企业收益。'}
];
export const INDUSTRY_QUESTIONS={
needs:'量房尺寸、客户需求及现场条件由谁确认？变更怎样传到设计与订单？',
marketing:'您如何记录客户意向、跟进承诺和转化结果？AI建议由谁审核后联系客户？',
design:'需求、方案和选材的版本怎样对应？客户签认后发生变更，谁通知报价与拆单？',
quote:'计价单位、价格版本、折扣权限和安装运输费用怎样核对？谁批准例外？',
review:'设计、报价与订单怎样按订单号及版本对应？冲突项由谁裁决，漏审怎样追溯？',
order:'订单字段与物料编码由谁维护？缺项或未审批变更怎样阻止进入生产？',
split:'BOM、板件尺寸、封边、孔位和五金规则是否可读取？几何与数控校验由什么系统完成？',
schedule:'排产使用的实际产能、缺料和工序进度多久更新？交期冲突谁能调整？',
production:'异常记录能否对应订单、设备和工序？已有处理方法是否经过验证？',
quality:'适用标准的版本、检测报告和产品批次怎样关联？谁负责实测及最终放行？',
logistics:'订单、包装件号和签收记录怎样对应？错漏发与破损有没有闭环记录？',
install:'现场尺寸、配件和安装条件谁在出发前确认？二次上门原因能否追溯到订单？',
service:'售后原因、责任调查、维修成本和原订单是否关联？哪些承诺必须人工批准？',
behavior:'跨环节操作人、时间、版本及审批日志能否按订单关联？异常由谁调查核实？',
economic:'报价、采购、生产成本和回款能否按订单勾稽？成本分摊及差异口径由谁确认？'
};
