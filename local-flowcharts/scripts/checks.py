"""Static evidence for a LikeC4 export. Does not exercise the HTML viewer."""
from collections import Counter
from html.parser import HTMLParser
import hashlib
import json
import re
import xml.etree.ElementTree as ET


def overlaps(a, b):
    return (min(a['x'] + a['width'], b['x'] + b['width']) > max(a['x'], b['x']) + 1
            and min(a['y'] + a['height'], b['y'] + b['height']) > max(a['y'], b['y']) + 1)


def curve(points):
    if len(points) < 4 or (len(points) - 1) % 3:
        return points
    result = []
    for i in range(0, len(points) - 1, 3):
        p = points[i:i + 4]
        for step in range(41):
            t = step / 40
            weights = [(1-t)**3, 3*(1-t)**2*t, 3*(1-t)*t*t, t**3]
            result.append([sum(p[k][axis] * weights[k] for k in range(4)) for axis in (0, 1)])
    return result


def crosses(a, b, c, d):
    def orient(p, q, r):
        return (q[0]-p[0])*(r[1]-p[1]) - (q[1]-p[1])*(r[0]-p[0])
    return orient(a,b,c)*orient(a,b,d) < -1e-6 and orient(c,d,a)*orient(c,d,b) < -1e-6


class Assets(HTMLParser):
    def __init__(self):
        super().__init__()
        self.external, self.styles, self.scripts = [], [], []
        self.current = None

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag in ('script', 'link', 'img', 'source', 'iframe', 'video', 'audio'):
            for key in ('src', 'href', 'srcset', 'poster'):
                url = attrs.get(key, '')
                if url and not url.startswith(('data:', '#')):
                    self.external.append([tag, key, url])
        if tag in ('script', 'style'):
            self.current = tag

    def handle_endtag(self, tag):
        if tag == self.current:
            self.current = None

    def handle_data(self, data):
        if self.current == 'style':
            self.styles.append(data)
        if self.current == 'script':
            self.scripts.append(data)


