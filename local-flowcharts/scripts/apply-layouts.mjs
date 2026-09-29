// Resolve native LikeC4 manual snapshots before readers and static checks consume them.
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {readFile, writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
const [runtime, output] = process.argv.slice(2);
const require = createRequire(resolve(runtime, 'package.json'));
const {LikeC4Model} = await import(pathToFileURL(require.resolve('@likec4/core/model')).href);
const file = resolve(output, 'exports/model.json');
const original = await readFile(file, 'utf8');
const raw = JSON.parse(original);
let count = 0;
for (const data of Array.isArray(raw) ? raw : [raw]) {
  const model = LikeC4Model.create(data);
  for (const id of Object.keys(data.manualLayouts ?? {})) {
    const view = model.view(id).$layouted;
    if (view.drifts?.length) throw new Error(`Update manual layout ${id}: ${view.drifts.join(', ')}`);
    data.views[id] = view;
    count++;
  }
  // Geometry is now resolved. Retaining the snapshot would make LikeC4's
  // $view accessor apply it again to an already manual view.
  delete data.manualLayouts;
  LikeC4Model.create(data); // Validate the exact model consumed by the reader.
}
if (count) {
  await writeFile(resolve(output, 'exports/model.auto.json'), original);
  await writeFile(file, JSON.stringify(raw));
}
console.log(`Resolved ${count} native manual layouts; no layout drift`);
