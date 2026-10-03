import { analyze } from './analyze.js';
import { buildSample } from './sample.js';
import { lenses, lensById } from './lenses.js';
import { dbGet, dbSet, dbDelete } from './db.js';
import { parseImport } from './importer.js';

const TYPE_LABEL = { group: 'グループ', oneOnOne: '1対1', meeting: '会議' };
const typeLabel = (t) => TYPE_LABEL[t] || 'その他';
const PREF_KEY = 'teams-seiri:prefs';

const st = { raw: null, data: null, notes: {}, tab: 'all', lens: 'similar', q: '', type: 'all', dupOnly: false, selected: null, busy: false, progress: '', page: 'main' };

try {
  Object.assign(st, JSON.parse(localStorage.getItem(PREF_KEY) || '{}'));
} catch {
  /* 保存した表示設定が読めなければ、初期値のまま */
}
const savePrefs = () => {
  try {
    localStorage.setItem(PREF_KEY, JSON.stringify({ tab: st.tab, lens: st.lens }));
  } catch {
    /* 保存できなくても動作には影響しない */
  }
};

// ---- 小さな部品 -----------------------------------------------------------
function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === false || v == null) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'text') el.textContent = v;
    else if (k === 'value') el.value = v;
    else el.setAttribute(k, v);
  }
  for (const c of children.flat()) if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(c));
  return el;
}

let toastTimer;
function toast(msg, isErr = false) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = isErr ? 'toast err' : 'toast';
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), isErr ? 15000 : 3500);
}

function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const opt = { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' };
  if (d.getFullYear() !== new Date().getFullYear()) opt.year = 'numeric';
  return d.toLocaleString('ja-JP', opt);
}

async function run(fn) {
  if (st.busy) return;
  st.busy = true;
  st.progress = '';
  render();
  try {
    await fn();
  } catch (e) {
    toast(e.message, true);
  } finally {
    st.busy = false;
    st.progress = '';
    render();
  }
}

// ---- データ ---------------------------------------------------------------
function setRaw(raw) {
  st.raw = raw;
  st.data = raw ? analyze(raw) : null;
}

// 取得ツールが書き出した chats.json を、端末のファイルから選んで読み込む
function pickFile() {
  const input = h('input', { type: 'file', accept: '.json,application/json' });
  input.addEventListener('change', () => {
    const file = input.files && input.files[0];
    if (!file) return;
    run(async () => {
      if (file.size > 50 * 1024 * 1024) throw new Error('ファイルが大きすぎます。');
      const raw = parseImport(await file.text());
      await dbSet('chats', raw);
      setRaw(raw);
      toast(`${raw.chats.length}件のチャットを読み込みました。`);
    });
  });
  input.click();
}

const doDemo = () =>
  run(async () => {
    const raw = buildSample();
    await dbSet('chats', raw);
    setRaw(raw);
  });

const doClear = () =>
  run(async () => {
    await dbDelete('chats');
    setRaw(null);
    st.selected = null;
  });

// ---- 絞り込み -------------------------------------------------------------
function visibleChats(searchOnly = false) {
  const q = st.q.trim().toLowerCase();
  return st.data.chats.filter((c) => {
    if (!searchOnly && st.type !== 'all' && c.type !== st.type) return false;
    if (!searchOnly && st.dupOnly && !c.identical.length && !c.similar.length) return false;
    if (!q) return true;
    const n = st.notes[c.id] || {};
    const hay = [c.displayName, c.topic, n.label, n.memo, ...c.members.flatMap((m) => [m.name, m.email])].filter(Boolean).join('\n').toLowerCase();
    return q.split(/\s+/).every((w) => hay.includes(w));
  });
}

