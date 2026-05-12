import type { TableField, Template, TableRow } from './types';

export const TABLE_FIELDS: TableField[] = [
  { id: 'f_name', name: '客户名称', type: 'text', icon: 'A' },
  { id: 'f_amount', name: '合同金额', type: 'number', icon: '#' },
  { id: 'f_date', name: '签订日期', type: 'date', icon: '◷' },
  { id: 'f_contact', name: '联系人', type: 'text', icon: 'A' },
  { id: 'f_phone', name: '联系电话', type: 'phone', icon: '☎' },
  { id: 'f_owner', name: '业务负责人', type: 'person', icon: '◉' },
  { id: 'f_status', name: '状态', type: 'select', icon: '▤' },
  { id: 'f_logo', name: '公司 Logo', type: 'attachment', icon: '⎙' },
  { id: 'f_seal', name: '电子公章', type: 'attachment', icon: '⎙' },
  { id: 'f_remark', name: '备注', type: 'text', icon: 'A' },
];

export const TEMPLATES: Template[] = [
  {
    id: 'tpl_001',
    name: '标准商业合同模板',
    varCount: 8,
    updatedAt: '5 月 10 日',
    category: '合同类',
    kind: 'doc',
    variables: [
      { name: '客户名称', kind: 'text', suggested: 'f_name' },
      { name: '合同金额', kind: 'text', suggested: 'f_amount' },
      { name: '签订日期', kind: 'text', suggested: 'f_date' },
      { name: '联系人', kind: 'text', suggested: 'f_contact' },
      { name: '联系电话', kind: 'text', suggested: 'f_phone' },
      { name: '业务负责人', kind: 'text', suggested: 'f_owner' },
      { name: '备注', kind: 'text', suggested: 'f_remark' },
      { name: '客户 Logo', kind: 'image', suggested: 'f_logo' },
    ],
  },
  { id: 'tpl_002', name: '入职欢迎信', varCount: 5, updatedAt: '4 月 28 日', category: '通知类', kind: 'doc', variables: [] },
  { id: 'tpl_003', name: '月度销售报表', varCount: 12, updatedAt: '5 月 1 日', category: '报表类', kind: 'sheet', variables: [] },
  { id: 'tpl_004', name: '在职证明', varCount: 4, updatedAt: '3 月 21 日', category: '证明类', kind: 'doc', hasLogo: true, variables: [] },
  { id: 'tpl_005', name: '保密协议 (NDA)', varCount: 5, updatedAt: '5 月 8 日', category: '合同类', kind: 'doc', variables: [] },
  { id: 'tpl_006', name: '采购订单', varCount: 9, updatedAt: '4 月 12 日', category: '报表类', kind: 'sheet', variables: [] },
  { id: 'tpl_007', name: '会议通知', varCount: 6, updatedAt: '4 月 30 日', category: '通知类', kind: 'doc', variables: [] },
  { id: 'tpl_008', name: '收入证明', varCount: 5, updatedAt: '3 月 18 日', category: '证明类', kind: 'doc', variables: [] },
];

export const CATEGORIES = ['全部', '合同类', '通知类', '报表类', '证明类'];

export const TABLE_ROWS: TableRow[] = [
  { 客户名称: '上海测试科技有限公司', 合同金额: '¥ 128,000', 签订日期: '2026-05-10', 联系人: '王晓东', 状态: '待生成' },
  { 客户名称: '北京远望咨询有限公司', 合同金额: '¥ 86,500', 签订日期: '2026-05-09', 联系人: '李蔚然', 状态: '待生成' },
  { 客户名称: '深圳云岚数据科技', 合同金额: '¥ 245,000', 签订日期: '2026-05-08', 联系人: '陈柏舟', 状态: '已生成' },
  { 客户名称: '杭州青屿网络', 合同金额: '¥ 52,800', 签订日期: '2026-05-08', 联系人: '林婧', 状态: '待生成' },
  { 客户名称: '广州海枫贸易', 合同金额: '¥ 71,200', 签订日期: '2026-05-07', 联系人: '苏夏', 状态: '已生成' },
  { 客户名称: '成都晨星制造', 合同金额: '¥ 318,400', 签订日期: '2026-05-07', 联系人: '高远', 状态: '待生成' },
  { 客户名称: '南京启明信息', 合同金额: '¥ 96,000', 签订日期: '2026-05-06', 联系人: '徐怀谦', 状态: '失败' },
  { 客户名称: '西安信合科技', 合同金额: '¥ 42,300', 签订日期: '2026-05-06', 联系人: '何渚', 状态: '待生成' },
  { 客户名称: '武汉惠新能源', 合同金额: '¥ 188,900', 签订日期: '2026-05-05', 联系人: '范知秋', 状态: '待生成' },
  { 客户名称: '青岛朝海贸易', 合同金额: '¥ 64,500', 签订日期: '2026-05-05', 联系人: '韩烁', 状态: '已生成' },
  { 客户名称: '重庆星桥实业', 合同金额: '¥ 215,000', 签订日期: '2026-05-04', 联系人: '叶宁', 状态: '待生成' },
  { 客户名称: '苏州微岭半导体', 合同金额: '¥ 432,800', 签订日期: '2026-05-04', 联系人: '罗谨之', 状态: '待生成' },
];
