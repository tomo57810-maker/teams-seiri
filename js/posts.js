// 「投稿の記録」:Teamsの投稿のリンクと文章を貼り付けて記録し、チャットのグループごとに整理する。
// 画面には依存しない。
//
// 記録(item)の形:
//   { id, at(ISO日時), from(投稿者), text(内容), status(状態), note(備考), link(Teamsの投稿へのリンク),
//     chatId(リンクから読み取ったチャットID。なければ null), groupId(手動で選んだグループ。なければ null),
//     files: [{ name, url }] }
// 保存用の形: { version: 1, updatedAt, items: [item] }
import * as G from './groups.js';

export const MAX_ITEMS = 20000;
export const emptyPosts = () => ({ version: 1, updatedAt: null, items: [] });
export const newPostId = () => `p-${crypto.randomUUID()}`;
export const touchPosts = (doc) => {
  doc.updatedAt = new Date().toISOString();
  return doc;
};

const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
const httpsUrl = (v) => (typeof v === 'string' && /^https:\/\//.test(v) && v.length <= 2000 ? v : null);

// ファイルや保存データから読んだ記録を、安全な形に直す(想定外の項目は捨て、リンクは https だけを通す)
export function sanitizePosts(raw) {
  if (!raw || !Array.isArray(raw.items)) throw new Error('投稿の記録のファイルではありません(items がありません)。');
  if (raw.items.length > MAX_ITEMS) throw new Error('記録が多すぎます。');
  const ids = new Set();
  const items = raw.items.map((p, i) => {
    if (!p || typeof p.id !== 'string' || !p.id || ids.has(p.id)) throw new Error(`${i + 1}件目の記録の形式が正しくありません。`);
    ids.add(p.id);
    return {
      id: p.id.slice(0, 80),
      at: typeof p.at === 'string' && !Number.isNaN(Date.parse(p.at)) ? p.at.slice(0, 40) : null,
      from: str(p.from, 100),
      text: str(p.text, 5000),
      status: str(p.status, 100),
      note: str(p.note, 2000),
      link: httpsUrl(p.link),
      chatId: typeof p.chatId === 'string' ? p.chatId.slice(0, 300) : null,
      groupId: typeof p.groupId === 'string' ? p.groupId.slice(0, 80) : null,
      files: (Array.isArray(p.files) ? p.files : []).slice(0, 20).map((f) => ({ name: str(f && f.name, 200) || '(名前なし)', url: httpsUrl(f && f.url) })).filter((f) => f.url),
    };
  });
  return { version: 1, updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt.slice(0, 40) : null, items };
}

export function parsePostsFile(text) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('投稿の記録のファイルの形式が正しくありません(JSONとして読めません)。');
  }
  return sanitizePosts(raw);
}

// ---- Teamsのリンクを読む -----------------------------------------------------
// 「メッセージのリンクをコピー」で得られる https://teams.microsoft.com/l/message/<チャットID>/<投稿時刻(ミリ秒)>?... の形
// 戻り値: null(Teamsのリンクではない) / { url, chatId, ts }(chatId・ts は読み取れなければ null)
export function parseTeamsLink(raw) {
  let u;
  try {
    u = new URL(String(raw).trim());
  } catch {
    return null;
  }
  const host = u.hostname;
  if (u.protocol !== 'https:' || !(host === 'teams.microsoft.com' || host === 'teams.cloud.microsoft' || host.endsWith('.teams.microsoft.com'))) return null;
  const m = u.pathname.match(/^\/l\/message\/([^/]+)\/(\d{10,16})/);
  if (!m) return { url: u.href, chatId: null, ts: null };
  let chatId = null;
  try {
    chatId = decodeURIComponent(m[1]);
  } catch {
    /* チャットIDが読めなければ null のまま */
  }
  let ts = Number(m[2]);
  if (ts < 1e11) ts *= 1000; // 秒で書かれている場合
  if (ts < Date.UTC(2015, 0, 1) || ts > Date.UTC(2100, 0, 1)) ts = null;
  return { url: u.href, chatId, ts };
}

// ---- 貼り付けた文章を読む -----------------------------------------------------
// Teamsでコピーした投稿の文章から、投稿者・日時・内容を読み取る(読み取れた分だけ。あとで直せる)
// 対応する形:
//   「[2024/05/31 10:15] 米満補佐: 本文」 / 「米満補佐 2024/05/31 10:15」+次の行から本文 / 「米満補佐」「10:15」の2行 / 本文だけ
const DATE_FULL = /(\d{4})[\/\-.年]\s*(\d{1,2})[\/\-.月]\s*(\d{1,2})日?/;
const DATE_SHORT = /(?<![\d:])(\d{1,2})[\/月]\s*(\d{1,2})日?(?![\d:])/;
const TIME = /(\d{1,2}):(\d{2})(?::\d{2})?/;
const jst = (y, mo, d, h, mi) => new Date(Date.UTC(y, mo - 1, d, h - 9, mi)).toISOString();

