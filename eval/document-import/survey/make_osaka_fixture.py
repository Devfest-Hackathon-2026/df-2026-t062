"""Add three synthetic marks to the official Osaka raster form (evaluation only)."""
import argparse
from hashlib import sha256
from io import BytesIO
import json
from pathlib import Path
from pypdf import PdfReader, PdfWriter
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen.canvas import Canvas

HERE = Path(__file__).resolve().parent
SOURCE = 'https://www.city.osaka.lg.jp/fukushi/cmsfiles/contents/0000674/674268/9.pdf'
SOURCE_SHA = '9c9446032a899a87fd11ff71d2a33a8308bf9ff8d13cd747bef61e81d0ad589b'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, required=True)
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    raw = args.source.read_bytes()
    if sha256(raw).hexdigest() != SOURCE_SHA:
        raise ValueError('Expected the official Osaka PDF linked in SOURCE')
    writer = PdfWriter()
    page = writer.add_page(PdfReader(BytesIO(raw)).pages[1])
    width, height = float(page.mediabox.width), float(page.mediabox.height)
    overlay = BytesIO()
    canvas = Canvas(overlay, pagesize=(width, height))
    pdfmetrics.registerFont(TTFont('EvalJP', str(HERE.parents[2] / 'forms/fonts/BIZUDPGothic-Regular.ttf')))
    canvas.setFont('EvalJP', 9)
    canvas.drawString(24, 16, '架空の検証資料・提出不可｜検証 太郎｜記録日2026-11-04')
    canvas.setLineWidth(1.4)
    # Coordinates measured only for generating this fixture; never imported by the reader.
    for x, y in [(251, 143), (251, 214), (329, 249)]:
        canvas.line(x / 911 * width, height - (y + 9) / 1288 * height,
                    (x + 9) / 911 * width, height - y / 1288 * height)
    canvas.showPage()
    canvas.save()
    page.merge_page(PdfReader(overlay).pages[0])
    args.out.mkdir(parents=True, exist_ok=True)
    target = args.out / 'osaka.pdf'
    with target.open('wb') as file:
        writer.write(file)
    manifest_path = args.out / 'manifest.json'
    manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
    manifest['files']['osaka.pdf'] = sha256(target.read_bytes()).hexdigest()
    manifest['osakaSource'] = {'url': SOURCE, 'sha256': SOURCE_SHA, 'page': 2,
                               'gold': {'survey.2_2': '見守り等', 'survey.2_4': '見守り等', 'survey.2_5': '一部介助'}}
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(target)


if __name__ == '__main__':
    main()
