// グループ分け(階層)の計算。画面には依存しない。
//
// グループ設定(doc)の形:
//   { version: 1, updatedAt: ISO日時, nodes: [ { id, parentId, name, order, rules, include, exclude } ] }
//   rules   : 自動で振り分ける条件。{ type: 'exact'|'all'|'any', members: [ユーザーID], types: [チャットの種類] }
//               exact = 自分以外のメンバーが、指定した人だけ / all = 指定した人を全員含む / any = 指定した人の誰かを含む
//               types を指定すると、その種類のチャットだけが対象(空なら全種類)
//   include : 手動で入れたチャットID
//   exclude : 条件に合うが、手動で外したチャットID
// チャットがグループに入る条件:(include に入っている または いずれかの rule に合う)かつ exclude に入っていない

export const RULE_TYPES = ['exact', 'all', 'any'];
export const RULE_LABEL = { exact: '指定した人だけ(自分以外)', all: '指定した人を全員含む', any: '指定した人の誰かを含む' };
export const MAX_NODES = 300;

export const emptyDoc = () => ({ version: 1, updatedAt: null, nodes: [] });
export const newId = () => `g-${crypto.randomUUID()}`;

const strList = (v, max, maxLen = 200) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x && x.length <= maxLen).slice(0, max) : []);

// ファイルや保存データから読んだ設定を、安全な形に直す(想定外の項目は捨てる)
export function sanitizeDoc(raw) {
  if (!raw || !Array.isArray(raw.nodes)) throw new Error('グループ設定のファイルではありません(nodes がありません)。');
  if (raw.nodes.length > MAX_NODES) throw new Error(`グループが多すぎます(最大${MAX_NODES}個)。`);
  const ids = new Set();
  const nodes = raw.nodes.map((n, i) => {
    if (!n || typeof n.id !== 'string' || !n.id || n.id.length > 80 || typeof n.name !== 'string' || ids.has(n.id)) throw new Error(`${i + 1}個目のグループの形式が正しくありません。`);
    ids.add(n.id);
    return {
      id: n.id,
      parentId: typeof n.parentId === 'string' && n.parentId ? n.parentId : null,
      name: n.name.slice(0, 60),
      order: Number.isFinite(n.order) ? n.order : i,
      rules: (Array.isArray(n.rules) ? n.rules : [])
        .filter((r) => r && RULE_TYPES.includes(r.type))
        .slice(0, 20)
        .map((r) => ({ type: r.type, members: strList(r.members, 100), types: strList(r.types, 5, 40) })),
      include: strList(n.include, 5000, 500),
      exclude: strList(n.exclude, 5000, 500),
    };
  });
  return { version: 1, updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt.slice(0, 40) : null, nodes };
}

export function parseGroups(text) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('グループ設定のファイルの形式が正しくありません(JSONとして読めません)。');
  }
  return sanitizeDoc(raw);
}

// ---- 条件の判定 -----------------------------------------------------------
export const othersOf = (chat) => new Set(chat.members.filter((m) => !m.isMe).map((m) => m.id));

export function ruleMatches(rule, chat, others = othersOf(chat)) {
  const want = new Set(rule.members);
  if (!want.size) return false; // 人を1人も指定していない条件は、何にも合わない(全部に合ってしまうのを防ぐ)
  if (rule.types.length && !rule.types.includes(chat.type)) return false;
  const ids = [...want];
  if (rule.type === 'exact') return others.size === want.size && ids.every((id) => others.has(id));
  if (rule.type === 'all') return ids.every((id) => others.has(id));
  return ids.some((id) => others.has(id));
}

export const matchesByRule = (node, chat, others) => node.rules.some((r) => ruleMatches(r, chat, others));

export function nodeContains(node, chat, others = othersOf(chat)) {
  if (node.exclude.includes(chat.id)) return false;
  return node.include.includes(chat.id) || matchesByRule(node, chat, others);
}

// このチャットが入っているグループのID一覧
export function nodesContaining(doc, chat) {
  const others = othersOf(chat);
  return doc.nodes.filter((n) => nodeContains(n, chat, others)).map((n) => n.id);
}