// ---- 描画:一覧 -----------------------------------------------------------
function chatRow(c, extra) {
  const n = st.notes[c.id] || {};
  const names = c.members.filter((m) => !m.isMe).map((m) => m.name).join('、');
  return h(
    'div',
    { class: `row${st.selected === c.id ? ' sel' : ''}`, onclick: () => select(c.id) },
    h(
      'div',
      { class: 't' },
      h('span', { class: 'badge gray' }, typeLabel(c.type)),
      h('span', { class: 'name' }, c.displayName),
      h('span', { class: 'badge' }, `${c.members.length}人`),
      c.identical.length ? h('span', { class: 'badge dup' }, `同じメンバー ${c.identical.length}件`) : null,
      c.similar.length ? h('span', { class: 'badge warn' }, `似たチャット ${c.similar.length}件`) : null,
      c.hidden ? h('span', { class: 'badge gray' }, '非表示') : null,
      n.label ? h('span', { class: 'badge' }, `🏷 ${n.label}`) : null,
      h('span', { class: 'date' }, fmtDate(c.updatedAt))
    ),
    extra ? h('div', { class: 'extra' }, extra) : null,
    h('div', { class: 'meta' }, c.topic ? `メンバー: ${names}` : n.memo || '')
  );
}

function renderList() {
  const box = document.getElementById('list');
  if (!box) return;
  box.replaceChildren();
  if (st.tab === 'all') {
    const list = visibleChats();
    if (!list.length) box.append(h('p', { class: 'kv' }, '該当するチャットはありません。'));
    list.forEach((c) => box.append(chatRow(c)));
    return;
  }
  const byId = new Map(st.data.chats.map((c) => [c.id, c]));
  const matched = new Set(visibleChats(true).map((c) => c.id));
  const lens = lensById(st.lens);
  const { groups, emptyText } = lens.run(st.data, { notes: st.notes });
  let shown = 0;
  for (const g of groups) {
    const ids = g.chatIds.filter((id) => !st.q.trim() || matched.has(id));
    if (!ids.length) continue;
    shown++;
    box.append(h('div', { class: 'cluster' }, h('h3', {}, g.title), g.note ? h('div', { class: 'common' }, g.note) : null, ids.map((id) => chatRow(byId.get(id), g.badges && g.badges[id]))));
  }
  if (!shown) box.append(h('p', { class: 'kv' }, emptyText || '該当するものはありません。'));
}

function select(id) {
  st.selected = id;
  renderDetail();
  renderList();
}

function renderDetail() {
  const box = document.getElementById('detail');
  const c = st.data && st.data.chats.find((x) => x.id === st.selected);
  if (!c) {
    box.hidden = true;
    return;
  }
  const n = st.notes[c.id] || { label: '', memo: '' };
  const byId = new Map(st.data.chats.map((x) => [x.id, x]));
  const label = h('input', { type: 'text', value: n.label, placeholder: '例:医学部の工事の件', maxlength: '100' });
  const memo = h('textarea', { placeholder: 'このチャットのメモ(この端末にだけ保存。Teamsには反映されません)' });
  memo.value = n.memo || '';
  const save = async () => {
    if (label.value || memo.value) st.notes[c.id] = { label: label.value, memo: memo.value };
    else delete st.notes[c.id];
    await dbSet('notes', st.notes);
    renderList();
  };
  label.addEventListener('change', save);
  memo.addEventListener('change', save);

  const block = (items, title, fn) => (items.length ? [h('h4', {}, title), ...items.map(fn)] : []);
  const parts = [
    h('button', { class: 'close', onclick: () => ((st.selected = null), renderDetail(), renderList()) }, '✕'),
    h('h2', {}, c.displayName),
    h('div', { class: 'kv' }, `${typeLabel(c.type)} / ${c.members.length}人 / 最終更新 ${fmtDate(c.updatedAt) || '不明'} / 作成 ${fmtDate(c.createdAt) || '不明'}`),
    c.webUrl && c.webUrl.startsWith('https://') ? h('p', {}, h('a', { class: 'btn primary', href: c.webUrl, target: '_blank', rel: 'noopener' }, 'Teams で開く')) : null,
    h('h4', {}, 'メンバー'),
    h('div', { class: 'members' }, c.members.map((m) => h('span', { class: `member${m.isMe ? ' me' : ''}`, title: m.email || '' }, m.isMe ? `${m.name}(自分)` : m.name))),
    block(c.identical, 'メンバーが全く同じチャット', (id) => {
      const o = byId.get(id);
      return h('div', { class: 'sim', onclick: () => select(id) }, h('div', {}, o.displayName), h('div', { class: 'kv' }, `最終更新 ${fmtDate(o.updatedAt)}`));
    }),
    block(c.similar, 'メンバーが少し違うチャット', (s) => {
      const o = byId.get(s.id);
      return h(
        'div',
        { class: 'sim', onclick: () => select(s.id) },
        h('div', {}, o.displayName),
        h('div', { class: 'diff' }, s.added.length ? h('span', { class: 'add' }, `向こうだけ: ${s.added.join('、')}  `) : null, s.removed.length ? h('span', { class: 'del' }, `こちらだけ: ${s.removed.join('、')}`) : null),
        h('div', { class: 'kv' }, `最終更新 ${fmtDate(o.updatedAt)}`)
      );
    }),
    h('h4', {}, 'ラベル'),
    label,
    h('h4', {}, 'メモ'),
    memo,
  ];
  box.replaceChildren(...parts.flat().filter(Boolean));
  box.hidden = false;
}

