// Excel(.xlsx)ファイルを読む。外部のライブラリは使わない(zip形式の展開は、ブラウザ標準の DecompressionStream を使う)。
// 読むのは「セルの値」だけ(式・書式・マクロ・画像は読まない)。
//
// readXlsx(bytes) → [{ name: シート名, rows: [[値, ...], ...] }]
//   値は、文字列 または 数値(日付は、Excelのシリアル値の数値のまま)。空のセルは null。

const dec = new TextDecoder('utf-8');

async function inflateRaw(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// zipの「中央ディレクトリ」を読んで、ファイル名 → 取り出す関数 の表を作る
function openZip(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (dv.getUint32(i, true) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error('Excelファイル(.xlsx)として読めません(zipの終端がありません)。');
  const count = dv.getUint16(end + 10, true);
  let p = dv.getUint32(end + 16, true);
  const files = new Map();
  for (let i = 0; i < count; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('Excelファイルの構造が正しくありません。');
    const method = dv.getUint16(p + 10, true);
    const csize = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const off = dv.getUint32(p + 42, true);
    const name = dec.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    files.set(name, async () => {
      const start = off + 30 + dv.getUint16(off + 26, true) + dv.getUint16(off + 28, true);
      const data = bytes.subarray(start, start + csize);
      if (method === 0) return data;
      if (method === 8) return inflateRaw(data);
      throw new Error(`未対応の圧縮方式です(${method})。`);
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return files;
}

const unescapeXml = (s) =>
  s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, '&');

// <t>…</t> の中の文字を、すべてつなぐ(ルビ <rPh> は除く)
function textOf(xml) {
  const cleaned = xml.replace(/<rPh[\s\S]*?<\/rPh>/g, '').replace(/<phoneticPr[^>]*\/>/g, '');
  let s = '';
  for (const m of cleaned.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)) s += m[1];
  return unescapeXml(s);
}

const colIndex = (letters) => letters.split('').reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;

function parseSharedStrings(xml) {
  const out = [];
  for (const m of xml.matchAll(/<si(?:\s[^>]*)?>([\s\S]*?)<\/si>/g)) out.push(textOf(m[1]));
  return out;
}

function parseSheet(xml, shared) {
  const rows = [];
  for (const rm of xml.matchAll(/<row\b[^>]*?(?:\sr="(\d+)")?[^>]*?>([\s\S]*?)<\/row>/g)) {
    const row = [];
    for (const cm of rm[2].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cm[1];
      const ref = /\br="([A-Z]+)(\d+)"/.exec(attrs);
      if (!ref) continue;
      const type = (/\bt="([^"]+)"/.exec(attrs) || [])[1];
      const body = cm[2] || '';
      let value = null;
      const v = /<v>([\s\S]*?)<\/v>/.exec(body);
      if (type === 'inlineStr') value = textOf(body);
      else if (v) {
        if (type === 's') value = shared[Number(v[1])] ?? null;
        else if (type === 'str' || type === 'e') value = unescapeXml(v[1]);
        else if (type === 'b') value = v[1] === '1';
        else value = Number(v[1]);
      }
      row[colIndex(ref[1])] = value === '' ? null : value;
    }
    rows[Number(rm[1] || rows.length + 1) - 1] = row;
  }
  return rows;
}

export async function readXlsx(bytes) {
  const zip = openZip(bytes);
  const text = async (name) => {
    const f = zip.get(name);
    return f ? dec.decode(await f()) : null;
  };
  const wbXml = await text('xl/workbook.xml');
  if (!wbXml) throw new Error('Excelファイル(.xlsx)ではありません(workbook.xml がありません)。');
  const relsXml = (await text('xl/_rels/workbook.xml.rels')) || '';
  const rels = new Map();
  for (const m of relsXml.matchAll(/<Relationship\b([^>]*)\/?>/g)) {
    const id = /\bId="([^"]+)"/.exec(m[1]);
    const target = /\bTarget="([^"]+)"/.exec(m[1]);
    if (id && target) rels.set(id[1], target[1].replace(/^\//, '').replace(/^(?!xl\/)/, 'xl/'));
  }
  const shared = parseSharedStrings((await text('xl/sharedStrings.xml')) || '');
  const sheets = [];
  for (const m of wbXml.matchAll(/<sheet\b([^>]*)\/?>/g)) {
    const name = /\bname="([^"]*)"/.exec(m[1]);
    const rid = /\br:id="([^"]+)"/.exec(m[1]);
    if (!name || !rid || !rels.has(rid[1])) continue;
    sheets.push({ name: unescapeXml(name[1]), path: rels.get(rid[1]) });
  }
  const out = [];
  for (const s of sheets) {
    const xml = await text(s.path);
    if (xml) out.push({ name: s.name, rows: parseSheet(xml, shared) });
  }
  return out;
}

// 先頭の行(見出し)に、指定した見出しをすべて含むシートを探し、「見出し名 → 値」の行の一覧にする
export function findTable(sheets, requiredHeaders) {
  for (const s of sheets) {
    for (let r = 0; r < Math.min(s.rows.length, 10); r++) {
      const head = s.rows[r];
      if (!head) continue;
      const idx = new Map();
      head.forEach((h, c) => typeof h === 'string' && idx.set(h.trim(), c));
      if (!requiredHeaders.every((h) => idx.has(h))) continue;
      const rows = [];
      for (let i = r + 1; i < s.rows.length; i++) {
        const row = s.rows[i];
        if (!row) continue;
        const obj = {};
        for (const [h, c] of idx) obj[h] = row[c] ?? null;
        if (Object.values(obj).some((v) => v !== null)) rows.push(obj);
      }
      return { sheet: s.name, headers: [...idx.keys()], rows };
    }
  }
  return null;
}
