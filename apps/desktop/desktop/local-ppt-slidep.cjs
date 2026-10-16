const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { validateSource } = require('./local-ppt-dsl-safety.cjs');
const { writeDeck } = require('./local-ppt-writer.cjs');

const FORMAT = 'pptx-deck-builder/v1';
const MAX_SLIDES = 60;
const IMAGE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]*\.(png|jpe?g|webp)$/i;

function resourceDirectory() {
  return process.resourcesPath && !process.defaultApp
    ? path.join(process.resourcesPath, 'skills', 'pptx-deck-builder')
    : path.join(__dirname, '..', 'resources', 'skills', 'pptx-deck-builder');
}

function nodeRuntime() {
  const env = { ...process.env, NODE_PATH: [path.join(__dirname, '..', 'node_modules'), process.env.NODE_PATH].filter(Boolean).join(path.delimiter) };
  if (process.env.KLA_SLIDEP_NODE) return { executable: process.env.KLA_SLIDEP_NODE, env };
  return process.versions.electron
    ? { executable: process.execPath, env: { ...env, ELECTRON_RUN_AS_NODE: '1' } }
    : { executable: process.execPath, env };
}

async function engineCommand(engine, arguments_, cwd, timeoutMs, signal, command, env) {
  const runtime = nodeRuntime();
  return command(runtime.executable, [engine, ...arguments_], cwd, timeoutMs, signal, env || runtime.env);
}

function parseJsonOutput(output) {
  const lines = String(output || '').trim().split(/\r?\n/).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index--) {
    try { return JSON.parse(lines[index]); } catch { /* Engine logs may precede the JSON result. */ }
  }
  throw new Error('slidep 未返回有效 JSON');
}

async function lint(engine, deck, slide, cwd, signal, command) {
  try { validateSource(await fs.readFile(slide, 'utf8')); }
  catch (error) { return { ok: false, diagnostics: [{ severity: 'error', message: error.message }], exitCode: 1 }; }
  const proc = await engineCommand(engine, ['lint', deck, '--dsl-file', slide], cwd, 120_000, signal, command);
  try {
    const result = parseJsonOutput(proc.stdout);
    return { ok: proc.exitCode === 0 && result.ok === true,
      diagnostics: Array.isArray(result.diagnostics) ? result.diagnostics : [], exitCode: proc.exitCode };
  } catch (error) {
    return { ok: false, diagnostics: [{ severity: 'error', message: `${error.message}: ${(proc.stderr || proc.stdout).slice(-1200)}` }], exitCode: proc.exitCode };
  }
}

function checkSource(source) {
  validateSource(source);
  return source;
}

async function previousDeck(root, documentId, within) {
  const candidate = path.resolve(root, documentId);
  if (!within(candidate, root)) throw new Error('PPT 文档编号不属于当前身份');
  const realRoot = await fs.realpath(root);
  const realFile = await fs.realpath(candidate);
  if (!within(realFile, realRoot) || path.extname(realFile).toLowerCase() !== '.pptx') throw new Error('PPT 文档编号不属于当前身份');
  const directory = path.dirname(realFile);
  let source;
  try { source = JSON.parse(await fs.readFile(path.join(directory, 'deck.source.json'), 'utf8')); }
  catch { throw new Error('原稿没有新版 DSL 源码，请按新流程重新构建'); }
  if (source.format !== FORMAT || !Array.isArray(source.slides) || !Array.isArray(source.assets)
    || source.slides.length > MAX_SLIDES || source.slides.some((slide, index) => slide.pageNumber !== index + 1 || typeof slide.source !== 'string')) {
    throw new Error('PPT 源码清单无效');
  }
  return { file: realFile, directory, source };
}

async function copyAssets(inputAssets, previous, output, root, approved, helpers) {
  const directory = path.join(output, 'assets');
  await fs.mkdir(directory, { recursive: true });
  const files = new Map();
  for (const asset of previous?.source.assets || []) {
    if (!IMAGE_NAME.test(asset.fileName)) throw new Error('旧 PPT 素材清单无效');
    const source = await fs.realpath(path.join(previous.directory, 'assets', asset.fileName));
    if (!helpers.within(source, await fs.realpath(previous.directory))) throw new Error('旧 PPT 素材路径越界');
    const bytes = await fs.readFile(source);
    files.set(asset.fileName, bytes);
  }
  for (const asset of inputAssets || []) {
    if (!IMAGE_NAME.test(asset.fileName)) throw new Error('素材文件名仅支持英文数字及 PNG/JPEG/WebP');
    const source = await helpers.approvedReadPath(helpers.absolute(asset.sourcePath), root, approved);
    const stat = await fs.stat(source);
    if (!stat.isFile() || stat.size > 8 * 1024 * 1024) throw new Error('单份 PPT 素材限 8 MiB');
    files.set(asset.fileName, await fs.readFile(source));
  }
  if (files.size > 40) throw new Error('单份 PPT 最多 40 个素材');
  const total = [...files.values()].reduce((sum, bytes) => sum + bytes.length, 0);
  if (total > 24 * 1024 * 1024 || [...files.values()].some(bytes => bytes.length > 8 * 1024 * 1024)) throw new Error('PPT 素材总计限 24 MiB');
  for (const [name, bytes] of files) await fs.writeFile(path.join(directory, name), bytes);
  return [...files].map(([fileName, bytes]) => ({ fileName, sizeBytes: bytes.length, checksum: createHash('sha256').update(bytes).digest('hex') }));
}