// ---- 描画:各画面 ---------------------------------------------------------
function renderEmpty(main) {
  main.append(
    h(
      'div',
      { class: 'empty' },
      h('h2', {}, 'Teams のチャットを取り込みましょう'),
      h('ol', {}, h('li', {}, 'PCで取得ツールを実行し、チャット一覧のファイル(chats.json)を作る'), h('li', {}, '下の「ファイルを選ぶ」で、そのファイルを選ぶ(大学のOneDriveの「Teams整理」フォルダ)'), h('li', {}, '整理した結果が表示されます')),
      h('div', { class: 'btns' }, h('button', { class: 'primary', onclick: pickFile, disabled: st.busy }, st.busy ? '読み込み中…' : 'ファイルを選ぶ'), h('button', { onclick: doDemo }, 'デモデータで画面を試す')),
      h('p', { class: 'small' }, '読み取り専用です。このアプリはインターネットにデータを送りません。読み込んだデータは、この端末のブラウザの中だけに保存されます。')
    )
  );
}

function renderSettings(main) {
  main.append(
    h(
      'div',
      { class: 'panel' },
      h('h2', {}, 'データの管理'),
      h('p', { class: 'kv' }, '読み込んだチャットのデータは、この端末のブラウザの中だけに保存されています。共有の端末では、使い終わったら消してください。'),
      h('div', { class: 'btns left' }, h('button', { class: 'primary', onclick: pickFile }, '別のファイルを読み込む'), h('button', { onclick: () => (doClear(), (st.page = 'main')) }, '読み込んだデータを消す')),
      h('div', { class: 'btns left' }, h('button', { onclick: () => ((st.page = 'main'), render()) }, '戻る'))
    )
  );
}

function renderCards(main) {
  const c = st.data.counts;
  const card = (num, lbl, hl) => h('div', { class: `card${hl ? ' hl' : ''}` }, h('div', { class: 'num' }, String(num)), h('div', { class: 'lbl' }, lbl));
  main.append(
    h(
      'div',
      { class: 'cards' },
      card(c.total, 'チャットの合計'),
      card(c.group, 'グループチャット'),
      card(c.oneOnOne, '1対1'),
      card(c.meeting, '会議チャット'),
      card(c.clusters, `似たチャットのまとまり(${c.chatsInClusters}件)`, c.clusters > 0),
      card(c.identicalSets, '同じメンバーが複数ある組', c.identicalSets > 0)
    )
  );
}

