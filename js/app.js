import { analyze } from './analyze.js';
import { buildSample, sampleGroups, samplePosts } from './sample.js';
import { lenses, lensById } from './lenses.js';
import { dbGet, dbSet, dbDelete } from './db.js';
import { parseImport } from './importer.js';
import * as G from './groups.js';
import * as sync from './sync.js';
import { groupsTab, assignmentPanel } from './groups-ui.js';
import * as P from './posts.js';
import { postsTab } from './posts-ui.js';
import { buildXlsx } from './xlsx.js';
import { h, toast, fmtDate, typeLabel } from './util.js';

const PREF_KEY = 'teams-seiri:prefs';

const st = {
  raw: null,
  data: null,
  notes: {},
  groups: G.emptyDoc(),
  posts: P.emptyPosts(),
  postForm: null,
  folder: { handle: null, granted: false },
  view: 'groups', // 'groups' | 'all' | 'lens:<整理の仕方のid>'
  editMode: false,
  q: '',
  type: 'all',
  dupOnly: false,
  selected: null,
  openGroups: [],
  openChat: null,
  openFiles: [],
  msgMore: new Set(), // 「もっと前の投稿」を開いているチャット
  editing: null,
  busy: false,
  syncMsg: '',
  page: 'main',
};

try {
  const p = JSON.parse(localStorage.getItem(PREF_KEY) || '{}');
  if (typeof p.view === 'string') st.view = p.view;
  else if (p.tab === 'all') st.view = 'all';
  else if (p.tab === 'view' && typeof p.lens === 'string') st.view = `lens:${p.lens}`;
  if (Array.isArray(p.openGroups)) st.openGroups = p.openGroups.filter((x) => typeof x === 'string').slice(0, 500);
} catch {
  /* 保存した表示設定が読めなければ、初期値のまま */
}
const savePrefs = () => {
  try {
    localStorage.setItem(PREF_KEY, JSON.stringify({ view: st.view, openGroups: st.openGroups }));
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

// 設定や記録を保存する(この端末に保存し、PCでフォルダに接続していれば、OneDriveのファイルにも書く)
async function persistDoc(key, file, doc) {
  await dbSet(key, doc);
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
    await sync.writeText(f.handle, file, JSON.stringify(doc, null, 2));
    st.syncMsg = `フォルダに保存済み ${fmtDate(doc.updatedAt)}`;
  } catch (e) {
    st.syncMsg = 'フォルダへの保存に失敗しました';
    toast(`フォルダへの保存に失敗しました。\n${e.message}`, true);
  }
}
const persistGroups = () => persistDoc('groups', sync.GROUPS_FILE, st.groups);
const persistPosts = () => persistDoc('posts', sync.POSTS_FILE, st.posts);

async function saveGroups() {
  G.touch(st.groups);
  await persistGroups();
  renderHeader();
  renderList();
  renderDetail();
}

async function savePosts() {
  P.touchPosts(st.posts);
  await persistPosts();
  renderHeader();
  renderList();
}

// PCのフォルダから、最新の chats.json・groups.json・posts.json を読み込む(interactive=true のときだけ、許可を求める)
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
  const postsText = await sync.readText(f.handle, sync.POSTS_FILE);
  if (postsText) {
    const remote = P.parsePostsFile(postsText);
    const remoteAt = remote.updatedAt || '';
    const localAt = st.posts.updatedAt || '';
    if (remoteAt > localAt) {
      st.posts = remote;
      await dbSet('posts', remote);
      message ||= '投稿の記録を読み込みました。';
    } else if (localAt > remoteAt) {
      await persistPosts();
    }
  } else if (st.posts.items.length) {
    await persistPosts();
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

// スマホ用:ファイルを選んで読み込む(chats.json・groups.json・posts.json を、同時に選んでもよい)
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
        } else if (obj && Array.isArray(obj.items)) {
          const doc = P.parsePostsFile(text);
          if (st.posts.items.length && (st.posts.updatedAt || '') > (doc.updatedAt || '') && !confirm('この端末の投稿の記録の方が新しいようです。読み込んだ記録で置き換えますか?')) continue;
          st.posts = doc;
          await dbSet('posts', doc);
          done.push(`投稿の記録${doc.items.length}件`);
        } else {
          throw new Error(`${file.name} は、チャット一覧・グループ設定・投稿の記録のどれでもありません。`);
        }
      }
      if (done.length) toast(`${done.join('、')}を読み込みました。`);
    });
  });
  input.click();
}

const exportGroups = () => sync.downloadText('groups.json', JSON.stringify(st.groups, null, 2));
const exportPosts = () => sync.downloadText('posts.json', JSON.stringify(st.posts, null, 2));

// 投稿の記録を、最上位のグループごとのシートに整理して、Excelに書き出す
const exportExcel = () => {
  const bytes = buildXlsx(P.toExcelSheets(P.organize(st.posts, st.data, st.groups)));
  const day = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10).replace(/-/g, '');
  sync.downloadBytes(`Teams投稿の記録_${day}.xlsx`, bytes, 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  toast('Excelを書き出しました。ダウンロードのフォルダを確認してください。');
};

