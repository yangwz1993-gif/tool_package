// Static packaging/rendering only; no browser automation.
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {readFile, writeFile, readdir, mkdir} from 'node:fs/promises';
import {resolve, extname} from 'node:path';
import {renderSnapshot} from './render-snapshot.mjs';
const [runtime, output, language = 'zh-CN'] = process.argv.slice(2);
const require = createRequire(resolve(runtime, 'package.json'));
const {Graphviz} = await import(pathToFileURL(require.resolve('@hpcc-js/wasm-graphviz')).href);
const {Resvg} = require('@resvg/resvg-js');
const dist = resolve(output, 'dist');
const expected = JSON.parse(await readFile(resolve(output, 'expected.json'), 'utf8'));
const exported = JSON.parse(await readFile(resolve(output, 'exports/model.json'), 'utf8'));
const models = Array.isArray(exported) ? exported : [exported];
let html = await readFile(resolve(dist, 'index.html'), 'utf8');
for (const match of html.matchAll(/<link\b[^>]*rel="icon"[^>]*href="([^"#]+)"[^>]*>/g)) {
  const href = match[1];
  if (href.startsWith('data:')) continue;
  const path = resolve(dist, href);
  if (/^[a-z]+:|^\/\//i.test(href) || !path.startsWith(dist + '/')) throw new Error(`Unexpected favicon: ${href}`);
  const bytes = await readFile(path);
  const mime = extname(path) === '.svg' ? 'image/svg+xml' : 'image/x-icon';
  html = html.replace(match[0], match[0].replace(href, `data:${mime};base64,${bytes.toString('base64')}`));
}
html = html.replace(/<html lang="[^"]*">/, `<html lang="${language}">`);
if (expected.viewer_css) {
  const source = resolve(output, 'source');
  const path = resolve(source, expected.viewer_css);
  if (!path.startsWith(source + '/')) throw new Error('Viewer CSS must be inside the source folder');
  const css = await readFile(path, 'utf8');
  if (/<\/style/i.test(css)) throw new Error('Unexpected closing style tag in viewer CSS');
  html = html.replace('</head>', `<style data-local-flowcharts-theme>\n${css}\n</style></head>`);
}
await writeFile(resolve(output, 'flow.html'), html);
const graphviz = await Graphviz.load();
const preview = expected.preview ?? {};
if (preview.theme && !['light','dark'].includes(preview.theme)) throw new Error('Unknown preview theme');
if (preview.scale !== undefined && (!Number.isFinite(preview.scale) || preview.scale <= 0 || preview.scale > 3)) throw new Error('Preview scale must be in (0, 3]');
for (const dir of ['svg','png']) await mkdir(resolve(output, 'exports', dir), {recursive:true});
for (const file of await readdir(resolve(output, 'exports/dot'))) {
  if (!file.endsWith('.dot')) continue;
  const dot = await readFile(resolve(output, 'exports/dot', file), 'utf8');
  // LikeC4 1.59.4 hardcodes Graphviz compound titles to 11pt, ignoring textSize.
  // Enlarge only cluster headers in this optional static rendition. Preserve
  // the native DOT and HTML; Graphviz recomputes the preview's geometry.
  let previewDot = dot.replace('bgcolor=transparent', 'bgcolor="#111827"')
    .replace(/(subgraph [^{]+\{\s*graph \[[\s\S]*?label=<<FONT POINT-SIZE=")11("[^>]*>)/g, (_, head, tail) => head + '14' + tail);
  if (preview.theme === 'light') {
    // Optional light static rendition. Native DOT is kept unchanged. Graphviz
    // recomputes the preview geometry; this is not the HTML viewer's rendering.
    previewDot = dot.replace('bgcolor=transparent', 'bgcolor="#f8fafc"')
      .replaceAll('BGCOLOR="#18191BA0"', 'BGCOLOR="#ffffff"')
      .replaceAll('penwidth=0', 'penwidth=1')
      .replaceAll('style=filled', 'style="rounded,filled"')
      .replace(/(subgraph [^{]+\{\s*graph \[)([\s\S]*?)(\];)/g, (_, start, attrs, end) => start + attrs
        .replace(/color="[^"]*"/, 'color="#d4dde7"')
        .replace(/fillcolor="[^"]*"/, 'fillcolor="#f1f5f9"')
        .replace('POINT-SIZE="11"', 'POINT-SIZE="18"')
        .replace(/COLOR="[^"]*"/, 'COLOR="#526379"') + end);
  }
  const viewId = file.replace(/\.dot$/, '');
  const model = models.find(m => m.views[viewId]);
  const view = model?.views[viewId];
  const svg = view?._layout === 'manual' ? renderSnapshot(view, model.project.styles.theme) : graphviz.dot(previewDot);
  await writeFile(resolve(output, 'exports/svg', file.replace(/\.dot$/, '.svg')), svg);
  const fitTo = preview.scale ? {mode:'zoom',value:preview.scale} : {mode:'height',value:750};
  const png = new Resvg(svg, {fitTo, font:{loadSystemFonts:true}}).render().asPng();
  await writeFile(resolve(output, 'exports/png', file.replace(/\.dot$/, '.png')), png);
}
console.log('Packaged embedded HTML; manual snapshots retain their coordinates in static previews');
