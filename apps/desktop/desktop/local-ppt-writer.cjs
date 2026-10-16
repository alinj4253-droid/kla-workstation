const fs = require('node:fs/promises');
const path = require('node:path');
const PptxGenJS = require('pptxgenjs');

const EMU_PER_INCH = 914400;
const inch = value => Number(value || 0) / EMU_PER_INCH;
const clamp = (value, low, high) => Math.max(low, Math.min(high, value));

function color(fill) {
  const selection = fill?.egColorChoice?.srgbClr;
  if (!selection?.val || !/^[0-9a-f]{6}$/i.test(selection.val)) return null;
  const alpha = selection.egColorTransform?.find(item => item.alpha)?.alpha?.val;
  return { color: selection.val.toUpperCase(), transparency: alpha == null ? 0 : clamp(100 - Number(alpha) / 1000, 0, 100) };
}

function position(shape) {
  const xfrm = shape.spPr?.xfrm;
  if (!xfrm?.off || !xfrm?.ext) throw new Error('slidep 页面元素缺少布局坐标');
  return { x: inch(xfrm.off.x), y: inch(xfrm.off.y), w: inch(xfrm.ext.cx), h: inch(xfrm.ext.cy) };
}

function shapeType(pptx, shape) {
  const preset = shape.spPr?.prstGeom?.prst;
  if (shape.spPr?.custGeom) throw new Error('PPT 自定义几何暂不支持，已阻止交付不完整文件');
  if (preset === 26) return pptx.ShapeType.roundRect;
  if (preset === 3) return pptx.ShapeType.ellipse;
  if (preset === 5) return pptx.ShapeType.rect;
  throw new Error(`PPT 几何类型 ${preset} 暂不支持，已阻止交付不完整文件`);
}

function paragraphRuns(shape) {
  const paragraphs = shape.txBody?.p || [];
  const runs = [];
  for (let index = 0; index < paragraphs.length; index++) {
    const paragraph = paragraphs[index];
    for (const item of paragraph.egTextRun || []) {
      const r = item.r;
      if (!r) continue;
      const style = r.rPr || {};
      const fill = color(style.solidFill);
      runs.push({ text: String(r.t || ''), options: {
        fontSize: clamp(Number(style.sz || 1800) / 100, 1, 120),
        fontFace: style.ea?.typeface || style.latin?.typeface || 'Microsoft YaHei',
        ...(fill ? { color: fill.color } : {}),
        bold: Boolean(style.b), italic: Boolean(style.i),
        breakLine: false,
      } });
    }
    if (index < paragraphs.length - 1) runs.push({ text: '\n', options: {} });
  }
  return runs;
}

function addText(slide, shape) {
  const runs = paragraphRuns(shape);
  if (!runs.length) return false;
  const box = position(shape);
  if (box.w <= 0 || box.h <= 0) return false;
  const paragraph = shape.txBody.p?.[0];
  const align = { 1: 'left', 2: 'center', 3: 'right', 4: 'justify' }[paragraph?.pPr?.algn] || 'left';
  const fill = color(shape.spPr?.solidFill);
  const line = color(shape.spPr?.ln?.egLineFillProperties?.solidFill);
  slide.addText(runs, { ...box, margin: 0, breakLine: false, valign: 'mid', align,
    ...(fill ? { fill } : {}),
    ...(line ? { line: { ...line, width: inch(shape.spPr.ln.w || 0) * 72 } } : {}),
    ...(shape.spPr?.xfrm?.rot ? { rotate: shape.spPr.xfrm.rot / 60000 } : {}),
  });
  return true;
}

function interpolate(hexA, hexB, ratio) {
  const a = Number.parseInt(hexA, 16), b = Number.parseInt(hexB, 16);
  const channel = shift => Math.round(((a >> shift) & 255) * (1 - ratio) + ((b >> shift) & 255) * ratio);
  return [channel(16), channel(8), channel(0)].map(value => value.toString(16).padStart(2, '0')).join('').toUpperCase();
}

