#!/usr/bin/env python3
"""Build a versioned local flowchart; source and existing deliveries are never overwritten."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import subprocess
import sys
import tempfile
import xml.etree.ElementTree as ET
from checks import check_delivery

SKILL = Path(__file__).resolve().parents[1]


def runtime_for(explicit=None):
    toolchain = SKILL/'assets/toolchain'
    packages = json.loads((toolchain/'package.json').read_text())['dependencies']
    if explicit:
        runtime = Path(explicit).expanduser().resolve()
    else:
        key = hashlib.sha256((toolchain/'package-lock.json').read_bytes()).hexdigest()[:16]
        runtime = Path.home()/'.cache/local-flowcharts'/f'{key}-{platform.system()}-{platform.machine()}'
        if not (runtime/'.ready').exists():
            runtime.parent.mkdir(parents=True,exist_ok=True)
            stage = Path(tempfile.mkdtemp(prefix='.install-',dir=runtime.parent))
            try:
                for name in ('package.json','package-lock.json'):
                    shutil.copy2(toolchain/name,stage/name)
                npm = shutil.which('npm')
                if not npm:
                    raise ValueError('npm is required to bootstrap the pinned local runtime')
                with (stage/'install.log').open('w') as log:
                    proc = subprocess.run([npm,'ci','--no-audit','--no-fund'],cwd=stage,stdout=log,stderr=subprocess.STDOUT,timeout=600)
                if proc.returncode:
                    raise RuntimeError(f'npm ci failed ({proc.returncode}); see {stage}/install.log')
                (stage/'.ready').write_text(key+'\n')
                if runtime.exists():
                    raise ValueError(f'Incomplete cache already exists: {runtime}; inspect before removing it')
                stage.rename(runtime)
            except Exception:
                print(f'Installation evidence retained: {stage}',file=sys.stderr)
                raise
    for package, version in packages.items():
        path = runtime/'node_modules'/package/'package.json'
        if not path.exists() or json.loads(path.read_text())['version'] != version:
            raise ValueError(f'Expected {package}@{version} in {runtime}; runtime mismatch')
    node = runtime/'node_modules/.bin/node'
    actual = subprocess.check_output([str(node),'--version'],text=True).strip()
    if actual != 'v'+packages['node']:
        raise ValueError(f'Unexpected Node executable: {actual}')
    return runtime, node


def compact_drawio(path):
    raw = path.read_bytes()
    root = ET.fromstring(raw)
    for cell in root.findall('.//mxCell[@vertex="1"]'):
        style = cell.get('style','')
        if 'likec4ViewTitle=' in style or 'likec4Size=xs;' not in style:
            continue
        # The native exporter includes long descriptions in xs boxes. Keep its
        # encoded description metadata and remove only visible description spans.
        value = cell.get('value','')
        if '<span' not in value:
            continue
        if 'likec4Description=' not in style or not value.startswith('<div ') or '</b>' not in value:
            raise ValueError('Unknown draw.io xs label structure; refusing to discard content')
        cell.set('value', value.split('</b>',1)[0]+'</b></div>')
    path.with_name('diagrams.native.drawio').write_bytes(raw)
    ET.ElementTree(root).write(path,encoding='utf-8',xml_declaration=True)


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('source', type=Path, help='Folder containing *.c4 and likec4.config.json')
    ap.add_argument('--expect', type=Path, required=True, help='Independent expected content manifest')
    ap.add_argument('--out', type=Path, required=True, help='New version folder; must not exist')
    ap.add_argument('--runtime', type=Path, help='Optional existing toolchain with exactly pinned versions')
    ap.add_argument('--title', default='流程图')
    ap.add_argument('--lang', choices=['zh-CN','en-US'], default='zh-CN')
    args = ap.parse_args()
    source, out = args.source.expanduser().resolve(), args.out.expanduser().resolve()
    if out.exists() or out.is_symlink():
        ap.error(f'Output already exists; use a new version directory: {out}')
    if out == source or source in out.parents:
        ap.error('Output must be outside the source folder')
    config = json.loads((source/'likec4.config.json').read_text())
    project = config.get('name')
    if not project or project == 'default':
        ap.error('Set a non-default project name in likec4.config.json')
    expected = json.loads(args.expect.read_text())
    if expected.get('default_view','index') != 'index':
        ap.error('The landing view must be named index')
    runtime, node = runtime_for(args.runtime)
    out.parent.mkdir(parents=True,exist_ok=True)
    work = Path(tempfile.mkdtemp(prefix=f'.{out.name}.building-',dir=out.parent))
    try:
        shutil.copytree(source, work/'source')
        shutil.copy2(args.expect,work/'expected.json')
        (work/'exports').mkdir()
        cli = [str(node), str(runtime/'node_modules/likec4/bin/likec4.mjs')]
        source_copy = str(work/'source')
        env = dict(os.environ)
        env['PATH'] = str(runtime/'node_modules/.bin')+os.pathsep+env.get('PATH','')
        def run(label, arguments):
            with (work/f'{label}.log').open('w') as log:
                result = subprocess.run(arguments,cwd=work,env=env,stdout=log,stderr=subprocess.STDOUT,timeout=600)
            if result.returncode:
                detail = (work/f'{label}.log').read_text()
                if label == 'validate':
                    try:
                        parsed = json.loads(detail)
                        detail = '\n'.join(f"{e.get('file')}:{e.get('line')}: {e.get('message','')[:250]}" for e in parsed.get('errors',[]))
                    except ValueError:
                        pass
                print(detail[-2500:],file=sys.stderr)
                raise subprocess.CalledProcessError(result.returncode, arguments)
            print(f'{label}: passed',flush=True)

        run('validate',cli+['validate',source_copy,'--json'])
        run('model',cli+['export','json',source_copy,'--project',project,'-o',str(work/'exports/model.json')])
        run('layout',[str(node),str(SKILL/'scripts/apply-layouts.mjs'),str(runtime),str(work)])
        if expected.get('viewer') == 'reader':
            run('build',[str(node),str(SKILL/'scripts/build-reader.mjs'),str(runtime),str(work),args.title,args.lang])
        elif expected.get('viewer', 'native') == 'native':
            run('build',cli+['build',source_copy,'-o',str(work/'dist'),'--output-single-file','--base','./','--use-hash-history','--theme','light','--title',args.title])
        else:
            raise ValueError('Unknown viewer; choose native or reader')
        if expected.get('layout', {}).get('mode') == 'manual':
            run('drawio',[str(node),str(SKILL/'scripts/export-manual-drawio.mjs'),str(runtime),str(work)])
        else:
            run('drawio',cli+['export','drawio',source_copy,'-o',str(work/'exports'),'--all-in-one','--uncompressed'])
        compact_drawio(work/'exports/diagrams.drawio')
        run('dot',cli+['gen','dot',source_copy,'-o',str(work/'exports/dot')])
        run('package', [str(node),str(SKILL/'scripts/postprocess.mjs'),str(runtime),str(work),args.lang])
        report = check_delivery(work,expected,project)
        report['toolchain'] = json.loads((SKILL/'assets/toolchain/package.json').read_text())['dependencies']
        report['source_sha256'] = {str(p.relative_to(work/'source')):hashlib.sha256(p.read_bytes()).hexdigest()
                                   for p in sorted((work/'source').rglob('*')) if p.is_file()}
        (work/'verification.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
        if not report['static_checks_passed']:
            print('Static checks require fixes: '+', '.join(k for k,v in report['checks'].items() if not v),file=sys.stderr)
            print(f'Draft and evidence retained: {work}',file=sys.stderr)
            return 2
        work.rename(out)
        print(f'Static checks passed. Browser and offline runtime verification remain pending.\n{out}/flow.html')
        return 0
    except Exception:
        print(f'Build did not complete. Evidence retained: {work}',file=sys.stderr)
        raise


if __name__ == '__main__':
    try:
        sys.exit(main())
    except subprocess.CalledProcessError as exc:
        sys.exit(exc.returncode if exc.returncode > 0 else 1)
    except (ValueError, OSError, RuntimeError, subprocess.TimeoutExpired, KeyError, StopIteration) as exc:
        print(f'ERROR: {exc}',file=sys.stderr)
        sys.exit(1)
