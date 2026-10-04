'use strict';
// 動作確認用のデモデータ(架空の人物・架空のチャット)。実際のTeamsとは無関係。

function buildSample() {
  const people = {
    me: '自分(デモ)',
    a: '青木 一郎',
    b: '伊藤 花子',
    c: '上田 次郎',
    d: '遠藤 美咲',
    e: '岡田 健',
    f: '加藤 優',
    g: '木村 直樹',
  };
  const member = (k) => ({ id: `u-${k}`, name: people[k], email: `${k}@example.com` });
  const M = (...keys) => ['me', ...keys].map(member);
  const t = (day, hour) => new Date(Date.UTC(2026, 9, day, hour - 9, 0, 0)).toISOString();
  const msg = (from, text, at) => ({ at, from: people[from], text, isSystem: false });

  let n = 0;
  const chat = (type, keys, o = {}) => ({
    id: `19:demo${++n}@thread.v2`,
    type,
    topic: o.topic || null,
    createdAt: o.createdAt || t(1, 10),
    updatedAt: o.updatedAt || t(1, 10),
    webUrl: 'https://teams.microsoft.com/',
    hidden: !!o.hidden,
    members: M(...keys),
    lastMessage: o.last || null,
  });

  const chats = [
    // 似たチャット(1人違い):同じ工事の打合せ
    chat('group', ['a', 'b', 'c'], { last: msg('a', '見積書を共有します(工事A_見積書.xlsx)', t(30, 16)), updatedAt: t(30, 16) }),
    chat('group', ['a', 'b', 'c', 'd'], { last: msg('d', '図面の修正版を添付しました', t(28, 11)), updatedAt: t(28, 11) }),
    chat('group', ['a', 'b', 'd'], { last: msg('b', '次回の打合せは来週です', t(20, 15)), updatedAt: t(20, 15) }),
    // 同じメンバーが2つ(別々に作られた)
    chat('group', ['e', 'f', 'g'], { topic: '省エネ会議', last: msg('e', '資料はこちらです', t(29, 9)), updatedAt: t(29, 9) }),
    chat('group', ['e', 'f', 'g'], { last: msg('f', '日程調整お願いします', t(15, 13)), updatedAt: t(15, 13) }),
    // 似たチャット(2人違い)
    chat('group', ['b', 'c', 'e', 'f'], { last: msg('c', '点検の結果を報告します', t(25, 14)), updatedAt: t(25, 14) }),
    chat('group', ['b', 'c', 'e', 'g'], { last: msg('g', '了解しました', t(12, 17)), updatedAt: t(12, 17) }),
    // 単独のグループ
    chat('group', ['d', 'g'], { topic: '備品の相談', last: msg('g', 'ありがとうございます', t(10, 10)), updatedAt: t(10, 10) }),
    // 1対1
    chat('oneOnOne', ['a'], { last: msg('a', 'お疲れさまです', t(30, 8)), updatedAt: t(30, 8) }),
    chat('oneOnOne', ['b'], { last: msg('b', '承知しました', t(27, 18)), updatedAt: t(27, 18) }),
    chat('oneOnOne', ['e'], { last: msg('e', 'あとで電話します', t(5, 12)), updatedAt: t(5, 12) }),
    // 会議
    chat('meeting', ['a', 'b', 'c', 'd', 'e', 'f', 'g'], { topic: '週次定例', last: msg('a', '議事録を共有します', t(26, 11)), updatedAt: t(26, 11) }),
    chat('meeting', ['a', 'c', 'e'], { topic: '設備点検の打合せ', hidden: true, updatedAt: t(2, 10) }),
  ];

  return { source: 'sample', fetchedAt: new Date().toISOString(), me: { id: 'u-me', name: people.me, email: 'me@example.com' }, chats };
}

// デモ用のグループ設定(架空)。課の下に、条件で振り分けるグループを置いた例。
function sampleGroups() {
  const node = (id, parentId, name, order, rules = []) => ({ id, parentId, name, order, rules, include: [], exclude: [] });
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    nodes: [
      node('g-demo-fac', null, '施設課', 0),
      node('g-demo-fac-1', 'g-demo-fac', '課長と自分', 0, [{ type: 'exact', members: ['u-a'], types: [] }]),
      node('g-demo-fac-2', 'g-demo-fac', '課長と補佐のみ', 1, [{ type: 'exact', members: ['u-a', 'u-b'], types: [] }]),
      node('g-demo-fac-3', 'g-demo-fac', '工事Aの関係', 2, [{ type: 'all', members: ['u-a', 'u-b'], types: ['group'] }]),
      node('g-demo-adm', null, '管理課', 1),
      node('g-demo-adm-1', 'g-demo-adm', '用度1と自分', 0, [{ type: 'exact', members: ['u-e'], types: [] }]),
      node('g-demo-adm-2', 'g-demo-adm', '省エネ会議', 1, [{ type: 'exact', members: ['u-e', 'u-f', 'u-g'], types: ['group'] }]),
    ],
  };
}

export { buildSample, sampleGroups };
