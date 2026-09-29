// LikeC4's CLI exports $view (automatic geometry), so pass the resolved native
// snapshot to the same pinned exporter. No draw.io geometry conversion here.
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {readFile, writeFile} from 'node:fs/promises';
import {resolve, dirname} from 'node:path';
const [runtime, output] = process.argv.slice(2);
const require = createRequire(resolve(runtime, 'package.json'));
const root = dirname(require.resolve('likec4/package.json'));
const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
if (pkg.version !== '1.59.4') throw new Error('Manual draw.io adapter requires LikeC4 1.59.4');
const {o:generateDrawioMulti} = await import(pathToFileURL(resolve(root, 'dist/chunks/vite-plugin.mjs')).href);
if (generateDrawioMulti.name !== 'generateDrawioMulti') throw new Error('Pinned draw.io exporter changed');
const {LikeC4Model} = await import(pathToFileURL(require.resolve('@likec4/core/model')).href);
const data = JSON.parse(await readFile(resolve(output, 'exports/model.json'), 'utf8'));
if (Array.isArray(data)) throw new Error('Manual draw.io export requires a single project');
const model = LikeC4Model.create(data), views = [...model.views()];
const options = Object.fromEntries(views.map(v => [v.id, {compressed:false}]));
await writeFile(resolve(output, 'exports/diagrams.drawio'), generateDrawioMulti(views, options));
console.log('Exported native manual geometry through the pinned LikeC4 draw.io exporter');
