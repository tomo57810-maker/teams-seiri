// 「グループ」タブの画面。階層のグループを開閉しながら、その場でチャットを見られる。
// app = { st, save(), rerenderList(), chatRow(chat, extra, onclick, opened), chatDetail(chat), searchSet() }
import { h, toast } from './util.js';
import * as G from './groups.js';

const TYPE_OPTIONS = [
  ['group', 'グループ'],
  ['oneOnOne', '1対1'],
  ['meeting', '会議'],
];

// ---- 人の一覧(条件の指定に使う)--------------------------------------------
const peopleCache = new WeakMap();
export function peopleIndex(data) {
  if (peopleCache.has(data)) return peopleCache.get(data);
  const map = new Map();
  for (const c of data.chats) {
    for (const m of c.members) {
      if (m.isMe) continue;
      const e = map.get(m.id) || { id: m.id, name: m.name, count: 0 };
      e.count++;
      map.set(m.id, e);
    }
  }
  const list = [...map.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'ja'));
  peopleCache.set(data, list);
  return list;
}

// ---- グループ一覧 ---------------------------------------------------------
export function groupsTab(app) {
  const { st } = app;
  const wrap = h('div', { class: 'groups' });
  wrap.append(
    h(
      'div',
      { class: 'gbar' },
      h('button', { class: 'primary', onclick: () => openEditor(app, null, null) }, '＋ グループを追加'),
      h('span', { class: 'kv' }, 'グループの中のグループも作れます(各グループの「＋」)。')
    )
  );
  if (st.editing) wrap.append(editorPanel(app));

  const tree = G.buildTree(st.data, st.groups);
  const searchSet = app.searchSet();
  const byId = new Map(st.data.chats.map((c) => [c.id, c]));

  if (!st.groups.nodes.length) {
    wrap.append(h('div', { class: 'empty' }, h('h2', {}, 'グループを作りましょう'), h('p', {}, '例:「施設課」を作り、その中に「課長と自分」「課長と補佐のみ」を作ります。条件(人)を指定すると、チャットが自動で入ります。')));
  }
  let shown = 0;
  for (const v of tree.roots) {
    const el = nodeEl(v, app, byId, searchSet);
    if (el) {
      wrap.append(el);
      shown++;
    }
  }
  // 未分類
  const rest = searchSet ? tree.unclassified.filter((id) => searchSet.has(id)) : tree.unclassified;
  if (rest.length || !searchSet) {
    const open = searchSet ? true : st.openGroups.includes('unclassified');
    wrap.append(
      h(
        'div',
        { class: 'gnode' },
        h('div', { class: 'ghead muted', onclick: () => toggle(app, 'unclassified') }, h('span', { class: 'caret' }, open ? '▼' : '▶'), h('span', { class: 'gname' }, '未分類'), h('span', { class: 'badge gray' }, `${rest.length}件`)),
        open ? h('div', { class: 'gbody' }, rest.length ? rest.map((id) => chatWrap(byId.get(id), app)) : h('p', { class: 'kv' }, 'すべてのチャットがグループに入っています。')) : null
      )
    );
  }
  if (searchSet && !shown && !rest.length) wrap.append(h('p', { class: 'kv' }, '該当するチャットはありません。'));
  return wrap;
}

function toggle(app, id) {
  const open = app.st.openGroups;
  const i = open.indexOf(id);
  if (i >= 0) open.splice(i, 1);
  else open.push(id);
  app.savePrefs();
  app.rerenderList();
}

function chatWrap(c, app) {
  const { st } = app;
  const opened = st.openChat === c.id;
  return h(
    'div',
    { class: 'chatwrap' },
    app.chatRow(c, null, () => {
      st.openChat = opened ? null : c.id;
      app.rerenderList();
    }, opened),
    opened ? h('div', { class: 'inline' }, app.chatDetail(c)) : null
  );
}

