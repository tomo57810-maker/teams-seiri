'use strict';
// チャット一覧(生データ)を、整理しやすい形に変換する。
// 考え方:メンバーの組み合わせ(自分以外のメンバーID)をチャットの識別キーにする。
//   - 同じメンバーのチャットが複数 → 「同じメンバー」
//   - メンバーが1〜2人だけ違うグループチャット → 「似たチャット」
// 似たチャットの対象は、種類が group(グループチャット)のものだけ。
// 1対1(oneOnOne)は相手ごとに1つ、会議(meeting)は会議ごとに作られるため、対象外とする。

const SIMILAR_MAX_DIFF = 2; // メンバーの差(追加・削除の合計人数)がこの人数以内なら「似ている」
const SIMILAR_MIN_OTHERS = 2; // 比べるチャットの、自分以外のメンバー数の下限
const SIMILAR_MIN_COMMON = 2; // 共通するメンバー(自分以外)の下限。人数の少ないチャットが偶然つながるのを防ぐ
const SIMILAR_MIN_JACCARD = 0.5; // 共通メンバー ÷ 全体のメンバー の下限

function diffSets(a, b) {
  const added = [...b].filter((x) => !a.has(x)); // b にだけいる
  const removed = [...a].filter((x) => !b.has(x)); // a にだけいる
  return { added, removed };
}

function displayNameOf(chat, others) {
  if (chat.topic) return chat.topic;
  if (chat.type === 'meeting') return '(会議チャット)';
  if (others.length === 0) return '(自分のみ)';
  const names = others.map((m) => m.name);
  if (names.length <= 3) return names.join('、');
  return `${names.slice(0, 3).join('、')} ほか${names.length - 3}名`;
}

function analyze(data) {
  const meId = data.me && data.me.id;
  const idToName = new Map();
  for (const c of data.chats) for (const m of c.members) idToName.set(m.id, m.name);
  const nameOf = (id) => idToName.get(id) || '(不明)';

  const chats = data.chats.map((c) => {
    const members = c.members.map((m) => ({ ...m, isMe: m.id === meId }));
    const others = members.filter((m) => !m.isMe);
    const otherIds = others.map((m) => m.id).sort();
    const lastAt = (c.lastMessage && c.lastMessage.at) || c.updatedAt || c.createdAt || null;
    return {
      id: c.id,
      type: c.type,
      topic: c.topic || null,
      displayName: displayNameOf(c, others),
      createdAt: c.createdAt || null,
      updatedAt: lastAt,
      lastMessage: c.lastMessage || null,
      webUrl: c.webUrl || null,
      hidden: !!c.hidden,
      members,
      otherCount: others.length,
      memberKey: otherIds.join('|'),
      identical: [],
      similar: [],
      clusterId: null,
    };
  });

  chats.sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));

  // 似たチャットの検出(グループチャットどうしの総当たり)
  const groups = chats.filter((c) => c.type === 'group' && c.otherCount >= SIMILAR_MIN_OTHERS);
  const sets = new Map(groups.map((c) => [c.id, new Set(c.memberKey.split('|'))]));
  const neighbors = new Map(groups.map((c) => [c.id, new Set()]));

  for (let i = 0; i < groups.length; i++) {
    for (let j = i + 1; j < groups.length; j++) {
      const a = groups[i];
      const b = groups[j];
      if (Math.abs(a.otherCount - b.otherCount) > SIMILAR_MAX_DIFF) continue;
      const { added, removed } = diffSets(sets.get(a.id), sets.get(b.id));
      const diff = added.length + removed.length;
      if (diff > SIMILAR_MAX_DIFF) continue;
      const common = a.otherCount - removed.length;
      if (common < SIMILAR_MIN_COMMON || common / (common + diff) < SIMILAR_MIN_JACCARD) continue;
      if (diff === 0) {
        a.identical.push(b.id);
        b.identical.push(a.id);
      } else {
        a.similar.push({ id: b.id, added: added.map(nameOf), removed: removed.map(nameOf) });
        b.similar.push({ id: a.id, added: removed.map(nameOf), removed: added.map(nameOf) });
      }
      neighbors.get(a.id).add(b.id);
      neighbors.get(b.id).add(a.id);
    }
  }

  // まとまり(クラスタ)の作成:新しい順に見ていき、「中の全員と似ている」まとまりにだけ入れる。
  // (AとB、BとCが似ているだけでAとCまでつなげると、巨大なまとまりになってしまうため)
  const grouped = [];
  for (const c of groups) {
    if (!neighbors.get(c.id).size) continue;
    let target = grouped.find((list) => list.every((o) => neighbors.get(c.id).has(o.id)));
    if (!target) {
      // どこにも全員とは似ていない場合は、似たチャットが一番多いまとまりに入れる(単独で残さない)
      const scored = grouped
        .map((list) => ({ list, n: list.filter((o) => neighbors.get(c.id).has(o.id)).length }))
        .filter((x) => x.n > 0)
        .sort((x, y) => y.n - x.n);
      target = scored.length ? scored[0].list : null;
    }
    if (!target) {
      target = [];
      grouped.push(target);
    }
    target.push(c);
  }
  const members = grouped.filter((list) => list.length > 1);
  const clusters = [];
  for (const list of members) {
    const id = `cl${clusters.length + 1}`;
    let common = new Set(sets.get(list[0].id));
    for (const c of list) common = new Set([...common].filter((x) => sets.get(c.id).has(x)));
    for (const c of list) c.clusterId = id;
    clusters.push({
      id,
      commonMembers: [...common].map(nameOf),
      chats: list.map((c) => ({
        chatId: c.id,
        extra: [...sets.get(c.id)].filter((x) => !common.has(x)).map(nameOf),
      })),
      latestAt: list.reduce((m, c) => ((c.updatedAt || '') > m ? c.updatedAt || '' : m), ''),
    });
  }
  clusters.sort((a, b) => b.latestAt.localeCompare(a.latestAt));

  // 同じメンバーのチャットの組の数
  let identicalSets = 0;
  const seen = new Set();
  for (const c of chats) {
    if (!c.identical.length || seen.has(c.id)) continue;
    identicalSets++;
    seen.add(c.id);
    c.identical.forEach((x) => seen.add(x));
  }

  const counts = {
    total: chats.length,
    group: chats.filter((c) => c.type === 'group').length,
    oneOnOne: chats.filter((c) => c.type === 'oneOnOne').length,
    meeting: chats.filter((c) => c.type === 'meeting').length,
    other: chats.filter((c) => !['group', 'oneOnOne', 'meeting'].includes(c.type)).length,
    hidden: chats.filter((c) => c.hidden).length,
    clusters: clusters.length,
    chatsInClusters: clusters.reduce((n, cl) => n + cl.chats.length, 0),
    identicalSets,
  };

  return { me: data.me || null, fetchedAt: data.fetchedAt || null, source: data.source || null, chats, clusters, counts };
}

export { analyze, SIMILAR_MAX_DIFF, SIMILAR_MIN_OTHERS };