const doDemo = () =>
  run(async () => {
    await applyChats(buildSample());
    if (!st.groups.nodes.length) {
      st.groups = sampleGroups();
      await dbSet('groups', st.groups);
    }
    if (!st.posts.items.length) {
      st.posts = samplePosts();
      await dbSet('posts', st.posts);
    }
  });

const isDemoGroups = () => st.groups.nodes.length > 0 && st.groups.nodes.every((n) => n.id.startsWith('g-demo'));

const doClear = () =>
  run(async () => {
    await dbDelete('chats');
    setRaw(null);
    st.selected = null;
    st.openChat = null;
    if (st.posts.items.length && st.posts.items.every((p) => p.id.startsWith('p-demo'))) {
      st.posts = P.emptyPosts();
      await dbDelete('posts');
    }
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
function chatRow(c, extra, onclick = () => select(c.id), opened = false, compact = false) {
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
      c.unread > 0 ? h('span', { class: 'ubadge', title: '未読の投稿' }, c.unreadCapped ? `${c.unread}+` : String(c.unread)) : null,
      h('span', { class: 'badge' }, `${c.members.length}人`),
      !compact && c.identical.length ? h('span', { class: 'badge dup' }, `同じメンバー ${c.identical.length}件`) : null,
      !compact && c.similar.length ? h('span', { class: 'badge warn' }, `似たチャット ${c.similar.length}件`) : null,
      !compact && c.hidden ? h('span', { class: 'badge gray' }, '非表示') : null,
      n.label ? h('span', { class: 'badge' }, `🏷 ${n.label}`) : null,
      h('span', { class: 'date' }, fmtDate(c.updatedAt))
    ),
    extra ? h('div', { class: 'extra' }, extra) : null,
    h('div', { class: 'meta' }, c.lastMessage && c.lastMessage.text ? `${c.lastMessage.from ? `${c.lastMessage.from}: ` : ''}${c.lastMessage.text.replace(/\s+/g, ' ')}` : c.topic ? `メンバー: ${names}` : n.memo || '')
  );
}

// 最近の投稿(チャットの内容)
function messagesBlock(c) {
  if (!st.raw || !st.raw.messagesEnabled) return []; // 投稿を取得していないデータでは、欄を出さない
  const meId = st.data.me && st.data.me.id;
  if (!c.messages.length) return [h('h4', {}, '最近の投稿'), h('div', { class: 'kv' }, '投稿はありません(または、まだ取得されていません)。')];
  const showN = st.msgMore.has(c.id) ? c.messages.length : Math.min(8, c.messages.length);
  const list = c.messages.slice(-showN);
  return [
    h('h4', {}, `最近の投稿(${list.length}/${c.messages.length}件)`),
    h(
      'div',
      { class: 'msgs' },
      list.map((m) => {
        const isNew = m.fromId !== meId && (!c.lastReadAt || m.at > c.lastReadAt);
        return h(
          'div',
          { class: `msg${m.fromId === meId ? ' mine' : ''}${isNew ? ' new' : ''}` },
          h('div', { class: 'mhead' }, h('strong', {}, m.from || '(不明)'), h('span', { class: 'kv' }, fmtDate(m.at)), isNew ? h('span', { class: 'ubadge small' }, '新') : null),
          h('div', { class: 'mtext' }, m.text || '(本文なし)'),
          m.attachments.length ? h('div', { class: 'mfiles' }, m.attachments.map((a) => h('a', { href: a.url, target: '_blank', rel: 'noopener noreferrer' }, `📎 ${a.name}`))) : null
        );
      })
    ),
    c.messages.length > showN ? h('button', { onclick: (e) => (e.stopPropagation(), st.msgMore.add(c.id), renderList()) }, 'もっと前の投稿を表示') : null,
  ];
}

