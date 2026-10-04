import { analyze } from './analyze.js';
import { buildSample, sampleGroups } from './sample.js';
import { lenses, lensById } from './lenses.js';
import { dbGet, dbSet, dbDelete } from './db.js';
import { parseImport } from './importer.js';
import * as G from './groups.js';
import * as sync from './sync.js';
import { groupsTab, assignmentPanel } from './groups-ui.js';
import { h, toast, fmtDate, typeLabel } from './util.js';

const PREF_KEY = 'teams-seiri:prefs';

const st = {
  raw: null,
  data: null,
  notes: {},
  groups: G.emptyDoc(),
  folder: { handle: null, granted: false },
  tab: 'groups',
  lens: 'similar',
  q: '',
  type: 'all',
  dupOnly: false,
  selected: null,
  openGroups: [],
  openChat: null,
  editing: null,
  busy: false,
  syncMsg: '',
  page: 'main',
};

try {
  const p = JSON.parse(localStorage.getItem(PREF_KEY) || '{}');
  if (['groups', 'all', 'view'].includes(p.tab)) st.tab = p.tab;
  if (typeof p.lens === 'string') st.lens = p.lens;
  if (Array.isArray(p.openGroups)) st.openGroups = p.openGroups.filter((x) => typeof x === 'string').slice(0, 500);
} catch {
  /* 保存した表示設定が読めなければ、初期値のまま */
}
const savePrefs = () => {
  try {
    localStorage.setItem(PREF_KEY, JSON.stringify({ tab: st.tab, lens: st.lens, openGroups: st.openGroups }));
  } catch {
    /* 保存できなくても動作には影響しない */
  }
};

async function run(fn) {
  if (st.busy) return;
  st.busy = true;
  render();
  try {
    await fn();
  } catch (e) {
    toast(e.message, true);
  } finally {
    st.busy = false;
    render();
  }
}

// ---- データ ---------------------------------------------------------------
function setRaw(raw) {
  st.raw = raw;
  st.data = raw ? analyze(raw) : null;
}

async function applyChats(raw) {
  await dbSet('chats', raw);
  setRaw(raw);
}

// グループ設定を保存する(この端末に保存し、PCでフォルダに接続していれば、OneDriveのファイルにも書く)
async function persistGroups() {
  await dbSet('groups', st.groups);
  const f = st.folder;
  if (!f.handle) {
    st.syncMsg = '';
    return;
  }
  if (!f.granted) {
    st.syncMsg = 'フォルダには未保存(「フォルダを再接続」を押してください)';
    return;
  }
  try {
    await sync.writeText(f.handle, sync.GROUPS_FILE, JSON.stringify(st.groups, null, 2));
    st.syncMsg = `フォルダに保存済み ${fmtDate(st.groups.updatedAt)}`;
  } catch (e) {
    st.syncMsg = 'フォルダへの保存に失敗しました';
    toast(`フォルダへの保存に失敗しました。\n${e.message}`, true);
  }
}

async function saveGroups() {
  G.touch(st.groups);
  await persistGroups();
  renderHeader();
  renderList();
  renderDetail();
}

// PCのフォルダから、最新の chats.json と groups.json を読み込む(interactive=true のときだけ、許可を求める)
async function loadFromFolder(interactive) {
  const f = st.folder;
  if (!f.handle) return false;
  f.granted = interactive ? await sync.requestPermission(f.handle) : await sync.hasPermission(f.handle);
  if (!f.granted) return false;
  let message = '';
  const chatsText = await sync.readText(f.handle, sync.CHATS_FILE);
  if (chatsText) {
    const remote = parseImport(chatsText);
    if (!st.raw || st.raw.source === 'sample' || (remote.fetchedAt || '') > (st.raw.fetchedAt || '')) {
      await applyChats(remote);
      message = `${remote.chats.length}件のチャットを読み込みました。`;
    }
  }
  const groupsText = await sync.readText(f.handle, sync.GROUPS_FILE);
  if (groupsText) {
    const remote = G.parseGroups(groupsText);
    const remoteAt = remote.updatedAt || '';
    const localAt = st.groups.updatedAt || '';
    if (remoteAt > localAt) {
      st.groups = remote; // フォルダの設定の方が新しい(スマホから戻した設定など)
      await dbSet('groups', remote);
      message ||= 'グループ設定を読み込みました。';
    } else if (localAt > remoteAt) {
      await persistGroups(); // この端末の設定の方が新しいので、フォルダのファイルを更新する
    }
  } else if (st.groups.nodes.length) {
    await persistGroups();
  }
  st.syncMsg = `フォルダと同期済み ${fmtDate(new Date().toISOString())}`;
  return message || true;
}

