// Static vector preview of a native manual snapshot. No browser or new layout engine.
const escape = value => String(value).replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;');
export function renderSnapshot(view, theme) {
  // Keep this optional renderer honest: fail on unsupported shapes, not a misleading preview.
  if (view.nodes.some(n => n.shape !== 'rectangle')) throw new Error('Manual preview currently supports rectangle nodes only');
  const {x,y,width,height} = view.bounds;
  const svg = [`<svg xmlns="http://www.w3.org/2000/svg" viewBox="${x} ${y} ${width} ${height}" width="${width}" height="${height}">`,
    '<defs><marker id="arrow-gray" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M 0 1 L 9 5 L 0 9 z" fill="#8a98aa"/></marker><marker id="arrow-red" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M 0 1 L 9 5 L 0 9 z" fill="#c57666"/></marker></defs>',
    `<rect x="${x}" y="${y}" width="${width}" height="${height}" fill="#f8fafc"/>`,
    '<g font-family="PingFang SC, Microsoft YaHei, sans-serif">'];
  for (const n of view.nodes.filter(n => n.children.length)) {
    svg.push(`<g class="cluster" data-id="${escape(n.id)}"><rect x="${n.x}" y="${n.y}" width="${n.width}" height="${n.height}" rx="14" fill="#f1f5f9" stroke="#d4dde7"/><text x="${n.x+24}" y="${n.y+35}" font-size="18" font-weight="600" fill="#526379">${escape(n.title)}</text></g>`);
  }
  for (const e of view.edges) {
    if (e.tail || e.head !== 'normal' || !['gray','red'].includes(e.color) || (e.points.length-1)%3) throw new Error(`Unsupported manual preview edge ${e.id}`);
    const path = `M ${e.points[0].join(' ')} ` + Array.from({length:(e.points.length-1)/3}, (_,i) => 'C '+e.points.slice(1+i*3,4+i*3).flat().join(' ')).join(' ');
    const red = e.color === 'red';
    svg.push(`<g class="edge" data-id="${escape(e.id)}"><path d="${path}" fill="none" stroke="${red?'#c57666':'#8a98aa'}" stroke-width="2" ${red?'stroke-dasharray="7 5"':''} marker-end="url(#arrow-${red?'red':'gray'})"/></g>`);
  }
  for (const e of view.edges.filter(e => e.label)) {
    const b = e.labelBBox, red = e.color === 'red';
    svg.push(`<g class="edge-label"><rect x="${b.x}" y="${b.y}" width="${b.width}" height="${b.height}" rx="5" fill="${red?'#fff6f3':'#ffffff'}" stroke="${red?'#e5c4bc':'#d4dde7'}"/><text x="${b.x+b.width/2}" y="${b.y+19}" text-anchor="middle" font-size="14" font-weight="600" fill="${red?'#984938':'#34455c'}">${escape(e.label)}</text></g>`);
  }
  for (const n of view.nodes.filter(n => !n.children.length)) {
    const color = theme.colors[n.color]?.elements;
    if (!color || typeof color !== 'object') throw new Error(`Missing preview palette ${n.color}`);
    svg.push(`<g class="node" data-id="${escape(n.id)}"><rect x="${n.x}" y="${n.y}" width="${n.width}" height="${n.height}" rx="10" fill="${escape(color.fill)}" stroke="${escape(color.stroke)}"/><text x="${n.x+n.width/2}" y="${n.y+n.height/2+7}" text-anchor="middle" font-size="20" font-weight="600" fill="${escape(color.hiContrast)}">${escape(n.title)}</text></g>`);
  }
  svg.push('</g></svg>');
  return svg.join('\n');
}