export function parsePasted(text, year = new Date().getFullYear()) {
  const lines = String(text).replace(/\r/g, '').split('\n');
  while (lines.length && !lines[0].trim()) lines.shift();
  const idx = lines.slice(0, 3).findIndex((l) => TIME.test(l));
  if (idx < 0) return { from: '', at: null, body: lines.join('\n').trim() };

  const header = lines[idx];
  const t = header.match(TIME);
  let y = null;
  let mo = null;
  let d = null;
  let rest = header.replace(t[0], ' ');
  const full = rest.match(DATE_FULL);
  if (full) {
    [y, mo, d] = [Number(full[1]), Number(full[2]), Number(full[3])];
    rest = rest.replace(full[0], ' ');
  } else {
    const short = rest.match(DATE_SHORT);
    if (short) {
      [y, mo, d] = [year, Number(short[1]), Number(short[2])];
      rest = rest.replace(short[0], ' ');
    }
  }
  rest = rest.replace(/今日|昨日|おととい|Today|Yesterday/gi, ' ').replace(/[\[\]()（）【】]/g, ' ').replace(/\s+/g, ' ').trim();

  let from = '';
  let first = '';
  const colon = rest.match(/^(.{1,40}?)\s*[:：]\s*(.*)$/); // 「名前: 本文」の形
  if (colon) {
    from = colon[1].trim();
    first = colon[2].trim();
  } else {
    from = rest.replace(/^[,，、\s]+|[,，、\s]+$/g, '');
    if (!from && idx > 0 && lines[idx - 1].trim().length <= 40) from = lines[idx - 1].trim(); // 名前だけの行が、時刻の行の前にある
  }
  const body = [first, ...lines.slice(idx + 1)].join('\n').trim();
  const at = y && mo && d ? jst(y, mo, d, Number(t[1]), Number(t[2])) : null;
  return { from, at, body };
}

// ---- グループへの仕分け -------------------------------------------------------
// 記録が入るグループを決める:手動で選んだグループ > リンクのチャットが入っているグループ(一番深いもの)> 未分類
export function groupOf(post, data, doc) {
  const byId = new Map(doc.nodes.map((n) => [n.id, n]));
  const pick = (id) => ({ nodeId: id, path: G.pathLabel(doc, id), top: G.pathLabel(doc, id).split(' › ')[0] });
  if (post.groupId && byId.has(post.groupId)) return pick(post.groupId);
  const chat = post.chatId && data && data.chats.find((c) => c.id === post.chatId);
  if (chat) {
    const ids = G.nodesContaining(doc, chat);
    if (ids.length) {
      const depth = (id) => G.pathLabel(doc, id).split(' › ').length;
      ids.sort((a, b) => depth(b) - depth(a) || byId.get(a).order - byId.get(b).order);
      return pick(ids[0]);
    }
  }
  return { nodeId: null, path: '未分類', top: '未分類' };
}

// 最上位のグループごとにまとめる(シートの単位)。中は、グループの並び順→日時の順
export function organize(posts, data, doc) {
  const tree = G.buildTree({ chats: data ? data.chats : [] }, doc);
  const order = new Map();
  const walk = (vs) =>
    vs.forEach((v) => {
      order.set(v.node.id, order.size);
      walk(v.children);
    });
  walk(tree.roots);

  const sheets = new Map();
  for (const p of posts.items) {
    const g = groupOf(p, data, doc);
    if (!sheets.has(g.top)) sheets.set(g.top, []);
    sheets.get(g.top).push({ post: p, path: g.path, rank: g.nodeId ? order.get(g.nodeId) : Infinity });
  }
  const names = [...sheets.keys()].filter((n) => n !== '未分類');
  const rankOf = (name) => Math.min(...sheets.get(name).map((x) => x.rank));
  names.sort((a, b) => rankOf(a) - rankOf(b));
  if (sheets.has('未分類')) names.push('未分類');
  return names.map((name) => ({
    name,
    items: sheets.get(name).sort((a, b) => a.rank - b.rank || (a.post.at || '').localeCompare(b.post.at || '')),
  }));
}

// ---- Excel用の行 --------------------------------------------------------------
export const EXCEL_HEADERS = ['グループ', '日付', '投稿者', '状態', '内容', 'リンク', '添付ファイル', '添付リンク', '備考'];

export function toExcelSheets(groupsOfPosts) {
  return groupsOfPosts.map((s) => ({
    name: s.name,
    headers: EXCEL_HEADERS,
    widths: [22, 17, 14, 10, 60, 8, 28, 40, 30],
    rows: s.items.map(({ post: p, path }) => [
      path,
      p.at ? { date: Date.parse(p.at) } : '',
      p.from,
      p.status,
      p.text,
      p.link ? { link: p.link, text: 'リンク' } : '',
      p.files.map((f) => f.name).join('\n'),
      p.files.map((f) => f.url).join('\n'),
      p.note,
    ]),
  }));
}
