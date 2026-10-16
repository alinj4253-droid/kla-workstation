const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');
const { createHash } = require('node:crypto');

const engine = process.argv[5] || (process.resourcesPath && !process.defaultApp
  ? path.join(process.resourcesPath, 'skills', 'deck-agent-kit', 'vendor', 'slidep', 'slidep.js')
  : path.join(__dirname, '..', 'resources', 'skills', 'deck-agent-kit', 'vendor', 'slidep', 'slidep.js'));
const source = fs.readFileSync(engine, 'utf8');
const expectedHash = '11df0769b3ec3024c7cf11cd0b3b7fbcfb7a0e98ef85ee0c2e8249706d66c4b7';
if (createHash('sha256').update(source).digest('hex') !== expectedHash) {
  throw new Error('slidep layout adapter requires the tested bundled engine version');
}
const marker = 'bLe(wze[0]);';
if (source.indexOf(marker) !== source.lastIndexOf(marker) || !source.includes(marker)) {
  throw new Error('slidep layout adapter is incompatible with the bundled engine');
}

const injected = source.replace(marker, `
  if (wze[0] === '--kla-layout') {
    (async () => {
      hPe();
      const file = require('node:path').resolve(process.argv[3]);
      const dsl = require('node:fs').readFileSync(file, 'utf8');
      const { jsxTree } = GB.evaluateJsxInput(dsl, { development: false });
      const resolver = new GB.IconResolver();
      const loader = new GB.NodeImageLoadService(undefined, process.argv[6] || require('node:path').dirname(file));
      loader.addURLResourceResolver(resolver);
      const manager = GB.createSlideManagerJsx({ imageLoadService: loader });
      await manager.insert(jsxTree, { jsxCode: dsl });
      const layout = (await manager.layout(0, { validateOverflow: false })).data;
      const resources = manager.getResources();
      const fileSystem = require('node:fs');
      const base = fileSystem.realpathSync(process.cwd());
      let imageBytes = 0;
      for (const image of Object.values(resources.images || {})) {
        if (typeof image.src !== 'string') throw new Error('slidep image resource has no source');
        if (image.src.startsWith('data:image/')) continue;
        const resolved = fileSystem.realpathSync(image.src);
        const relative = require('node:path').relative(base, resolved);
        if (relative.startsWith('..') || require('node:path').isAbsolute(relative)) throw new Error('slidep image escaped the task workspace');
        const extension = require('node:path').extname(resolved).toLowerCase();
        const mime = ({ '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.svg': 'image/svg+xml' })[extension];
        if (!mime) throw new Error('slidep returned unsupported image media');
        const bytes = fileSystem.readFileSync(resolved);
        imageBytes += bytes.length;
        if (imageBytes > 32 * 1024 * 1024) throw new Error('PPT image media exceeds 32 MiB');
        image.src = 'data:' + mime + ';base64,' + bytes.toString('base64');
      }
      fileSystem.writeFileSync(process.argv[4], JSON.stringify({ ok: true, layout, resources, failures: loader.getFailures() }));
      process.stdout.write(JSON.stringify({ ok: true, shapeCount: layout.cSld?.spTree?.shapeList?.length || 0 }) + '\\n');
    })().catch(error => {
      process.stderr.write(String(error.stack || error) + '\\n');
      process.exitCode = 1;
    });
  } else bLe(wze[0]);
`);
const compiled = new Module(engine, module);
compiled.filename = engine;
// The archived slidep bundle lives in extraResources, while its native Node
// dependencies are packaged with the Electron app. Keep vendor-local modules
// as a development fallback, but never depend on ignored vendor/node_modules.
compiled.paths = [path.join(__dirname, '..', 'node_modules'), ...Module._nodeModulePaths(path.dirname(engine))];
compiled._compile(injected, engine);
