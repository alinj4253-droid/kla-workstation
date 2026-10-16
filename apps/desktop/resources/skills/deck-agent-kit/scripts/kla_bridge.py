"""Optional PPTX inspection and real rendering for the slidep-based assistant."""
import importlib.util
import json
import os
import sys
import zipfile
from pathlib import Path


def doctor():
    from pptkit.render import find_renderer
    deps = {name: importlib.util.find_spec(name) is not None for name in ('pptx', 'PIL', 'pypdfium2')}
    renderer = find_renderer()
    return {'python': sys.executable, 'deps': deps,
            'renderer': renderer[0] if renderer else None,
            'capabilities': {'inspect': deps['pptx'],
                             'render': deps['pptx'] and deps['PIL'] and deps['pypdfium2'] and renderer is not None}}


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
    if action == 'doctor':
        return {'environment': doctor()}
    if action == 'inspect':
        return inspect_file(request['input'])
    if action != 'render':
        raise ValueError('不支持的 PPT 操作')
    pptx_file = request['input']
    validate_pptx(pptx_file)
    from pptx import Presentation
    page_count = len(Presentation(pptx_file).slides)
    if page_count > 60:
        raise ValueError('最多处理 60 页 PPTX')
    from pptkit.render import render
    rendered = render(pptx_file, str(output / 'render'), scale=1.2)
    if rendered['count'] != page_count:
        raise ValueError('真实渲染页数与 PPTX 页数不一致')
    return {'pageCount': page_count, 'renderStatus': 'completed',
            'qc': {'ok': True, 'blocked': 0, 'mode': 'structure'},
            'files': [rendered['pdf'], rendered['sheet']]}


if __name__ == '__main__':
    try:
        result = main(json.loads(Path(sys.argv[1]).read_text(encoding='utf-8')))
    except Exception as e:
        result = {'error': str(e)[:1200]}
    print(json.dumps(result, ensure_ascii=True))