def geometry(view):
    nodes, edges = view['nodes'], view['edges']
    by_id = {n['id']: n for n in nodes}

    def ancestors(node_id):
        result = {node_id}
        parent = by_id.get(node_id, {}).get('parent')
        while parent and parent not in result:
            result.add(parent)
            parent = by_id.get(parent, {}).get('parent')
        return result

    def related(a, b):
        return a in ancestors(b) or b in ancestors(a)

    collisions = [[a['id'], b['id']] for i,a in enumerate(nodes) for b in nodes[i+1:]
                  if not related(a['id'], b['id']) and overlaps(a,b)]
    through, labels, crossing, close_opposites = [], [], [], []
    samples = {e['id']: curve(e['points']) for e in edges}
    for i,a in enumerate(edges):
        ap = samples[a['id']]
        for n in nodes:
            if related(n['id'], a['source']) or related(n['id'], a['target']):
                continue
            if any(n['x']+2 < x < n['x']+n['width']-2 and n['y']+2 < y < n['y']+n['height']-2 for x,y in ap):
                through.append([a['id'], n['id']])
            if a.get('labelBBox') and overlaps(a['labelBBox'], n):
                labels.append([a['id'], n['id']])
        for b in edges[i+1:]:
            bp = samples[b['id']]
            if a['source'] == b['target'] and a['target'] == b['source'] and ap and bp:
                # Ignore arrow endpoints; compare the middle of opposite curves.
                middle = ap[len(ap)//4: max(len(ap)//4+1,3*len(ap)//4)]
                distances = [min(((p[0]-q[0])**2+(p[1]-q[1])**2)**.5 for q in bp) for p in middle]
                if max(distances) < 8:
                    close_opposites.append([a['id'], b['id']])
            if {a['source'],a['target']} & {b['source'],b['target']}:
                continue
            if any(crosses(p,q,r,s) for p,q in zip(ap,ap[1:]) for r,s in zip(bp,bp[1:])):
                crossing.append([a['id'],b['id']])
    return {'node_overlaps': collisions, 'sampled_edges_through_nodes': through,
            'edge_label_node_overlaps': labels, 'sampled_independent_edge_crossings': crossing,
            'nearly_coincident_opposite_edges': close_opposites}


def check_delivery(folder, expected, project_id):
    raw = json.loads((folder/'exports/model.json').read_text())
    candidates = raw if isinstance(raw,list) else [raw]
    model = next(m for m in candidates if m['projectId'] == project_id)
    checks = {}
    def check(name, condition):
        checks[name] = bool(condition)

    for key in ('elements', 'relations', 'visible_nodes'):
        if key not in expected:
            raise ValueError(f'Expected manifest requires {key}')
    actual = Counter((r['source']['model'],r['target']['model'],r.get('title') or '') for r in model['relations'].values())
    wanted = Counter(tuple(r) for r in expected['relations'])
    check('exact_elements', set(model['elements']) == set(expected['elements']))
    check('exact_directed_relations_and_labels', actual == wanted)
    view_id = expected.get('default_view', 'index')
    view = model['views'][view_id]
    # View-only groups are boundaries, not additional workflow steps. Verify
    # both sets separately so grouping never hides a missing semantic node.
    check('default_view_has_all_expected_nodes', {n['id'] for n in view['nodes'] if n.get('kind') != '@group'} == set(expected['visible_nodes']))
    groups = [n for n in view['nodes'] if n.get('kind') == '@group']
    wanted_groups = expected.get('view_groups', {})
    actual_groups = {n['title']: sorted(n.get('children', [])) for n in groups}
    check('exact_view_groups', len(groups) == len(actual_groups) and actual_groups == {k: sorted(v) for k,v in wanted_groups.items()})
    check('default_view_has_all_relations', {r for e in view['edges'] for r in e['relations']} == set(model['relations']))
    check('nonempty_diagram', bool(view['nodes']))
    if expected.get('layout'):
        layout = expected['layout']
        check('layout_mode', view.get('_layout', 'auto') == layout['mode'])
        check('layout_direction', view['autoLayout']['direction'] == layout['direction'])
        check('manual_layout_has_no_drift', not view.get('drifts'))
        if layout.get('aligned_groups'):
            check('stage_panels_aligned', len({(n['y'], n['height']) for n in groups}) == 1)
            ordered = sorted(groups, key=lambda n:n['x'])
            check('stage_panels_ordered', [n['title'] for n in ordered] == sorted(wanted_groups))
    if expected.get('viewer') == 'reader':
        reader_model = json.loads((folder/'reader-source/model.json').read_text())
        reader_options = json.loads((folder/'reader-source/reader-options.json').read_text())
        check('reader_uses_exact_exported_model', reader_model == model)
        check('reader_initial_zoom_matches_reading_scale', reader_options['scale'] == expected['reading'].get('scale', 1))
    for node_id, fields in expected.get('content', {}).items():
        node = model['elements'].get(node_id, {})
        for key, value in fields.items():
            actual_value = node.get(key)
            if key == 'description':
                actual_value = (actual_value or {}).get('md', (actual_value or {}).get('txt', '')).strip()
                value = value.strip()
            elif key == 'metadata':
                # The pinned CLI exports one-item lists as strings.
                def normalize(obj):
                    return {k: v[0] if isinstance(v,list) and len(v)==1 else v for k,v in (obj or {}).items()}
                actual_value, value = normalize(actual_value), normalize(value)
            check(f'content:{node_id}:{key}', actual_value == value)

    views = {}
    for name,v in model['views'].items():
        findings = geometry(v)
        for finding, pairs in findings.items():
            check(f'{name}:{finding}', not pairs)
        bounds = v['bounds']
        check(f'{name}:positive_bounds', bounds['width'] > 0 and bounds['height'] > 0)
        svg = ET.parse(folder/'exports/svg'/f'{name}.svg').getroot()
        ns = {'s':'http://www.w3.org/2000/svg'}
        fonts = [float(t.get('font-size')) for t in svg.findall('.//s:text', ns) if t.get('font-size')]
        canvas = expected.get('canvas', [1360,750])
        svg_box = [float(n) for n in svg.get('viewBox').split()]
        overview_scale = min(canvas[0]/max(1,svg_box[2]),canvas[1]/max(1,svg_box[3]),1)
        reading = expected.get('reading', {'mode':'fit'})
        mode = reading.get('mode', 'fit')
        if mode not in ('fit', 'pan-zoom'):
            raise ValueError(f'Unknown reading mode: {mode}')
        scale = overview_scale if mode == 'fit' else reading.get('scale', 1)
        if not isinstance(scale, (int, float)) or isinstance(scale, bool) or not 0 < scale <= 1:
            raise ValueError('Reading scale must be greater than 0 and no greater than 1')
        min_font = min(fonts)*scale if fonts else 0
        check(f'{name}:estimated_font_readable', min_font >= expected.get('minimum_font_px',12))
        check(f'{name}:svg_leaf_count', len(svg.findall('.//s:g[@class="node"]',ns)) == sum(not n.get('children') for n in v['nodes']))
        check(f'{name}:svg_edge_count', len(svg.findall('.//s:g[@class="edge"]',ns)) == len(v['edges']))
        views[name] = {'nodes':len(v['nodes']),
                       'model_nodes':sum(n.get('kind') != '@group' for n in v['nodes']),
                       'view_groups':sum(n.get('kind') == '@group' for n in v['nodes']),
                       'edges':len(v['edges']), 'bounds':bounds,
                       'static_preview_bounds':svg_box,
                       'reading_mode':mode, 'reading_scale':scale,
                       'overview_min_font_px':round(min(fonts)*overview_scale,2) if fonts else 0,
                       'estimated_min_font_px':round(min_font,2), **findings}

    assets = Assets()
    html = (folder/'flow.html').read_text()
    assets.feed(html)
    css, js = '\n'.join(assets.styles), '\n'.join(assets.scripts)
    css_external = [u for u in re.findall(r'url\((.*?)\)',css) if not u.strip('"\' ').startswith(('data:','#'))]
    imports = re.findall(r'\bimport\s*\(\s*["\']([^"\']+)["\']\s*\)',js)
    check('html_css_assets_embedded', not assets.external and not css_external and not re.search(r'@import\s+',css))
    check('literal_dynamic_imports_embedded', not [u for u in imports if not u.startswith('data:')])
    drawio = ET.parse(folder/'exports/diagrams.drawio').getroot()
    pages = drawio.findall('diagram')
    check('drawio_page_count', len(pages) == len(model['views']))
    # Compound titles are separate shape=text vertices without model metadata.
    # Count semantic nodes by the native exporter's color metadata, excluding
    # those labels and the invisible view root.
    check('drawio_total_nodes', sum('likec4ColorName=' in c.get('style','') for c in drawio.findall('.//mxCell[@vertex="1"]')) == sum(len(v['nodes']) for v in model['views'].values()))
    check('drawio_total_edges', len(drawio.findall('.//mxCell[@edge="1"]')) == sum(len(v['edges']) for v in model['views'].values()))
    report = {'static_checks_passed':all(checks.values()), 'checks':checks, 'views':views,
              'viewer':expected.get('viewer', 'native'),
              'browser_verified':False, 'offline_runtime_verified':False,
              'html_sha256':hashlib.sha256(html.encode()).hexdigest(),
              'html_bytes':len(html.encode()), 'external_static_assets':assets.external,
              'limits':['Curves are sampled. Crossings omit shared endpoints and collinear overlaps.',
                        'Fonts are estimated at the declared reading scale. The viewer initial zoom is not verified.',
                        'SVG/PNG use Graphviz; they are not HTML screenshots.',
                        'Embedded static resources do not prove offline runtime behavior.']}
    (folder/'verification.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
    return report