/** Build in a fresh call workspace. The old deck is copied, never modified in place. */
async function build(args, root, call, workspace, signal, approved, helpers, engine) {
  if (args.specJson !== undefined) return { result: { error: '旧版语义 JSON 流程已停用；请提供 STORY、DESIGN 与逐页 DSL' } };
  const previous = args.documentId ? await previousDeck(root, args.documentId, helpers.within) : null;
  const storyMarkdown = args.storyMarkdown || previous?.source.storyMarkdown;
  const designMarkdown = args.designMarkdown || previous?.source.designMarkdown;
  if (typeof storyMarkdown !== 'string' || storyMarkdown.trim().length < 20
    || typeof designMarkdown !== 'string' || designMarkdown.trim().length < 20) {
    throw new Error('首次构建必须提供 STORY.md 和 DESIGN.md；改稿可沿用上一版');
  }
  const changes = args.slides || [];
  if (!previous && !changes.length) throw new Error('首次构建至少需要一页 DSL');
  if (changes.length > 20 || changes.reduce((sum, slide) => sum + String(slide.source || '').length, 0) > 1_000_000) {
    throw new Error('单次最多提交 20 页、100 万字符 DSL；较长文稿请分批构建');
  }
  const requestedName = helpers.filename(args.fileName || (previous ? path.basename(previous.file) : '演示文稿.pptx'));
  if (!requestedName.toLowerCase().endsWith('.pptx')) throw new Error('成果文件名必须以 .pptx 结尾');
  const name = workspace.output.length + requestedName.length + 1 > 259
    ? `ppt-${String(call.id).replaceAll('-', '').slice(0, 8)}.pptx` : requestedName;
  const deck = path.join(workspace.output, name);
  const slidesDirectory = path.join(workspace.output, 'slides');
  await fs.mkdir(slidesDirectory, { recursive: true });
  const assets = await copyAssets(args.assets, previous, workspace.output, root, approved, helpers);
  const pages = previous ? previous.source.slides.map(slide => ({ pageNumber: slide.pageNumber, source: slide.source })) : [];
  const lintContext = path.join(workspace.work, 'slidep-blank.pptx');
  await fs.copyFile(path.join(path.dirname(engine), 'resources', 'pptx', 'blank.pptx'), lintContext);
  const diagnostics = [];
  const seen = new Set();
  for (const change of changes) {
    signal.throwIfAborted();
    const pageNumber = Number(change.pageNumber);
    if (!Number.isInteger(pageNumber) || pageNumber < 1 || pageNumber > MAX_SLIDES || seen.has(pageNumber)) {
      throw new Error('PPT 页码必须在 1–60 之间且单次调用内唯一');
    }
    seen.add(pageNumber);
    if (pageNumber > pages.length + 1) throw new Error(`第 ${pageNumber} 页不能跳过第 ${pages.length + 1} 页`);
    const source = checkSource(change.source);
    if (pageNumber <= pages.length) pages[pageNumber - 1] = { pageNumber, source };
    else pages.push({ pageNumber, source });
  }
  if (!pages.length || pages.length > MAX_SLIDES) throw new Error('演示文稿必须包含 1–60 页');
  for (const page of pages) {
    signal.throwIfAborted();
    const slideFile = path.join(slidesDirectory, `${String(page.pageNumber).padStart(2, '0')}.slide`);
    await fs.writeFile(slideFile, checkSource(page.source), 'utf8');
    const checked = await lint(engine, lintContext, slideFile, workspace.output, signal, helpers.command);
    diagnostics.push({ pageNumber: page.pageNumber, ...checked });
    if (!checked.ok) return { result: { error: `第 ${page.pageNumber} 页未通过 slidep 布局校验；成果未交付`,
      qc: { ok: false, blocked: 1, mode: 'slidep-layout', diagnostics }, renderStatus: 'not_requested' } };
  }
  const written = await writeDeck({ pages, deck, output: workspace.output, engine,
    command: helpers.command, signal, nodeRuntime: nodeRuntime(), runner: path.join(__dirname, 'local-ppt-layout-runner.cjs') });
  const header = Buffer.alloc(4);
  const handle = await fs.open(deck, 'r');
  try { await handle.read(header, 0, 4, 0); } finally { await handle.close(); }
  if (!header.equals(Buffer.from([80, 75, 3, 4]))) throw new Error('PPTX 写入格式无效');
  await fs.writeFile(path.join(workspace.output, 'STORY.md'), storyMarkdown, 'utf8');
  await fs.writeFile(path.join(workspace.output, 'DESIGN.md'), designMarkdown, 'utf8');
  for (const page of pages) await fs.writeFile(path.join(slidesDirectory, `${String(page.pageNumber).padStart(2, '0')}.slide`), page.source, 'utf8');
  const manifest = { format: FORMAT, storyMarkdown, designMarkdown, slides: pages, assets };
  const sourceFile = path.join(workspace.output, 'deck.source.json');
  await fs.writeFile(sourceFile, JSON.stringify(manifest, null, 2), 'utf8');
  const qc = { ok: true, blocked: 0, mode: 'slidep-layout-native-pptx', pageCount: pages.length,
    nativeObjectCount: written.nativeObjectCount, sizeBytes: written.sizeBytes, diagnostics };
  const qcFile = path.join(workspace.output, 'deck.qc.json');
  await fs.writeFile(qcFile, JSON.stringify(qc, null, 2), 'utf8');
  const documentId = path.relative(root, deck).split(path.sep).join('/');
  const result = { documentId, pageCount: pages.length, qc, renderStatus: 'not_requested' };
  if (args.finalize === false) return { result: { ...result, draft: true, uploaded: false } };
  return { result, files: [deck, sourceFile, qcFile], deck };
}

module.exports = { FORMAT, resourceDirectory, nodeRuntime, engineCommand, parseJsonOutput, lint, build };