function filesBlock(c) {
  if (!c.files.length) return [];
  return [h('h4', {}, `共有ファイル(${c.files.length}件)`), h('div', { class: 'files' }, c.files.map((f) => h('a', { href: f.url, target: '_blank', rel: 'noopener noreferrer' }, `📎 ${f.name}`, h('span', { class: 'kv' }, ` ${fmtDate(f.at)} ${f.from || ''}`))))];
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
    messagesBlock(c),
    filesBlock(c),
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

const app = { st, save: saveGroups, savePosts, exportExcel, savePrefs, rerenderList: () => renderList(), chatRow, chatDetail: (c) => chatDetail(c, (id) => ((st.openChat = id), renderList())), searchSet };

function renderList() {
  const box = document.getElementById('list');
  if (!box) return;
  box.replaceChildren();
  if (st.view === 'groups') {
    box.append(groupsTab(app));
    return;
  }
  if (st.view === 'posts') {
    box.append(postsTab(app));
    return;
  }
  if (st.view === 'all') {
    const list = visibleChats();
    if (!list.length) box.append(h('p', { class: 'kv' }, '該当するチャットはありません。'));
    list.forEach((c) => box.append(chatRow(c)));
    return;
  }
  const byId = new Map(st.data.chats.map((c) => [c.id, c]));
  const matched = new Set(visibleChats(true).map((c) => c.id));
  const { groups, emptyText } = lensById(st.view.replace(/^lens:/, '')).run(st.data, { notes: st.notes });
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
  const c = st.data && st.view !== 'groups' && st.data.chats.find((x) => x.id === st.selected);
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
      h('div', { class: 'btns left' }, h('button', { class: 'primary', onclick: pickFiles }, 'ファイルを読み込む'), h('button', { onclick: exportGroups }, 'グループ設定を書き出す'), h('button', { onclick: exportPosts }, '投稿の記録を書き出す')),
      h('h4', {}, '消す'),
      h('div', { class: 'btns left' }, h('button', { onclick: () => (doClear(), (st.page = 'main')) }, '読み込んだチャットを消す'), h('button', { class: 'danger', onclick: () => confirm('グループ設定をすべて削除しますか?(フォルダ接続中は、フォルダのファイルも次回の保存で置き換わります)') && run(async () => ((st.groups = G.touch(G.emptyDoc())), await persistGroups())) }, 'グループ設定を消す'), h('button', { class: 'danger', onclick: () => confirm('投稿の記録をすべて削除しますか?(フォルダ接続中は、フォルダのファイルも次回の保存で置き換わります)') && run(async () => ((st.posts = P.touchPosts(P.emptyPosts())), await persistPosts())) }, '投稿の記録を消す')),
      h('div', { class: 'btns left' }, h('button', { onclick: () => ((st.page = 'main'), render()) }, '戻る'))
    )
  );
}

const VIEWS = () => [
  { id: 'groups', name: 'グループ' },
  { id: 'posts', name: '投稿の記録' },
  { id: 'all', name: 'すべてのチャット' },
  ...lenses.map((l) => ({ id: `lens:${l.id}`, name: l.name })),
];

function renderTools(main) {
  const chip = (label, on, fn) => h('button', { class: `chip${on ? ' on' : ''}`, onclick: fn }, label);
  const search = h('input', { type: 'search', placeholder: '検索(名前・メンバー・メモ)', value: st.q });
  search.addEventListener('input', () => {
    st.q = search.value;
    renderList();
  });
  const views = VIEWS();
  if (!views.some((v) => v.id === st.view)) st.view = 'groups';
  const sel = h('select', { 'aria-label': '表示' }, views.map((v) => h('option', { value: v.id }, v.name)));
  sel.value = st.view;
  sel.addEventListener('change', () => {
    st.view = sel.value;
    st.editing = null;
    st.editMode = false;
    savePrefs();
    render();
  });
  const tools = h('div', { class: 'tools' }, search, sel);
  if (st.view === 'groups') tools.append(h('button', { class: st.editMode ? 'primary' : '', onclick: () => ((st.editMode = !st.editMode), (st.editing = null), render()) }, st.editMode ? '編集を終わる' : 'グループを編集'));
  main.append(tools);
  if (st.view === 'all') {
    main.append(h('div', { class: 'chips' }, chip('すべて', st.type === 'all', () => ((st.type = 'all'), render())), chip('グループ', st.type === 'group', () => ((st.type = 'group'), render())), chip('1対1', st.type === 'oneOnOne', () => ((st.type = 'oneOnOne'), render())), chip('会議', st.type === 'meeting', () => ((st.type = 'meeting'), render())), chip('似ている・同じメンバーのみ', st.dupOnly, () => ((st.dupOnly = !st.dupOnly), render()))));
  } else if (st.view.startsWith('lens:')) {
    main.append(h('p', { class: 'kv' }, lensById(st.view.slice(5)).description));
  }
}

function renderHeader() {
  const status = document.getElementById('status');
  const actions = document.getElementById('actions');
  const parts = [];
  if (st.raw) parts.push(`${st.raw.source === 'sample' ? '【デモデータ】' : ''}取得: ${fmtDate(st.raw.fetchedAt)}`);
  if (st.data && st.data.counts.unreadChats) parts.push(`未読のあるチャット ${st.data.counts.unreadChats}件`);
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
  renderTools(main);
  main.append(h('div', { class: 'list', id: 'list' }));
  if (st.view !== 'groups' && st.view !== 'all') main.append(h('p', { class: 'note' }, '「似たチャット」は、グループチャットのうち、メンバーの違いが2人以内で、自分以外の共通メンバーが2人以上いるものです。1対1と会議は対象外です。'));
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
    const savedPosts = await dbGet('posts', null);
    if (savedPosts) st.posts = P.sanitizePosts(savedPosts);
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
  setInterval(() => document.visibilityState === 'visible' && autoRefresh(), 60 * 1000);
})();