const doConnectFolder = () =>
  run(async () => {
    let handle;
    try {
      handle = await sync.connectFolder();
    } catch (e) {
      if (e && e.name === 'AbortError') return; // 選ぶのをやめた
      throw e;
    }
    st.folder = { handle, granted: true };
    const r = await loadFromFolder(true);
    if (typeof r === 'string') toast(r);
    else if (!st.raw) toast('このフォルダには chats.json がまだありません。取得ツールを実行してください。', true);
  });

const doSyncFolder = () =>
  run(async () => {
    const r = await loadFromFolder(true);
    if (r === false) throw new Error('フォルダへのアクセスが許可されませんでした。');
    toast(typeof r === 'string' ? r : '最新の状態です。');
  });

// スマホ用:ファイルを選んで読み込む(chats.json と groups.json を、同時に選んでもよい)
function pickFiles() {
  const input = h('input', { type: 'file', accept: '.json,application/json', multiple: 'multiple' });
  input.addEventListener('change', () => {
    const files = [...(input.files || [])];
    if (!files.length) return;
    run(async () => {
      const done = [];
      for (const file of files) {
        if (file.size > 50 * 1024 * 1024) throw new Error(`${file.name} は大きすぎます。`);
        const text = await file.text();
        let obj;
        try {
          obj = JSON.parse(text);
        } catch {
          throw new Error(`${file.name} は、JSONとして読めません。`);
        }
        if (obj && Array.isArray(obj.chats)) {
          const raw = parseImport(text);
          await applyChats(raw);
          done.push(`チャット${raw.chats.length}件`);
        } else if (obj && Array.isArray(obj.nodes)) {
          const doc = G.parseGroups(text);
          if (st.groups.nodes.length && (st.groups.updatedAt || '') > (doc.updatedAt || '') && !confirm('この端末のグループ設定の方が新しいようです。読み込んだ設定で置き換えますか?')) continue;
          st.groups = doc;
          await dbSet('groups', doc);
          done.push(`グループ${doc.nodes.length}個`);
        } else {
          throw new Error(`${file.name} は、チャット一覧でもグループ設定でもありません。`);
        }
      }
      if (done.length) toast(`${done.join('、')}を読み込みました。`);
    });
  });
  input.click();
}

const exportGroups = () => sync.downloadText('groups.json', JSON.stringify(st.groups, null, 2));

const doDemo = () =>
  run(async () => {
    await applyChats(buildSample());
    if (!st.groups.nodes.length) {
      st.groups = sampleGroups();
      await dbSet('groups', st.groups);
    }
  });

const isDemoGroups = () => st.groups.nodes.length > 0 && st.groups.nodes.every((n) => n.id.startsWith('g-demo'));