// ---- 階層の構築 -----------------------------------------------------------
// 戻り値: { roots: [view], unclassified: [チャットID] }
//   view = { node, children: [view], own: [チャットID], total: 件数 }
//   own   = このグループに直接入っているチャット(下の階層のグループに入っているものは除く)
//   total = このグループと、その下の階層に入っているチャットの合計(重複なし)
export function buildTree(data, doc) {
  const chats = data.chats;
  const nodeById = new Map(doc.nodes.map((n) => [n.id, n]));

  // 親をたどって、ぐるぐる回る(循環)場合は、そのグループを最上位として扱う
  const parentOf = new Map();
  for (const n of doc.nodes) {
    let p = n.parentId && n.parentId !== n.id && nodeById.has(n.parentId) ? n.parentId : null;
    const seen = new Set([n.id]);
    for (let cur = p; cur; cur = (nodeById.get(cur) || {}).parentId) {
      if (seen.has(cur)) {
        p = null;
        break;
      }
      seen.add(cur);
    }
    parentOf.set(n.id, p);
  }
  const childrenOf = new Map();
  for (const n of doc.nodes) {
    const p = parentOf.get(n.id);
    if (!childrenOf.has(p)) childrenOf.set(p, []);
    childrenOf.get(p).push(n);
  }
  const byOrder = (a, b) => a.order - b.order || a.name.localeCompare(b.name, 'ja');

  const othersById = new Map(chats.map((c) => [c.id, othersOf(c)]));
  const matched = new Map(doc.nodes.map((n) => [n.id, new Set(chats.filter((c) => nodeContains(n, c, othersById.get(c.id))).map((c) => c.id))]));

  const build = (n) => {
    const children = (childrenOf.get(n.id) || []).sort(byOrder).map(build);
    const desc = new Set();
    for (const ch of children) for (const id of ch.subtree) desc.add(id);
    const mine = matched.get(n.id);
    const own = chats.filter((c) => mine.has(c.id) && !desc.has(c.id)).map((c) => c.id);
    const subtree = new Set([...mine, ...desc]);
    return { node: n, children, own, total: subtree.size, subtree };
  };
  const roots = (childrenOf.get(null) || []).sort(byOrder).map(build);

  const classified = new Set();
  for (const r of roots) for (const id of r.subtree) classified.add(id);
  return { roots, unclassified: chats.filter((c) => !classified.has(c.id)).map((c) => c.id) };
}

// ---- 編集(docをその場で書き換える) ----------------------------------------
export const touch = (doc) => {
  doc.updatedAt = new Date().toISOString();
  return doc;
};

export function nextOrder(doc, parentId) {
  const orders = doc.nodes.filter((n) => (n.parentId || null) === (parentId || null)).map((n) => n.order);
  return orders.length ? Math.max(...orders) + 1 : 0;
}

export function addNode(doc, { name, parentId = null, rules = [] }) {
  if (doc.nodes.length >= MAX_NODES) throw new Error(`グループは最大${MAX_NODES}個までです。`);
  const node = { id: newId(), parentId: parentId || null, name: String(name).slice(0, 60), order: nextOrder(doc, parentId), rules, include: [], exclude: [] };
  doc.nodes.push(node);
  return node;
}

export function isDescendant(doc, id, ancestorId) {
  const byId = new Map(doc.nodes.map((n) => [n.id, n]));
  const seen = new Set();
  for (let cur = byId.get(id); cur && !seen.has(cur.id); cur = byId.get(cur.parentId)) {
    if (cur.id === ancestorId) return true;
    seen.add(cur.id);
  }
  return false;
}

// グループを削除する。中にあるグループは、削除したグループの親に移る(チャットは消えない)
export function removeNode(doc, id) {
  const node = doc.nodes.find((n) => n.id === id);
  if (!node) return;
  for (const n of doc.nodes) if (n.parentId === id) n.parentId = node.parentId;
  doc.nodes = doc.nodes.filter((n) => n.id !== id);
}

// 同じ階層の中で、1つ上/下に動かす(dir = -1 または 1)
export function moveSibling(doc, id, dir) {
  const me = doc.nodes.find((n) => n.id === id);
  if (!me) return;
  const sibs = doc.nodes.filter((n) => (n.parentId || null) === (me.parentId || null)).sort((a, b) => a.order - b.order || a.name.localeCompare(b.name, 'ja'));
  const i = sibs.indexOf(me);
  const j = i + dir;
  if (j < 0 || j >= sibs.length) return;
  [sibs[i], sibs[j]] = [sibs[j], sibs[i]];
  sibs.forEach((n, k) => (n.order = k));
}

// 手動でチャットを入れる/外す
export function assignChat(node, chatId) {
  node.exclude = node.exclude.filter((x) => x !== chatId);
  if (!node.include.includes(chatId)) node.include.push(chatId);
}

export function unassignChat(node, chat) {
  node.include = node.include.filter((x) => x !== chat.id);
  if (matchesByRule(node, chat) && !node.exclude.includes(chat.id)) node.exclude.push(chat.id); // 条件に合うものは「外した」と記録する
}

// 「A > B > C」のような、階層のパス表示
export function pathLabel(doc, id) {
  const byId = new Map(doc.nodes.map((n) => [n.id, n]));
  const parts = [];
  const seen = new Set();
  for (let cur = byId.get(id); cur && !seen.has(cur.id); cur = byId.get(cur.parentId)) {
    seen.add(cur.id);
    parts.unshift(cur.name);
  }
  return parts.join(' › ');
}

// 2つの設定のうち、新しい方を選ぶ(同時に編集した場合は、新しい更新日時が勝つ)
export function newer(a, b) {
  if (!a) return b;
  if (!b) return a;
  return (b.updatedAt || '') > (a.updatedAt || '') ? b : a;
}
