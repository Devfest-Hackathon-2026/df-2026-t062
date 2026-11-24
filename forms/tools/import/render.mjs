// 試し（try.ts）で AI が作った欄を、元の PDF に重ねて「位置確認用」の PDF にする（人が見て確かめる用。key の名前も書く）。
//   node forms/tools/import/render.mjs admission 1 [tag] [元の PDF（手の版のない用紙のとき。1 ページだけの PDF）]
// 出力: forms/tools/out/import/<様式>_p<ページ>_AIの位置確認.pdf
//   欄の枠（赤の細線）と、文字の欄には「key（なければ印字の文字）」、□ には ✓、丸の欄には丸を入れる。
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { generate } from '@pdfme/generator';
import { text, circleMark, rectangle } from '@pdfme/schemas';
import { loadFont, loadTemplate } from '../scripts/lib.mjs';

const [form = 'admission', pageArg = '1'] = process.argv.slice(2);
const page = Number(pageArg);
const tag = process.argv[4] ? `_${process.argv[4]}` : '';
const out = new URL(`../out/import/${form}_p${page}${tag}`, import.meta.url);
const draft = JSON.parse(readFileSync(new URL(`${out.href}.json`), 'utf8'));
const pdfArg = process.argv[5];
const base = pdfArg ? { basePdf: new Uint8Array(readFileSync(pdfArg)), schemas: [[]] } : loadTemplate(form);

const schemas = [];
const inputs = {};
draft.slots.forEach((s, i) => {
  const at = { position: { x: s.x, y: s.y }, width: s.w, height: s.h };
  schemas.push({ name: `枠${i}`, type: 'rectangle', ...at, borderWidth: 0.15, borderColor: '#d00000', color: '', readOnly: true, content: '' });
  const name = `欄${i}`;
  if (s.ui === 'circle') {
    schemas.push({ name, type: 'circleMark', ...at, color: '#1a3fa0', borderWidth: 0.3, content: 'false' });
    inputs[name] = 'true';
  } else {
    const mark = s.ui === 'check';
    schemas.push({
      name, type: 'text', ...at, fontName: 'BIZUDPGothic', fontSize: mark ? 8 : 7, alignment: mark ? 'center' : 'left',
      verticalAlignment: s.ui === 'area' ? 'top' : 'middle', lineHeight: 1.1, characterSpacing: 0, fontColor: '#1a3fa0',
      dynamicFontSize: { min: 3, max: mark ? 8 : 7, fit: 'horizontal' }, content: '',
    });
    inputs[name] = mark ? '✓' : (s.ref ?? `（なし）${s.label}`) + (s.part ? ` ${s.part}` : '') + (s.mark ? ` ${s.mark.kind}${s.mark.value ? ':' + s.mark.value : ''}` : '');
  }
});

const template = { basePdf: base.basePdf, schemas: base.schemas.map((_, i) => (i === page - 1 ? schemas : [])) };
const pdf = await generate({ template, inputs: [inputs], plugins: { text, circleMark, rectangle }, options: { font: loadFont() } });
const file = new URL(`${out.href}_AIの位置確認.pdf`);
writeFileSync(file, pdf);
console.log('書き出しました:', fileURLToPath(file));
