"""Synthetic photo conditions and varied hand-drawn marks on a public blank form."""
import argparse
from hashlib import sha256
from io import BytesIO
import json
from pathlib import Path
import pdfplumber
from PIL import Image, ImageDraw, ImageFont, ImageFilter
from make_osaka_fixture import SOURCE_SHA, SOURCE, HERE


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source', type=Path, required=True)
    parser.add_argument('--out', type=Path, required=True)
    args = parser.parse_args()
    raw = args.source.read_bytes()
    if sha256(raw).hexdigest() != SOURCE_SHA:
        raise ValueError('Unexpected public Osaka source PDF')
    with pdfplumber.open(BytesIO(raw)) as pdf:
        original = pdf.pages[1].to_image(resolution=150).original.convert('RGB')
    sx, sy = original.width / 911, original.height / 1288
    font = ImageFont.truetype(str(HERE.parents[2] / 'forms/fonts/BIZUDPGothic-Regular.ttf'), 20)
    examples = {
        'photo': ([(256, 148), (256, 219), (334, 254)], ['見守り等', '見守り等', '一部介助']),
        'ticks': ([(410, 148), (181, 219), (410, 254)], ['全介助', '介助されていない', '全介助']),
        'unreadable': ([], [None, None, None]),
    }
    manifest_path = args.out / 'manifest.json'
    manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
    manifest['imageCases'] = {}
    for name, (positions, values) in examples.items():
        image = original.copy()
        draw = ImageDraw.Draw(image)
        draw.rectangle((0, 0, image.width, 40), fill='white')
        draw.text((24, 8), '架空の検証資料・提出不可｜検証 花子', font=font, fill='black')
        for x, y in positions:
            # Three irregular strokes, with no printed answer text or previous marks.
            draw.line([((x-5)*sx, y*sy), ((x-1)*sx, (y+5)*sy), ((x+6)*sx, (y-6)*sy)], fill=(24, 29, 48), width=4, joint='curve')
        if name == 'unreadable':
            for y0, y1 in [(134, 162), (205, 234), (241, 270)]:
                draw.rectangle((165*sx, y0*sy, 444*sx, y1*sy), fill=(170, 170, 170))
        if name == 'photo':
            image = image.rotate(3.5, Image.Resampling.BICUBIC, expand=True, fillcolor='white')
            pixels = image.load()
            for x in range(image.width):
                factor = .75 + .25 * x / max(1, image.width-1)
                for y in range(image.height):
                    pixels[x, y] = tuple(round(value * factor) for value in pixels[x, y])
            image = image.filter(ImageFilter.GaussianBlur(.45))
        target = args.out / f'{name}.jpg'
        image.save(target, quality=70 if name == 'photo' else 90)
        manifest['files'][target.name] = sha256(target.read_bytes()).hexdigest()
        manifest['imageCases'][name] = {'source': SOURCE, 'sourceSha256': SOURCE_SHA,
            'gold': [{'key': key, 'expected': value, 'review': value is None, 'mayReview': name == 'photo'}
                     for key, value in zip(['survey.2_2', 'survey.2_4', 'survey.2_5'], values)]}
        print(target)
    manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


if __name__ == '__main__':
    main()
