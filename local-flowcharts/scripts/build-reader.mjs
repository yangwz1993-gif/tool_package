// Thin host for LikeC4's public React viewer; no alternate layout or router.
import {createRequire} from 'node:module';
import {pathToFileURL, fileURLToPath} from 'node:url';
import {readFile, writeFile, cp, mkdir} from 'node:fs/promises';
import {resolve, dirname} from 'node:path';
const [runtime, output, title = '流程图', language = 'zh-CN'] = process.argv.slice(2);
const require = createRequire(resolve(runtime, 'package.json'));
const {build} = await import(pathToFileURL(require.resolve('vite')).href);
const {viteSingleFile} = await import(pathToFileURL(require.resolve('vite-plugin-singlefile')).href);
const expected = JSON.parse(await readFile(resolve(output, 'expected.json'), 'utf8'));
const raw = JSON.parse(await readFile(resolve(output, 'exports/model.json'), 'utf8'));
const models = Array.isArray(raw) ? raw : [raw];
if (models.length !== 1) throw new Error('Reading entry currently supports one project');
const model = models[0];
if (Object.keys(model.views).length !== 1 || !model.views.index) throw new Error('Reading entry requires a single index view');
if (expected.reading?.mode !== 'pan-zoom') throw new Error('Reading entry requires pan-zoom reading mode');
const scale = expected.reading.scale ?? 1;
if (!Number.isFinite(scale) || scale < 0.15 || scale > 1) throw new Error('Invalid initial reading scale');
const root = resolve(output, 'reader-source');
await mkdir(root);
await cp(resolve(dirname(fileURLToPath(import.meta.url)), '../assets/reader'), root, {recursive:true});
await writeFile(resolve(root, 'model.json'), JSON.stringify(model));
await writeFile(resolve(root, 'reader-options.json'), JSON.stringify({title, scale}));
let css = '';
if (expected.viewer_css) {
  const source = resolve(output, 'source');
  const path = resolve(source, expected.viewer_css);
  if (!path.startsWith(source + '/')) throw new Error('Viewer CSS must be inside the source folder');
  css = await readFile(path, 'utf8');
}
await writeFile(resolve(root, 'diagram.css'), css);
const html = await readFile(resolve(root, 'index.html'), 'utf8');
const escape = value => value.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
await writeFile(resolve(root, 'index.html'), html.replace('<title>流程图</title>', `<title>${escape(title)}</title>`).replace('lang="zh-CN"', `lang="${language}"`));
const imports = ['likec4/react', '@likec4/core/model', 'react-dom/client', 'react/jsx-runtime', 'react'];
await build({
  configFile:false, root, base:'./', publicDir:false,
  resolve:{alias:imports.map(name => ({find:new RegExp('^' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$'), replacement:require.resolve(name)})), dedupe:['react','react-dom']},
  plugins:[viteSingleFile()],
  build:{outDir:resolve(output, 'dist'), emptyOutDir:true, reportCompressedSize:false, target:'es2022'},
});
console.log('Built reading entry with LikeC4 React; initial reading zoom ' + scale);