function nodeEl(v, app, byId, searchSet) {
  const { st } = app;
  const hits = searchSet ? [...v.subtree].filter((id) => searchSet.has(id)).length : v.total;
  if (searchSet && !hits) return null;
  const open = searchSet ? true : st.openGroups.includes(v.node.id);
  const mini = (label, title, fn) =>
    h(
      'button',
      {
        class: 'mini',
        title,
        onclick: (e) => {
          e.stopPropagation();
          fn();
        },
      },
      label
    );
  const own = searchSet ? v.own.filter((id) => searchSet.has(id)) : v.own;
  const children = v.children.map((ch) => nodeEl(ch, app, byId, searchSet)).filter(Boolean);
  return h(
    'div',
    { class: 'gnode' },
    h(
      'div',
      { class: 'ghead', onclick: () => toggle(app, v.node.id) },
      h('span', { class: 'caret' }, open ? '▼' : '▶'),
      h('span', { class: 'gname' }, v.node.name),
      h('span', { class: 'badge' }, `${searchSet ? hits : v.total}件`),
      h(
        'span',
        { class: 'gtools' },
        mini('↑', '上へ', () => (G.moveSibling(st.groups, v.node.id, -1), app.save())),
        mini('↓', '下へ', () => (G.moveSibling(st.groups, v.node.id, 1), app.save())),
        mini('＋', 'この中にグループを作る', () => openEditor(app, null, v.node.id)),
        mini('編集', '名前・条件を編集', () => openEditor(app, v.node, null))
      )
    ),
    open
      ? h(
          'div',
          { class: 'gbody' },
          children,
          own.map((id) => chatWrap(byId.get(id), app)),
          !children.length && !own.length ? h('p', { class: 'kv' }, 'チャットはありません。「編集」で条件を足すか、チャットの詳細から手動で入れられます。') : null
        )
      : null
  );
}

