// Power Automate が集めた投稿(Teams投稿管理.xlsx の表)を、整理アプリのチャット・投稿に結びつける。
// 画面には依存しない。
//
// 入力:Excelの「投稿の表」(見出し:投稿ID・日付・種別・チーム・場所・投稿者・件名・本文・リンク・…)と
//       「ファイルの表」(見出し:場所・ファイル名・URL・日付・投稿者)
// 既読:Teams自身の既読日時は、取得できない(Graphに反映されない)ため、整理アプリの中で
//       「開いたら既読」にする。既読の記録は reads(場所ごとの既読日時)に持つ。
import { findTable } from './xlsx-read.js';
import { parseTeamsLink } from './posts.js';

export const POST_HEADERS = ['投稿ID', '日付', '本文', 'リンク'];
export const FILE_HEADERS = ['場所', 'ファイル名', 'URL'];
export const MAX_MESSAGES_PER_PLACE = 100;

// Excelのシリアル値(日本時間の日時)を、ISO日時(UTC)に直す
export function serialToIso(n) {
  if (typeof n !== 'number' || !Number.isFinite(n)) return null;
  const ms = Math.round((n - 25569) * 86400000) - 9 * 3600 * 1000;
  return new Date(ms).toISOString();
}

const text = (v, max) => (v === null || v === undefined ? '' : String(v).slice(0, max));
const httpsUrl = (v) => (typeof v === 'string' && /^https:\/\//.test(v.trim()) && v.length <= 2000 ? v.trim() : null);

// 役職や(…)を除いた、名前だけの形(「石川智之(…課長補佐)」→「石川智之」)。投稿者の表記ゆれの判定に使う
export function baseName(name) {
  return String(name || '')
    .split(/[(（]/)[0]
    .replace(/[\s　]+/g, '');
}

// Excelの表(sheets)から、投稿とファイルの一覧を取り出す。見つからなければ null
export function parseInbox(sheets) {
  const posts = findTable(sheets, POST_HEADERS);
  if (!posts) return null;
  const files = findTable(sheets, FILE_HEADERS);
  const items = [];
  for (const r of posts.rows) {
    const id = text(r['投稿ID'], 100);
    if (!id) continue;
    const link = httpsUrl(r['リンク']);
    const t = link && parseTeamsLink(link);
    items.push({
      id,
      at: serialToIso(typeof r['日付'] === 'number' ? r['日付'] : Number(r['日付'])),
      kind: text(r['種別'], 20),
      team: text(r['チーム'], 100).replace(/^-$/, ''),
      place: text(r['場所'], 200),
      from: text(r['投稿者'], 200),
      subject: text(r['件名'], 300),
      text: text(r['本文'], 5000),
      link,
      chatId: (t && t.chatId) || null,
      status: text(r['状態'], 100),
      note: text(r['備考'], 1000),
    });
  }
  const fileRows = files
    ? files.rows
        .map((r) => ({ place: text(r['場所'], 200), name: text(r['ファイル名'], 200) || '(名前なし)', url: httpsUrl(r['URL']), at: serialToIso(Number(r['日付'])), from: text(r['投稿者'], 200) }))
        .filter((f) => f.url)
    : [];
  return { items, files: fileRows };
}

// 場所のキー:リンクから読み取ったチャット(チャンネル)のID。なければ、種別+チーム+場所の名前
export const placeKey = (it) => it.chatId || `${it.kind}:${it.team}|${it.place}`;

// ---- 既読の記録 ----------------------------------------------------------------
// reads = { version: 1, updatedAt, baselineDone: bool, places: { 場所のキー: 既読日時(ISO) } }
export const emptyReads = () => ({ version: 1, updatedAt: null, baselineDone: false, places: {} });

export function sanitizeReads(raw) {
  if (!raw || typeof raw !== 'object' || typeof raw.places !== 'object' || raw.places === null) throw new Error('既読の記録のファイルではありません(places がありません)。');
  const places = {};
  for (const [k, v] of Object.entries(raw.places).slice(0, 20000)) {
    if (typeof v === 'string' && !Number.isNaN(Date.parse(v)) && k.length <= 300) places[k] = v.slice(0, 40);
  }
  return { version: 1, updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt.slice(0, 40) : null, baselineDone: raw.baselineDone === true, places };
}

// 2つの既読の記録を、1つにする(場所ごとに、新しい方の既読日時)。同時に使っても、既読が戻らない
export function mergeReads(a, b) {
  const out = emptyReads();
  out.baselineDone = !!(a.baselineDone || b.baselineDone);
  out.updatedAt = [a.updatedAt, b.updatedAt].filter(Boolean).sort().pop() || null;
  for (const src of [a.places, b.places]) for (const [k, v] of Object.entries(src)) if (!out.places[k] || v > out.places[k]) out.places[k] = v;
  return out;
}

// 既読にする(その場所の、一番新しい投稿の日時まで)。変更があれば true
export function markRead(reads, key, newestAt) {
  if (!newestAt) return false;
  if (reads.places[key] && reads.places[key] >= newestAt) return false;
  reads.places[key] = newestAt;
  reads.updatedAt = new Date().toISOString();
  return true;
}

// 初めて読み込んだとき:すべての場所を「既読」にしておく(いきなり全部が未読にならないように)。1回だけ行う
export function applyBaseline(reads, inbox) {
  if (reads.baselineDone) return false;
  const newest = new Map();
  for (const it of inbox.items) {
    if (!it.at) continue;
    const k = placeKey(it);
    if (!newest.has(k) || it.at > newest.get(k)) newest.set(k, it.at);
  }
  for (const [k, at] of newest) if (!reads.places[k] || reads.places[k] < at) reads.places[k] = at;
  reads.baselineDone = true;
  reads.updatedAt = new Date().toISOString();
  return true;
}

// ---- チャット一覧に、投稿と既読を結びつける --------------------------------------
// raw = 取得ツールの出力(chats.json の中身)。戻り値は、新しい raw(元は変更しない)
export function mergeInbox(raw, inbox, reads) {
  if (!inbox || !inbox.items.length) return raw;
  const meBase = baseName(raw.me && raw.me.name);
  const meId = (raw.me && raw.me.id) || null;
  const byPlace = new Map();
  for (const it of inbox.items) {
    const k = placeKey(it);
    if (!byPlace.has(k)) byPlace.set(k, []);
    byPlace.get(k).push(it);
  }
  // 場所の名前 → ファイル(「ファイルの表」は、場所の名前でしか結びつけられない)
  const filesByPlace = new Map();
  for (const f of inbox.files) {
    if (!filesByPlace.has(f.place)) filesByPlace.set(f.place, []);
    filesByPlace.get(f.place).push(f);
  }

  const toMessages = (items, place) => {
    const files = (filesByPlace.get(place) || []).filter((f) => f.at);
    return items
      .filter((it) => it.at)
      .sort((a, b) => a.at.localeCompare(b.at))
      .slice(-MAX_MESSAGES_PER_PLACE)
      .map((it) => ({
        id: it.id,
        at: it.at,
        fromId: meBase && baseName(it.from) === meBase ? meId : null,
        from: it.from,
        text: [it.subject, it.text].filter(Boolean).join('\n'),
        link: it.link,
        // ファイルの表の日付が、投稿の日時と同じもの(1秒以内)を、その投稿の添付とする
        attachments: files.filter((f) => Math.abs(Date.parse(f.at) - Date.parse(it.at)) < 1000).map((f) => ({ name: f.name, url: f.url })),
      }));
  };

  const known = new Set(raw.chats.map((c) => c.id));
  const chats = raw.chats.map((c) => {
    const items = byPlace.get(c.id);
    if (!items) return c;
    return { ...c, messages: toMessages(items, items[0].place), lastReadAt: reads.places[c.id] || null };
  });

  // チャンネルなど、チャット一覧にない場所は、「チーム › チャンネル」の名前の場所として足す
  for (const [k, items] of byPlace) {
    if (known.has(k)) continue;
    const latest = items.filter((i) => i.at).sort((a, b) => b.at.localeCompare(a.at))[0] || items[0];
    const first = items[0];
    chats.push({
      id: k,
      type: first.kind === 'チャネル' ? 'channel' : 'other',
      topic: first.team ? `${first.team} › ${first.place}` : first.place,
      createdAt: null,
      updatedAt: latest.at,
      webUrl: latest.link,
      hidden: false,
      lastReadAt: reads.places[k] || null,
      lastMessageId: null,
      members: [],
      messages: toMessages(items, first.place),
      lastMessage: null,
    });
  }
  return { ...raw, messagesEnabled: true, chats };
}

// 場所ごとの、一番新しい投稿の日時(既読にするときの値)
export function newestAt(chat) {
  const m = chat.messages;
  return m && m.length ? m[m.length - 1].at : null;
}