const doClear = () =>
  run(async () => {
    await dbDelete('chats');
    setRaw(null);
    st.selected = null;
    st.openChat = null;
    if (isDemoGroups()) {
      st.groups = G.emptyDoc();
      await dbDelete('groups');
    }
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

const searchSet = () => (st.q.trim() ? new Set(visibleChats(true).map((c) => c.id)) : null);

// ---- 描画:チャット1件の行と詳細 -------------------------------------------
function chatRow(c, extra, onclick = () => select(c.id), opened = false) {
  const n = st.notes[c.id] || {};
  const names = c.members.filter((m) => !m.isMe).map((m) => m.name).join('、');
  return h(
    'div',
    { class: `row${opened || st.selected === c.id ? ' sel' : ''}`, onclick },
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

// チャットの詳細(右の詳細欄と、グループの中での展開表示で共通)
function chatDetail(c, openOther = select) {
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
  return [
    h('div', { class: 'kv' }, `${typeLabel(c.type)} / ${c.members.length}人 / 最終更新 ${fmtDate(c.updatedAt) || '不明'} / 作成 ${fmtDate(c.createdAt) || '不明'}`),
    c.webUrl && c.webUrl.startsWith('https://') ? h('p', {}, h('a', { class: 'btn primary', href: c.webUrl, target: '_blank', rel: 'noopener' }, 'Teams で開く')) : null,
    h('h4', {}, 'メンバー'),
    h('div', { class: 'members' }, c.members.map((m) => h('span', { class: `member${m.isMe ? ' me' : ''}`, title: m.email || '' }, m.isMe ? `${m.name}(自分)` : m.name))),
    assignmentPanel(c, app),
    block(c.identical, 'メンバーが全く同じチャット', (id) => {
      const o = byId.get(id);
      return h('div', { class: 'sim', onclick: (e) => (e.stopPropagation(), openOther(id)) }, h('div', {}, o.displayName), h('div', { class: 'kv' }, `最終更新 ${fmtDate(o.updatedAt)}`));
    }),
    block(c.similar, 'メンバーが少し違うチャット', (s) => {
      const o = byId.get(s.id);
      return h(
        'div',
        { class: 'sim', onclick: (e) => (e.stopPropagation(), openOther(s.id)) },
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
}

const app = { st, save: saveGroups, savePrefs, rerenderList: () => renderList(), chatRow, chatDetail: (c) => chatDetail(c, (id) => ((st.openChat = id), renderList())), searchSet };

function renderList() {
  const box = document.getElementById('list');
  if (!box) return;
  box.replaceChildren();
  if (st.tab === 'groups') {
    box.append(groupsTab(app));
    return;
  }
  if (st.tab === 'all') {
    const list = visibleChats();
    if (!list.length) box.append(h('p', { class: 'kv' }, '該当するチャットはありません。'));
    list.forEach((c) => box.append(chatRow(c)));
    return;
  }
  const byId = new Map(st.data.chats.map((c) => [c.id, c]));
  const matched = new Set(visibleChats(true).map((c) => c.id));
  const { groups, emptyText } = lensById(st.lens).run(st.data, { notes: st.notes });
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
  const c = st.data && st.tab !== 'groups' && st.data.chats.find((x) => x.id === st.selected);
  if (!c) {
    box.hidden = true;
    return;
  }
  box.replaceChildren(h('button', { class: 'close', onclick: () => ((st.selected = null), renderDetail(), renderList()) }, '✕'), h('h2', {}, c.displayName), ...chatDetail(c).flat().filter(Boolean));
  box.hidden = false;
}

// ---- 描画:各画面 ---------------------------------------------------------
function renderEmpty(main) {
  const pc = sync.folderSupported;
  main.append(
    h(
      'div',
      { class: 'empty' },
      h('h2', {}, 'Teams のチャットを取り込みましょう'),
      h('ol', {}, h('li', {}, 'PCで取得ツールを実行し、チャット一覧のファイル(chats.json)を作る'), pc ? h('li', {}, '下の「OneDriveのフォルダを選ぶ」で、大学のOneDriveの「Teams整理」フォルダを選ぶ(次回からは自動で読み込みます)') : h('li', {}, '下の「ファイルを選ぶ」で、そのファイルを選ぶ(スマホには、OneDriveアプリで一度ダウンロードしておく)'), h('li', {}, '整理した結果が表示されます')),
      h('div', { class: 'btns' }, pc ? h('button', { class: 'primary', onclick: doConnectFolder, disabled: st.busy }, 'OneDriveのフォルダを選ぶ') : null, h('button', { class: pc ? '' : 'primary', onclick: pickFiles, disabled: st.busy }, 'ファイルを選ぶ'), h('button', { onclick: doDemo }, 'デモデータで画面を試す')),
      h('p', { class: 'small' }, '読み取り専用です。このアプリはインターネットにデータを送りません。読み込んだデータは、この端末のブラウザの中だけに保存されます。')
    )
  );
}

function renderSettings(main) {
  const f = st.folder;
  main.append(
    h(
      'div',
      { class: 'panel' },
      h('h2', {}, 'データの管理'),
      h('p', { class: 'kv' }, '読み込んだチャットとグループ設定は、この端末のブラウザの中だけに保存されています。共有の端末では、使い終わったら消してください。'),
      sync.folderSupported
        ? [
            h('h4', {}, 'OneDriveのフォルダとの連携(PC)'),
            h('p', { class: 'kv' }, f.handle ? `接続中(${f.handle.name})。${f.granted ? '' : '許可が必要です。'}${st.syncMsg}` : '未接続。「Teams整理」フォルダを選ぶと、chats.json とグループ設定(groups.json)を、自動で読み書きします。'),
            h('div', { class: 'btns left' }, h('button', { class: 'primary', onclick: f.handle ? doSyncFolder : doConnectFolder }, f.handle ? 'フォルダから更新' : 'OneDriveのフォルダを選ぶ'), f.handle ? h('button', { onclick: doConnectFolder }, '別のフォルダを選ぶ') : null, f.handle ? h('button', { onclick: () => run(async () => (await sync.forgetFolder(), (st.folder = { handle: null, granted: false }), (st.syncMsg = ''))) }, '接続を解除') : null),
          ]
        : h('p', { class: 'kv' }, 'この端末のブラウザは、フォルダとの直接連携に対応していません。ファイルを選んで読み込みます。'),
      h('h4', {}, 'ファイルで受け渡す(スマホ・フォルダ連携なしの場合)'),
      h('p', { class: 'kv' }, 'chats.json と groups.json は、同時に選べます。スマホで編集したグループ設定をPCへ戻すには、「グループ設定を書き出す」で groups.json を保存し、OneDriveの「Teams整理」フォルダにアップロードしてください(同名のファイルを上書き)。'),
      h('div', { class: 'btns left' }, h('button', { class: 'primary', onclick: pickFiles }, 'ファイルを読み込む'), h('button', { onclick: exportGroups }, 'グループ設定を書き出す')),
      h('h4', {}, '消す'),
      h('div', { class: 'btns left' }, h('button', { onclick: () => (doClear(), (st.page = 'main')) }, '読み込んだチャットを消す'), h('button', { class: 'danger', onclick: () => confirm('グループ設定をすべて削除しますか?(フォルダ接続中は、フォルダのファイルも次回の保存で置き換わります)') && run(async () => ((st.groups = G.touch(G.emptyDoc())), await persistGroups())) }, 'グループ設定を消す')),
      h('div', { class: 'btns left' }, h('button', { onclick: () => ((st.page = 'main'), render()) }, '戻る'))
    )
  );
}

function renderCards(main) {
  const c = st.data.counts;
  const card = (num, lbl, hl) => h('div', { class: `card${hl ? ' hl' : ''}` }, h('div', { class: 'num' }, String(num)), h('div', { class: 'lbl' }, lbl));
  main.append(h('div', { class: 'cards' }, card(c.total, 'チャットの合計'), card(c.group, 'グループチャット'), card(c.oneOnOne, '1対1'), card(c.meeting, '会議チャット'), card(c.clusters, `似たチャットのまとまり(${c.chatsInClusters}件)`, c.clusters > 0), card(c.identicalSets, '同じメンバーが複数ある組', c.identicalSets > 0)));
}

function renderTools(main) {
  const chip = (label, on, fn) => h('button', { class: `chip${on ? ' on' : ''}`, onclick: fn }, label);
  const search = h('input', { type: 'search', placeholder: '検索(名前・メンバー・メモ。空白で複数条件)', value: st.q });
  search.addEventListener('input', () => {
    st.q = search.value;
    renderList();
  });
  const tab = (id, label) => h('button', { class: `tab${st.tab === id ? ' on' : ''}`, onclick: () => ((st.tab = id), (st.editing = null), savePrefs(), render()) }, label);
  main.append(h('div', { class: 'tabs' }, tab('groups', 'グループ'), tab('all', `すべて(${st.data.counts.total})`), tab('view', '整理して見る')));
  const tools = h('div', { class: 'tools' }, search);
  if (st.tab === 'all') {
    tools.append(h('div', { class: 'chips' }, chip('すべて', st.type === 'all', () => ((st.type = 'all'), render())), chip('グループ', st.type === 'group', () => ((st.type = 'group'), render())), chip('1対1', st.type === 'oneOnOne', () => ((st.type = 'oneOnOne'), render())), chip('会議', st.type === 'meeting', () => ((st.type = 'meeting'), render())), chip('似ている・同じメンバーのみ', st.dupOnly, () => ((st.dupOnly = !st.dupOnly), render()))));
  } else if (st.tab === 'view') {
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
  const parts = [];
  if (st.raw) parts.push(`${st.raw.source === 'sample' ? '【デモデータ】' : ''}取得: ${fmtDate(st.raw.fetchedAt)}`);
  if (st.syncMsg) parts.push(st.syncMsg);
  status.textContent = parts.join(' / ');
  actions.replaceChildren();
  if (st.raw && st.raw.source !== 'sample') {
    if (sync.folderSupported && st.folder.handle) actions.append(h('button', { class: 'primary', onclick: doSyncFolder, disabled: st.busy }, st.busy ? '更新中…' : st.folder.granted ? 'フォルダから更新' : 'フォルダを再接続'));
    else if (sync.folderSupported) actions.append(h('button', { class: 'primary', onclick: doConnectFolder, disabled: st.busy }, 'OneDriveのフォルダを選ぶ'));
    else actions.append(h('button', { class: 'primary', onclick: pickFiles, disabled: st.busy }, st.busy ? '読み込み中…' : '最新のファイルを読み込む'));
  }
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
async function autoRefresh() {
  if (st.busy || !st.folder.handle || st.editing) return;
  try {
    const r = await loadFromFolder(false);
    if (typeof r === 'string') {
      toast(r);
      render();
    } else if (r === true) renderHeader();
  } catch {
    /* 自動更新の失敗は、画面に出さない(手動の「フォルダから更新」で原因が表示される) */
  }
}

(async function init() {
  if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('./sw.js').catch(() => {});
  try {
    setRaw(await dbGet('chats', null));
    st.notes = await dbGet('notes', {});
    const saved = await dbGet('groups', null);
    if (saved) st.groups = G.sanitizeDoc(saved);
    if (sync.folderSupported) {
      const handle = await sync.savedFolder();
      if (handle) st.folder = { handle, granted: await sync.hasPermission(handle) };
    }
  } catch (e) {
    toast(e.message, true);
  }
  render();
  await autoRefresh();
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && autoRefresh());
})();