function renderTools(main) {
  const chip = (label, on, fn) => h('button', { class: `chip${on ? ' on' : ''}`, onclick: fn }, label);
  const search = h('input', { type: 'search', placeholder: '検索(名前・メンバー・メモ。空白で複数条件)', value: st.q });
  search.addEventListener('input', () => {
    st.q = search.value;
    renderList();
  });
  main.append(
    h(
      'div',
      { class: 'tabs' },
      h('button', { class: `tab${st.tab === 'all' ? ' on' : ''}`, onclick: () => ((st.tab = 'all'), savePrefs(), render()) }, `すべて(${st.data.counts.total})`),
      h('button', { class: `tab${st.tab === 'view' ? ' on' : ''}`, onclick: () => ((st.tab = 'view'), savePrefs(), render()) }, '整理して見る')
    )
  );
  const tools = h('div', { class: 'tools' }, search);
  if (st.tab === 'all') {
    tools.append(
      h(
        'div',
        { class: 'chips' },
        chip('すべて', st.type === 'all', () => ((st.type = 'all'), render())),
        chip('グループ', st.type === 'group', () => ((st.type = 'group'), render())),
        chip('1対1', st.type === 'oneOnOne', () => ((st.type = 'oneOnOne'), render())),
        chip('会議', st.type === 'meeting', () => ((st.type = 'meeting'), render())),
        chip('似ている・同じメンバーのみ', st.dupOnly, () => ((st.dupOnly = !st.dupOnly), render()))
      )
    );
  } else {
    const sel = h('select', { 'aria-label': '整理の仕方' }, lenses.map((l) => h('option', { value: l.id }, l.name)));
    sel.value = lensById(st.lens).id;
    sel.addEventListener('change', () => {
      st.lens = sel.value;
      savePrefs();
      render();
    });
    tools.append(h('label', { class: 'lens' }, '整理の仕方:', sel));
  }
  main.append(tools);
  if (st.tab === 'view') main.append(h('p', { class: 'kv' }, lensById(st.lens).description));
}

function renderHeader() {
  const status = document.getElementById('status');
  const actions = document.getElementById('actions');
  status.textContent = st.raw ? `${st.raw.source === 'sample' ? '【デモデータ】' : ''}取得: ${fmtDate(st.raw.fetchedAt)}` : '';
  actions.replaceChildren();
  if (st.raw && st.raw.source !== 'sample') actions.append(h('button', { class: 'primary', onclick: pickFile, disabled: st.busy }, st.busy ? '読み込み中…' : '最新のファイルを読み込む'));
  if (st.raw && st.raw.source === 'sample') actions.append(h('button', { onclick: doClear }, 'デモを消す'));
  if (st.raw) actions.append(h('button', { onclick: () => ((st.page = st.page === 'settings' ? 'main' : 'settings'), render()) }, 'データ管理'));
}

function render() {
  renderHeader();
  const main = document.getElementById('main');
  main.replaceChildren();
  if (st.page === 'settings') {
    renderSettings(main);
    document.getElementById('detail').hidden = true;
    return;
  }
  if (!st.data) {
    renderEmpty(main);
    renderDetail();
    return;
  }
  renderCards(main);
  renderTools(main);
  main.append(h('div', { class: 'list', id: 'list' }));
  main.append(h('p', { class: 'note' }, '「似たチャット」は、グループチャットのうち、メンバーの違いが2人以内で、自分以外の共通メンバーが2人以上いるものです。1対1と会議は対象外です。'));
  renderList();
  renderDetail();
}

// ---- 起動 -----------------------------------------------------------------
(async function init() {
  if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('./sw.js').catch(() => {});
  try {
    setRaw(await dbGet('chats', null));
    st.notes = await dbGet('notes', {});
  } catch (e) {
    toast(e.message, true);
  }
  render();
})();
