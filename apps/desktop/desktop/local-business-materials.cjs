// Read-only, bounded extraction. Source text is evidence, never executable instructions.
const path = require('node:path');
const { unzipSync, strFromU8 } = require('fflate');
const { DOMParser } = require('@xmldom/xmldom');
const extensions = new Set(['.txt', '.md', '.csv', '.tsv', '.json', '.xlsx', '.docx', '.pptx', '.pdf']);
const MAX_FILE = 8 * 1024 * 1024;
const MAX_CHARACTERS = 400000;
const all = (node, name) => Array.from(node.getElementsByTagNameNS('*', name));
function xml(source) {
  if (/<!DOCTYPE|<!ENTITY/i.test(source)) throw new Error('文档含不支持的 XML 实体，请另存为标准 Office 文件');
  let invalid = false;
  const doc = new DOMParser({ onError: () => { invalid = true; } }).parseFromString(source, 'application/xml');
  if (invalid) throw new Error('Office 文档 XML 无法解析，请另存后重试');
  return doc;
}
function chunksOf(text, label) {
  const chunks = [];
  for (const [index, line] of text.replace(/\r\n?/g, '\n').split('\n').entries()) {
    const value = line.trim();
    for (let i = 0; i < value.length; i += 700) chunks.push({ location: `${label} ${index + 1}${i ? `（续${i}）` : ''}`, text: value.slice(i, i + 700) });
  }
  return chunks;
}
function entriesOf(bytes) {
  let count = 0, total = 0;
  return unzipSync(bytes, { filter: file => {
    if (++count > 3000) throw new Error('Office 文档内部文件过多，请拆分材料');
    if (!/^(word\/document.xml|xl\/(sharedStrings.xml|workbook.xml|_rels\/workbook.xml.rels|worksheets\/sheet\d+.xml)|ppt\/slides\/slide\d+.xml)$/.test(file.name)) return false;
    total += file.originalSize;
    if (file.originalSize > 6 * 1024 * 1024 || total > 16 * 1024 * 1024) throw new Error('Office 解压文字过大，请拆分材料');
    return true;
  } });
}
async function extractMaterial(name, bytes, signal) {
  signal.throwIfAborted();
  if (bytes.length > MAX_FILE) throw new Error('单份材料限 8 MiB，请拆分后提供');
  const extension = path.extname(name).toLowerCase();
  if (!extensions.has(extension)) throw new Error('不支持此格式，请提供 TXT/MD/CSV/TSV/JSON/XLSX/DOCX/PPTX/文字 PDF；旧版 Office 请先另存');
  let chunks = [], warnings = [];
  if (['.txt', '.md', '.csv', '.tsv', '.json'].includes(extension)) {
    let text = new TextDecoder('utf-8').decode(bytes).replace(/^\uFEFF/, '');
    if (text.includes('\uFFFD')) { text = new TextDecoder('gb18030').decode(bytes); warnings.push('已按 GB18030 容错解码，请核对文字'); }
    if (text.includes('\0')) throw new Error('文件含二进制内容，请提供可读文字材料');
    chunks = chunksOf(text, '原文行');
    if (['.csv', '.tsv'].includes(extension)) warnings.push('保留原始表格行；列含义、单位和统计口径须依据表头与用户确认，不自动推断');
  } else if (['.docx', '.xlsx', '.pptx'].includes(extension)) {
    const entries = entriesOf(bytes);
    const get = key => { if (!entries[key]) throw new Error('Office 文件结构不完整'); return xml(strFromU8(entries[key])); };
    if (extension === '.docx') {
      chunks = all(get('word/document.xml'), 'p').flatMap((p, i) => chunksOf(all(p, 't').map(t => t.textContent).join(''), `正文段落 ${i + 1} / 摘录`));
      warnings.push('仅读取正文及表格文字，不含图片、批注、页眉页脚');
    } else if (extension === '.pptx') {
      const slides = Object.keys(entries).filter(key => /^ppt\/slides\/slide\d+\.xml$/.test(key)).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
      chunks = slides.flatMap((key, i) => chunksOf(all(get(key), 't').map(t => t.textContent).join('\n'), `幻灯片 ${i + 1} / 摘录`));
      warnings.push('仅读取幻灯片文字，不含图片、讲稿备注和嵌入文件');
    } else {
      const shared = entries['xl/sharedStrings.xml'] ? all(get('xl/sharedStrings.xml'), 'si').map(s => all(s, 't').map(t => t.textContent).join('')) : [];
      const rels = all(get('xl/_rels/workbook.xml.rels'), 'Relationship');
      const sheets = all(get('xl/workbook.xml'), 'sheet');
      let cellCount = 0;
      for (const sheet of sheets) {
        const rel = rels.find(r => r.getAttribute('Id') === sheet.getAttribute('r:id'));
        const key = path.posix.normalize(path.posix.join('xl', (rel?.getAttribute('Target') || '').replace(/^\/?xl\//, '')));
        if (!/^xl\/worksheets\/sheet\d+\.xml$/.test(key)) throw new Error('不支持该工作表结构，请另存为标准 XLSX');
        const rows = all(get(key), 'row');
        if (rows.length > 10000) throw new Error('单表限 10000 行，请拆分数据');
        for (const row of rows) {
          const values = [];
          for (const c of all(row, 'c')) {
            if (++cellCount > 100000) throw new Error('材料超过 100000 个单元格，请拆分');
            const ref = c.getAttribute('r') || '';
            const match = /^([A-Z]+)([1-9]\d*)$/.exec(ref);
            const column = match?.[1].split('').reduce((n, v) => n * 26 + v.charCodeAt(0) - 64, 0);
            if (!match || column > 500 || Number(match[2]) > 10000) throw new Error('工作表范围超过 10000 行 / 500 列，请拆分');
            const raw = all(c, 'v')[0]?.textContent || '';
            const text = c.getAttribute('t') === 's' ? shared[Number(raw)] : c.getAttribute('t') === 'inlineStr' ? all(c, 't').map(t => t.textContent).join('') : raw;
            if (text) values.push(`${ref}=${text}`);
            if (all(c, 'f').length && !raw) warnings.push(`公式 ${sheet.getAttribute('name')}!${ref} 没有缓存值，不能用于计算`);
          }
          chunks.push(...chunksOf(values.join('；'), `工作表 ${sheet.getAttribute('name')} / 行 ${row.getAttribute('r')} / 摘录`));
        }
      }
      warnings.push('读取单元格原值/公式缓存值，不执行公式；日期可能为 Excel 序列值，请核对单位和期间');
    }
  } else {
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const task = pdfjs.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, useSystemFonts: true, disableFontFace: true });
    try {
      const pdf = await task.promise;
      if (pdf.numPages > 200) throw new Error('PDF 限 200 页，请拆分材料');
      for (let i = 1; i <= pdf.numPages; i++) {
        signal.throwIfAborted();
        const page = await pdf.getPage(i);
        const content = await page.getTextContent();
        const text = content.items.map(item => (item.str || '') + (item.hasEOL ? '\n' : ' ')).join('');
        if (!text.trim()) throw new Error(`PDF 第 ${i} 页没有可读文字，可能为扫描页；请先 OCR 或提供可读原件`);
        chunks.push(...chunksOf(text, `PDF 第 ${i} 页 / 原文行`));
      }
      warnings.push('仅文字层，不做 OCR；复杂表格阅读顺序和图片中的数字须人工核对');
    } finally { await task.destroy(); }
  }
  signal.throwIfAborted();
  const characters = chunks.reduce((total, c) => total + c.text.length, 0);
  if (characters < 3) throw new Error('没有提取到有效文字，请提供可读原件或先 OCR');
  if (characters > MAX_CHARACTERS) throw new Error('材料文字超过 40 万字，请按分析范围拆分');
  return { chunks, characters, warnings: [...new Set(warnings)] };
}
module.exports = { extractMaterial, extensions, MAX_FILE, MAX_CHARACTERS };
