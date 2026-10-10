"""Fixed host adapter: semantic input only; no model-selected Python code."""
import json
import os
import sys
import zipfile
from pathlib import Path


def doctor():
    from pptkit.doctor import diagnose
    r = diagnose()
    generate = r['deps']['pptx'] and r['deps']['PIL']
    render = generate and r['deps']['pypdfium2'] and r['renderer'] is not None
    return {'level': 'full' if render else 'partial' if generate else 'blocked',
            'capabilities': {'generate': generate, 'qc': generate, 'render': render},
            'python': r['python'], 'deps': r['deps'],
            'renderer': r['renderer']['kind'] if r['renderer'] else None,
            'cjkFont': r['capabilities']['cjk_font'], 'actions': r['actions'], 'notes': r['notes']}


def validate_pptx(file):
    if not file.lower().endswith('.pptx') or os.path.getsize(file) > 16 * 1024 * 1024:
        raise ValueError('仅支持不超过 16 MiB 的 PPTX 文件')
    with zipfile.ZipFile(file) as z:
        entries = z.infolist()
        if len(entries) > 10000 or sum(x.file_size for x in entries) > 64 * 1024 * 1024:
            raise ValueError('PPTX 解压内容超出处理上限')
        if 'ppt/presentation.xml' not in z.namelist():
            raise ValueError('输入不是有效的 PPTX')


def inspect_file(file):
    validate_pptx(file)
    from pptx import Presentation
    prs = Presentation(file)
    if len(prs.slides) > 60:
        raise ValueError('最多处理 60 页 PPTX')
    pages = []
    for i, slide in enumerate(prs.slides, 1):
        texts, tables = [], []
        for s in slide.shapes:
            if s.has_text_frame:
                texts.append(s.text[:4000])
            if s.has_table:
                tables.append([[c.text[:500] for c in row.cells] for row in list(s.table.rows)[:50]])
        notes = slide.notes_slide.notes_text_frame.text[:2000] if slide.has_notes_slide else ''
        pages.append({'page': i, 'text': '\n'.join(texts)[:8000], 'tables': tables[:5], 'notes': notes})
    # Match the ASCII JSON transport budget; CJK escapes are larger than Unicode.
    while len(json.dumps(pages, ensure_ascii=True)) > 60000:
        pages.pop()
    return {'pages': pages, 'pageCount': len(prs.slides), 'truncated': len(pages) != len(prs.slides)}


def main(request):
    action, output = request['action'], Path(request['output'])
    env = doctor()
    if action == 'doctor':
        return {'environment': env}
    if not env['capabilities']['generate']:
        return {'error': 'PPT 依赖未安装，请运行 scripts/setup-ppt-runtime.ps1', 'environment': env}
    if action == 'inspect':
        return inspect_file(request['input'])
    from pptkit.qc import inspect as qc
    files = []
    if action == 'build':
        from pptkit import schema
        from pptkit.compile import build, _normalize_deep
        spec = json.loads(request['specJson'])
        if not isinstance(spec, dict) or not 1 <= len(spec.get('pages', [])) <= 60:
            raise ValueError('演示文稿必须包含 1–60 页')
        if any(len(p.get('blocks', [])) > 30 for p in spec['pages']):
            raise ValueError('每页最多 30 个语义块')
        schema.assert_valid(spec)
        normalized = _normalize_deep(spec)
        spec_file = output / 'deck.spec.json'
        spec_file.write_text(json.dumps(spec, ensure_ascii=False, indent=2), encoding='utf-8')
        pptx_file = str(output / request['fileName'])
        built = build(spec, pptx_file, strict=True)
        report = qc(pptx_file, normalized)
        pages = [{k: v for k, v in p.items() if k != 'shapes'} for p in built['pages']]
        files.extend([pptx_file, str(spec_file)])
    elif action == 'render':
        pptx_file = request['input']
        validate_pptx(pptx_file)
        report = qc(pptx_file)
        if report['pages'] > 60:
            raise ValueError('最多处理 60 页 PPTX')
        pages = []
    else:
        raise ValueError('不支持的 PPT 操作')
    report.pop('pptx', None)
    (output / 'deck.qc.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    if not report['ok']:
        return {'error': 'PPT 质量检查未通过，成果未上传；请修正语义内容后重试', 'qc': report}
    files.append(str(output / 'deck.qc.json'))
    result = {'qc': report, 'pages': pages, 'pageCount': report['pages'], 'renderStatus': 'not_requested'}
    if action == 'render' or request.get('render', True):
        if env['capabilities']['render']:
            from pptkit.render import render
            try:
                rendered = render(pptx_file, str(output / 'render'), scale=1.2)
                if rendered['count'] != report['pages']:
                    raise ValueError('真实渲染页数与 PPTX 页数不一致')
                files.extend([rendered['pdf'], rendered['sheet']])
                result['renderStatus'] = 'completed'
            except Exception as e:
                return {'error': 'PPT 真实渲染失败，未交付文件：' + str(e)[:600], 'qc': report, 'renderStatus': 'failed'}
        else:
            result.update(renderStatus='unavailable', warning='仅完成结构质检；缺少渲染器或 pypdfium2，请在 Office/WPS 确认视觉效果', environment=env)
    result['files'] = files
    if action == 'build':
        result['documentPath'] = pptx_file
    return result


if __name__ == '__main__':
    try:
        result = main(json.loads(Path(sys.argv[1]).read_text(encoding='utf-8')))
    except Exception as e:
        result = {'error': str(e)[:1200]}
    print(json.dumps(result, ensure_ascii=True))