function addGradient(slide, pptx, shape, box) {
  const stops = shape.spPr.gradFill?.gsLst?.gs || [];
  const first = color(stops[0]);
  const last = color(stops.at(-1));
  if (!first || !last) throw new Error('slidep 渐变色格式无法写入 PPTX');
  const vertical = box.h > box.w * 1.3;
  const count = 20;
  for (let index = 0; index < count; index++) {
    const fraction = index / Math.max(1, count - 1);
    const fill = { color: interpolate(first.color, last.color, fraction),
      transparency: first.transparency * (1 - fraction) + last.transparency * fraction };
    const piece = vertical
      ? { x: box.x, y: box.y + (box.h * index / count), w: box.w, h: box.h / count + 0.002 }
      : { x: box.x + (box.w * index / count), y: box.y, w: box.w / count + 0.002, h: box.h };
    slide.addShape(pptx.ShapeType.rect, { ...piece, fill, line: { color: fill.color, transparency: 100, width: 0 } });
  }
}

function addShape(slide, pptx, shape) {
  if (shape.txBody) {
    if (shape.spPr?.gradFill) addGradient(slide, pptx, shape, position(shape));
    return addText(slide, shape);
  }
  const box = position(shape);
  if (box.w <= 0 || box.h <= 0) return false;
  if (shape.spPr?.gradFill) { addGradient(slide, pptx, shape, box); return true; }
  const fill = color(shape.spPr?.solidFill);
  const line = color(shape.spPr?.ln?.egLineFillProperties?.solidFill);
  if (!fill && !line) return false;
  slide.addShape(shapeType(pptx, shape), { ...box, fill: fill || { color: 'FFFFFF', transparency: 100 },
    line: line ? { ...line, width: inch(shape.spPr?.ln?.w || 0) * 72 } : { color: 'FFFFFF', transparency: 100, width: 0 },
  });
  return true;
}

function addImage(slide, shape, resources) {
  const ref = shape.blipFill?.blip?.embed;
  const asset = resources?.images?.[ref];
  if (!ref || !asset?.src || !String(asset.src).startsWith('data:image/')) throw new Error('PPT 图片素材未正确加载，已阻止生成占位图');
  const box = position(shape);
  slide.addImage({ data: asset.src, ...box, sizing: { type: 'cover', w: box.w, h: box.h } });
  return true;
}

function addChart(slide, pptx, shape) {
  const chart = shape.chartSpace?.chart;
  const definition = chart?.plotArea?.charts?.[0];
  if (!definition) throw new Error('PPT 图表缺少数据');
  const chartType = { 11: pptx.ChartType.bar, 3: pptx.ChartType.line, 8: pptx.ChartType.pie }[definition.type];
  if (!chartType) throw new Error(`暂不支持 slidep 图表类型 ${definition.type}，未交付不完整 PPTX`);
  const series = (definition.ser || []).map((item, index) => ({
    name: item.tx?.strRef?.strCache?.pt?.[0]?.v || `系列 ${index + 1}`,
    labels: (item.categories || []).map(point => String(point.categoryPoint?.value ?? point.categoryPoint?.v ?? '')),
    values: (item.categories || []).map(point => Number(point.valuePoint?.value ?? point.valuePoint?.v ?? 0)),
  }));
  if (!series.length || series.some(item => item.labels.length !== item.values.length)) throw new Error('PPT 图表序列无效');
  const title = chart.title?.tx?.rich?.p?.flatMap(p => (p.egTextRun || []).map(item => item.r?.t || '')).join('') || '';
  const chartColors = definition.type === 8
    ? (definition.ser?.[0]?.categories || []).map(item => color(item.dataPoint?.spPr?.solidFill)?.color || '2F6BE4')
    : (definition.ser || []).map(item => color(item.spPr?.solidFill)?.color
      || color(item.spPr?.ln?.egLineFillProperties?.solidFill)?.color || '2F6BE4');
  const box = position(shape);
  slide.addChart(chartType, series, { ...box, showTitle: Boolean(title), title, showLegend: Boolean(chart.legend),
    showValue: Boolean(definition.ser?.[0]?.dLbls?.showVal?.val),
    chartColors,
    ...(definition.type === 11 ? { barDir: definition.barDir?.val === 1 ? 'bar' : 'col' } : {}),
    showCatName: false, showSerName: false,
    catAxisLabelFontSize: 10, valAxisLabelFontSize: 10,
    showBorder: false,
    ...(definition.type === 11 ? { catAxisLabelPos: 'low', valAxisLabelPos: 'low' } : {}),
  });
  return true;
}