// ---- グループの編集 -------------------------------------------------------
function openEditor(app, node, parentId) {
  const { st } = app;
  st.editing = node
    ? { id: node.id, draft: { name: node.name, parentId: node.parentId, rules: structuredClone(node.rules) } }
    : { id: null, draft: { name: '', parentId: parentId || null, rules: [] } };
  app.rerenderList();
  const el = document.getElementById('geditor');
  if (el) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function editorPanel(app) {
  const { st } = app;
  const ed = st.editing;
  const d = ed.draft;
  const doc = st.groups;
  const box = h('div', { class: 'panel geditor', id: 'geditor' });
  const refresh = () => box.replaceWith(editorPanel(app));

  const name = h('input', { type: 'text', value: d.name, placeholder: '例:施設課', maxlength: '60' });
  name.addEventListener('input', () => (d.name = name.value));

  const parent = h('select', {}, h('option', { value: '' }, '(最上位)'));
  for (const n of [...doc.nodes].sort((a, b) => G.pathLabel(doc, a.id).localeCompare(G.pathLabel(doc, b.id), 'ja'))) {
    if (n.id === ed.id || (ed.id && G.isDescendant(doc, n.id, ed.id))) continue; // 自分自身と、自分の中のグループは親にできない
    parent.append(h('option', { value: n.id }, G.pathLabel(doc, n.id)));
  }
  parent.value = d.parentId || '';
  parent.addEventListener('change', () => (d.parentId = parent.value || null));

  const save = () => {
    const nm = d.name.trim();
    if (!nm) return toast('グループ名を入力してください。', true);
    const rules = d.rules.filter((r) => r.members.length); // 人を指定していない条件は捨てる
    try {
      if (ed.id) {
        const n = doc.nodes.find((x) => x.id === ed.id);
        Object.assign(n, { name: nm, parentId: d.parentId, rules });
      } else {
        G.addNode(doc, { name: nm, parentId: d.parentId, rules });
      }
    } catch (e) {
      return toast(e.message, true);
    }
    if (d.parentId && !st.openGroups.includes(d.parentId)) st.openGroups.push(d.parentId);
    st.editing = null;
    app.save();
  };
  const remove = () => {
    if (!confirm('このグループを削除しますか?\n(中のグループは1つ上の階層に移ります。チャット自体は消えません)')) return;
    G.removeNode(doc, ed.id);
    st.editing = null;
    app.save();
  };

  box.append(
    h('h3', {}, ed.id ? 'グループを編集' : 'グループを作る'),
    h('h4', {}, 'グループ名'),
    name,
    h('h4', {}, '入れる場所(親のグループ)'),
    parent,
    h('h4', {}, '自動で入れる条件'),
    h('p', { class: 'kv' }, '条件に合うチャットが、自動でこのグループに入ります。条件は複数作れ、どれか1つに合えば入ります。条件がなくても、手動でチャットを入れられます。'),
    ...d.rules.map((r, i) => ruleEl(r, i, d, app, refresh)),
    h('div', { class: 'btns left' }, h('button', { onclick: () => (d.rules.push({ type: 'exact', members: [], types: [] }), refresh()) }, '＋ 条件を追加')),
    h(
      'div',
      { class: 'btns left' },
      h('button', { class: 'primary', onclick: save }, '保存'),
      h('button', { onclick: () => ((st.editing = null), app.rerenderList()) }, 'キャンセル'),
      ed.id ? h('button', { class: 'danger', onclick: remove }, 'このグループを削除') : null
    )
  );
  return box;
}

function ruleEl(rule, index, d, app, refresh) {
  const data = app.st.data;
  const people = peopleIndex(data);
  const nameOf = (id) => (people.find((p) => p.id === id) || { name: '(一覧にない人)' }).name;

  const sel = h('select', {}, G.RULE_TYPES.map((t) => h('option', { value: t }, G.RULE_LABEL[t])));
  sel.value = rule.type;

  const count = h('span', { class: 'kv' });
  const updateCount = () => {
    const n = data.chats.filter((c) => G.ruleMatches(rule, c)).length;
    count.textContent = rule.members.length ? `この条件に合うチャット: ${n}件` : '人を指定してください(指定がない条件は無視されます)';
  };
  sel.addEventListener('change', () => {
    rule.type = sel.value;
    updateCount();
  });

  const types = h(
    'div',
    { class: 'rtypes' },
    h('span', { class: 'kv' }, '対象の種類(選ばなければ全部):'),
    TYPE_OPTIONS.map(([v, label]) => {
      const cb = h('input', { type: 'checkbox', checked: rule.types.includes(v) });
      cb.addEventListener('change', () => {
        rule.types = cb.checked ? [...rule.types, v] : rule.types.filter((x) => x !== v);
        updateCount();
      });
      return h('label', { class: 'cb' }, cb, label);
    })
  );

  const chips = h('div', { class: 'gchips' });
  const renderChips = () => {
    chips.replaceChildren(
      ...rule.members.map((id) =>
        h(
          'span',
          { class: 'member' },
          nameOf(id),
          h(
            'button',
            {
              class: 'x',
              title: '外す',
              onclick: () => {
                rule.members = rule.members.filter((x) => x !== id);
                renderChips();
                updateCount();
              },
            },
            '×'
          )
        )
      )
    );
  };

  const results = h('div', { class: 'presults' });
  const search = h('input', { type: 'search', placeholder: '人の名前で探して追加(例:課長)' });
  search.addEventListener('input', () => {
    const q = search.value.trim().toLowerCase();
    results.replaceChildren();
    if (!q) return;
    const hits = people.filter((p) => !rule.members.includes(p.id) && p.name.toLowerCase().includes(q)).slice(0, 20);
    if (!hits.length) results.append(h('div', { class: 'kv' }, '該当する人はいません。'));
    for (const p of hits) {
      results.append(
        h(
          'button',
          {
            class: 'presult',
            onclick: () => {
              rule.members.push(p.id);
              search.value = '';
              results.replaceChildren();
              renderChips();
              updateCount();
            },
          },
          `${p.name}(${p.count}件のチャットに参加)`
        )
      );
    }
  });

  renderChips();
  updateCount();
  return h(
    'div',
    { class: 'rule' },
    h('div', { class: 'rulehead' }, h('strong', {}, `条件${index + 1}`), h('button', { class: 'mini', onclick: () => (d.rules.splice(index, 1), refresh()) }, '削除')),
    sel,
    types,
    chips,
    search,
    results,
    count
  );
}

// ---- チャットの詳細に出す「グループ」欄(手動で入れる・外す)------------------
export function assignmentPanel(c, app) {
  const { st } = app;
  const doc = st.groups;
  if (!doc.nodes.length) return h('div', { class: 'assign' }, h('h4', {}, 'グループ'), h('div', { class: 'kv' }, '先に「グループ」タブでグループを作ってください。'));
  const inIds = new Set(G.nodesContaining(doc, c));
  const chips = doc.nodes
    .filter((n) => inIds.has(n.id))
    .map((n) =>
      h(
        'span',
        { class: 'member' },
        G.pathLabel(doc, n.id),
        h(
          'button',
          {
            class: 'x',
            title: 'このグループから外す',
            onclick: (e) => {
              e.stopPropagation();
              G.unassignChat(n, c);
              app.save();
            },
          },
          '×'
        )
      )
    );
  const others = doc.nodes.filter((n) => !inIds.has(n.id)).sort((a, b) => G.pathLabel(doc, a.id).localeCompare(G.pathLabel(doc, b.id), 'ja'));
  const sel = h('select', {}, others.map((n) => h('option', { value: n.id }, G.pathLabel(doc, n.id))));
  return h(
    'div',
    { class: 'assign' },
    h('h4', {}, 'グループ'),
    chips.length ? h('div', { class: 'gchips' }, chips) : h('div', { class: 'kv' }, 'どのグループにも入っていません(未分類)'),
    others.length
      ? h(
          'div',
          { class: 'gadd' },
          sel,
          h(
            'button',
            {
              onclick: (e) => {
                e.stopPropagation();
                G.assignChat(doc.nodes.find((n) => n.id === sel.value), c.id);
                app.save();
              },
            },
            'このグループに入れる'
          )
        )
      : null
  );
}
