// 「整理の仕方」(レンズ)の一覧。画面の「整理の仕方」の選択肢は、ここから自動で作られる。
//
// 新しい整理の仕方を足すには、下の lenses に1つ書き足すだけ。
//   {
//     id: '一意の英数字',
//     name: '画面に出る名前',
//     description: '画面に出る説明',
//     run(data, ctx) { return { groups: [ ... ] }; },
//   }
// run が受け取るもの:
//   data = analyze() の結果(data.chats = チャット一覧, data.clusters = 似たチャットのまとまり)
//   ctx  = { notes: ラベル・メモ }
// run が返すグループの形(チャットは同じものが複数のグループに出てもよい):
//   { id, title, note?: '補足の文', chatIds: ['チャットID', ...], badges?: { チャットID: '行に添える文' } }

const monthKey = (iso) => {
  if (!iso) return null;
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};

const similar = {
  id: 'similar',
  name: 'メンバーが似ている',
  description: 'グループチャットのうち、メンバーが1〜2人しか違わないものを並べます。',
  run(data) {
    const groups = data.clusters.map((cl) => ({
      id: cl.id,
      title: `${cl.chats.length}件のチャットが似ています`,
      note: `全部に共通するメンバー: ${cl.commonMembers.join('、') || '(なし)'}`,
      chatIds: cl.chats.map((x) => x.chatId),
      badges: Object.fromEntries(cl.chats.map((x) => [x.chatId, x.extra.length ? `このチャットだけのメンバー: ${x.extra.join('、')}` : '共通メンバーのみ'])),
    }));
    return { groups, emptyText: '似たチャットはありません。' };
  },
};

const recent = {
  id: 'recent',
  name: '更新された月ごと',
  description: '最後に更新された月でまとめます。長く動いていないチャットを探せます。',
  run(data) {
    const map = new Map();
    for (const c of data.chats) {
      const k = monthKey(c.updatedAt) || 'unknown';
      if (!map.has(k)) map.set(k, []);
      map.get(k).push(c.id);
    }
    const groups = [...map.entries()]
      .sort((a, b) => b[0].localeCompare(a[0]))
      .map(([k, ids]) => ({ id: `m-${k}`, title: k === 'unknown' ? '更新日時が不明' : `${k.slice(0, 4)}年${Number(k.slice(5))}月`, note: `${ids.length}件`, chatIds: ids }));
    return { groups };
  },
};

const bySize = {
  id: 'size',
  name: '人数ごと',
  description: '1対1・少人数・大人数・会議に分けます。',
  run(data) {
    const bands = [
      ['one', '1対1', (c) => c.type === 'oneOnOne'],
      ['small', 'グループ:2〜4人', (c) => c.type === 'group' && c.members.length <= 4],
      ['mid', 'グループ:5〜9人', (c) => c.type === 'group' && c.members.length <= 9],
      ['large', 'グループ:10人以上', (c) => c.type === 'group'],
      ['meeting', '会議チャット', (c) => c.type === 'meeting'],
      ['other', 'その他', () => true],
    ];
    const buckets = new Map(bands.map((b) => [b[0], []]));
    for (const c of data.chats) buckets.get(bands.find((b) => b[2](c))[0]).push(c.id);
    const groups = bands.filter((b) => buckets.get(b[0]).length).map((b) => ({ id: `s-${b[0]}`, title: b[1], note: `${buckets.get(b[0]).length}件`, chatIds: buckets.get(b[0]) }));
    return { groups };
  },
};

const byPerson = {
  id: 'person',
  name: '人ごと',
  description: 'その人が入っているチャットを、人ごとにまとめます(会議チャットは除く。2件以上ある人のみ)。',
  run(data) {
    const map = new Map();
    for (const c of data.chats) {
      if (c.type === 'meeting') continue;
      for (const m of c.members) {
        if (m.isMe) continue;
        if (!map.has(m.id)) map.set(m.id, { name: m.name, ids: [] });
        map.get(m.id).ids.push(c.id);
      }
    }
    const groups = [...map.entries()]
      .filter(([, v]) => v.ids.length >= 2)
      .sort((a, b) => b[1].ids.length - a[1].ids.length)
      .map(([id, v]) => ({ id: `p-${id}`, title: v.name, note: `${v.ids.length}件のチャットに参加`, chatIds: v.ids }));
    return { groups, emptyText: '該当する人はいません。' };
  },
};

export const lenses = [similar, recent, bySize, byPerson];
export const lensById = (id) => lenses.find((l) => l.id === id) || lenses[0];