function renderPage(pptx, layout) {
  const shapes = layout?.cSld?.spTree?.shapeList;
  if (!Array.isArray(shapes)) throw new Error('slidep 未返回完整页面布局');
  const canvas = shapes[0]?.spPr?.xfrm;
  if (Math.abs(Number(canvas?.ext?.cx) - 12192000) > 1000 || Math.abs(Number(canvas?.ext?.cy) - 6858000) > 1000) {
    throw new Error('当前 PPT 画布仅支持 1280×720；请按 DESIGN.md 调整页面尺寸');
  }
  const slide = pptx.addSlide();
  let count = 0;
  for (const shape of shapes) {
    if (shape.type === 7) count += Number(addShape(slide, pptx, shape));
    else if (shape.type === 10) count += Number(addImage(slide, shape, layout.resources));
    else if (shape.type === 12) count += Number(addChart(slide, pptx, shape));
    else throw new Error(`暂不支持 slidep 页面元素类型 ${shape.type}，未交付不完整 PPTX`);
  }
  if (!count) throw new Error('页面没有可写入的内容');
  return count;
}

async function writeDeck({ pages, deck, output, engine, command, signal, nodeRuntime, runner }) {
  const pptx = new PptxGenJS();
  pptx.defineLayout({ name: 'KLA_1280_720', width: 1280 / 96, height: 720 / 96 });
  pptx.layout = 'KLA_1280_720';
  pptx.author = '鲲擎 PPT 助手';
  pptx.subject = '基于 pptx-deck-builder DSL 与 Yoga 布局生成';
  pptx.lang = 'zh-CN';
  let nativeObjectCount = 0;
  for (const page of pages) {
    signal.throwIfAborted();
    const source = path.join(output, 'slides', `${String(page.pageNumber).padStart(2, '0')}.slide`);
    const layoutFile = path.join(output, 'slides', `${String(page.pageNumber).padStart(2, '0')}.layout.json`);
    const proc = await command(nodeRuntime.executable,
      [runner, '--kla-layout', source, layoutFile, path.join(path.dirname(engine), 'slidep.js'), output],
      output, 120_000, signal, nodeRuntime.env);
    if (proc.exitCode !== 0) throw new Error(`第 ${page.pageNumber} 页布局转换失败：${(proc.stderr || proc.stdout).slice(-1000)}`);
    const parsed = JSON.parse(await fs.readFile(layoutFile, 'utf8'));
    if (!parsed.ok || !parsed.layout || parsed.failures?.length) throw new Error(`第 ${page.pageNumber} 页有未加载的图片素材：${parsed.failures?.[0]?.href || '未知素材'}`);
    nativeObjectCount += renderPage(pptx, { ...parsed.layout, resources: parsed.resources });
    await fs.unlink(layoutFile);
  }
  await pptx.writeFile({ fileName: deck });
  const stat = await fs.stat(deck);
  if (stat.size < 2000 || stat.size > 16 * 1024 * 1024) throw new Error('生成的 PPTX 大小无效或超过 16 MiB 限制');
  return { nativeObjectCount, sizeBytes: stat.size };
}

module.exports = { writeDeck };
