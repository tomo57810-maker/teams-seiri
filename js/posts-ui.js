// 「投稿の記録」タブの画面。Teamsの投稿のリンクと文章を貼り付けて記録し、チャットのグループごとに一覧にする。
// app = { st, savePosts(), rerenderList(), exportExcel() }
import { h, toast, fmtDate } from './util.js';
import * as G from './groups.js';
import * as P from './posts.js';

// 日本時間の「日時の入力欄」用の文字(YYYY-MM-DDTHH:mm)と、保存用の日時(ISO)を、相互に変える
const jstLocal = (iso) => (iso ? new Date(Date.parse(iso) + 9 * 3600e3).toISOString().slice(0, 16) : '');
const fromJstLocal = (s) => (s ? new Date(Date.parse(`${s}:00Z`) - 9 * 3600e3).toISOString() : null);

export function postsTab(app) {
  const { st } = app;
  const wrap = h('div', { class: 'posts' });
  wrap.append(
    h(
      'div',
      { class: 'gbar' },
      h('button', { class: 'primary', onclick: () => openForm(app, null) }, '＋ 投稿を記録'),
      h('button', { onclick: () => app.exportExcel(), disabled: st.posts.items.length ? false : '' }, 'Excelに書き出す'),
      h('span', { class: 'kv' }, `${st.posts.items.length}件を記録済み`)
    )
  );
  if (st.postForm) wrap.append(formPanel(app));
  if (!st.posts.items.length && !st.postForm) {
    wrap.append(h('div', { class: 'empty' }, h('h2', {}, '投稿を記録しましょう'), h('p', {}, 'Teamsで、記録したい投稿の「…」→「リンクをコピー」を押し、「＋ 投稿を記録」に貼り付けます。投稿の文章もコピーして貼ると、投稿者・日時・内容を自動で読み取ります。'), h('p', { class: 'kv' }, 'リンクから、チャットのグループが自動で決まり、グループごとに整理されます。')));
  }

  const q = st.q.trim().toLowerCase();
  const matches = (p, path) => !q || q.split(/\s+/).every((w) => [p.from, p.text, p.note, p.status, path, ...p.files.map((f) => f.name)].join('\n').toLowerCase().includes(w));
  const sheets = P.organize(st.posts, st.data, st.groups)
    .map((s) => ({ ...s, items: s.items.filter((x) => matches(x.post, x.path)) }))
    .filter((s) => s.items.length);
  for (const s of sheets) {
    wrap.append(
      h(
        'div',
        { class: 'cluster' },
        h('h3', {}, `${s.name}(${s.items.length}件)`),
        s.items.map((x) => postCard(x, app))
      )
    );
  }
  if (q && !sheets.length && st.posts.items.length) wrap.append(h('p', { class: 'kv' }, '該当する記録はありません。'));
  return wrap;
}

function postCard({ post: p, path }, app) {
  const { st } = app;
  return h(
    'div',
    { class: 'post' },
    h('div', { class: 'phead' }, h('span', { class: 'pdate' }, fmtDate(p.at) || '日時不明'), h('strong', {}, p.from || '(投稿者不明)'), p.status ? h('span', { class: 'badge warn' }, p.status) : null, h('span', { class: 'badge gray' }, path)),
    p.text ? h('div', { class: 'ptext' }, p.text) : null,
    p.note ? h('div', { class: 'kv' }, `備考: ${p.note}`) : null,
    p.files.length ? h('div', { class: 'mfiles' }, p.files.map((f) => h('a', { href: f.url, target: '_blank', rel: 'noopener noreferrer' }, `📎 ${f.name}`))) : null,
    h(
      'div',
      { class: 'pbtns' },
      p.link ? h('a', { class: 'btn', href: p.link, target: '_blank', rel: 'noopener noreferrer' }, 'Teamsで開く') : null,
      h('button', { onclick: () => openForm(app, p) }, '編集'),
      h(
        'button',
        {
          class: 'danger',
          onclick: () => {
            if (!confirm('この記録を削除しますか?(Teamsの投稿は消えません)')) return;
            st.posts.items = st.posts.items.filter((x) => x.id !== p.id);
            app.savePosts();
          },
        },
        '削除'
      )
    )
  );
}

function openForm(app, post) {
  const { st } = app;
  st.postForm = post
    ? { id: post.id, link: post.link || '', paste: '', at: post.at, atFromLink: false, from: post.from, text: post.text, status: post.status, note: post.note, files: post.files.map((f) => ({ ...f })), groupId: post.groupId || '', chatId: post.chatId }
    : { id: null, link: '', paste: '', at: null, atFromLink: false, from: '', text: '', status: '', note: '', files: [], groupId: '', chatId: null };
  app.rerenderList();
  const el = document.getElementById('pform');
  if (el) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function formPanel(app) {
  const { st } = app;
  const d = st.postForm;
  const box = h('div', { class: 'panel geditor', id: 'pform' });

  // 入力欄(値を直接書き換えるので、入力中に画面を作り直さない)
  const link = h('input', { type: 'text', value: d.link, placeholder: 'Teamsの投稿のリンク(投稿の「…」→「リンクをコピー」)', autocomplete: 'off', spellcheck: 'false' });
  const paste = h('textarea', { placeholder: '投稿の文章を貼り付け(Teamsで、投稿者名から本文までを選んでコピー)。投稿者・日時・内容を自動で読み取ります。' });
  const at = h('input', { type: 'datetime-local', value: jstLocal(d.at) });
  const from = h('input', { type: 'text', value: d.from, placeholder: '例:米満補佐' });
  const text = h('textarea', { placeholder: '投稿の内容(自分で要約してもよい)' });
  text.value = d.text;
  const status = h('input', { type: 'text', value: d.status, placeholder: '例:要望中', list: 'pstatus-list' });
  const note = h('input', { type: 'text', value: d.note, placeholder: '備考' });
  const info = h('div', { class: 'kv' });

  const nodes = [...st.groups.nodes].sort((a, b) => G.pathLabel(st.groups, a.id).localeCompare(G.pathLabel(st.groups, b.id), 'ja'));
  const group = h('select', {}, h('option', { value: '' }, '自動(リンクのチャットから決める)'), nodes.map((n) => h('option', { value: n.id }, G.pathLabel(st.groups, n.id))));
  group.value = d.groupId;

  const updateInfo = () => {
    const g = P.groupOf({ chatId: d.chatId, groupId: d.groupId || null }, st.data, st.groups);
    const chat = d.chatId && st.data.chats.find((c) => c.id === d.chatId);
    let msg;
    if (d.groupId) msg = `入るグループ:${g.path}(手動で選択)`;
    else if (chat) msg = `チャット「${chat.displayName}」→ 入るグループ:${g.path}`;
    else if (d.link) msg = d.chatId ? 'このチャットは、取得済みの一覧にありません(取得ツールで最新にするか、下でグループを選んでください)。入るグループ:未分類' : 'リンクからチャットを特定できません(チャンネルの投稿など)。下でグループを選べます。入るグループ:未分類';
    else msg = '入るグループ:未分類(リンクを貼るか、下でグループを選んでください)';
    info.textContent = msg;
  };

  link.addEventListener('input', () => {
    d.link = link.value.trim();
    const t = P.parseTeamsLink(d.link);
    d.chatId = t ? t.chatId : null;
    if (t && t.ts) {
      d.at = new Date(t.ts).toISOString(); // 投稿時刻は、リンクの中の値が一番正確
      d.atFromLink = true;
      at.value = jstLocal(d.at);
    } else {
      d.atFromLink = false;
    }
    updateInfo();
  });
  paste.addEventListener('input', () => {
    const r = P.parsePasted(paste.value);
    if (r.from) {
      d.from = r.from;
      from.value = r.from;
    }
    if (r.at && !d.atFromLink) {
      d.at = r.at;
      at.value = jstLocal(r.at);
    }
    d.text = r.body;
    text.value = r.body;
  });
  at.addEventListener('input', () => ((d.at = fromJstLocal(at.value)), (d.atFromLink = false)));
  from.addEventListener('input', () => (d.from = from.value));
  text.addEventListener('input', () => (d.text = text.value));
  status.addEventListener('input', () => (d.status = status.value));
  note.addEventListener('input', () => (d.note = note.value));
  group.addEventListener('change', () => ((d.groupId = group.value), updateInfo()));

  // 添付ファイル
  const filesBox = h('div', { class: 'ffiles' });
  const renderFiles = () => {
    filesBox.replaceChildren(
      ...d.files.map((f, i) => {
        const n = h('input', { type: 'text', value: f.name, placeholder: 'ファイル名' });
        const u = h('input', { type: 'text', value: f.url, placeholder: 'ファイルのリンク(https://…)', spellcheck: 'false' });
        n.addEventListener('input', () => (f.name = n.value));
        u.addEventListener('input', () => (f.url = u.value));
        return h('div', { class: 'frow' }, n, u, h('button', { class: 'mini', onclick: () => (d.files.splice(i, 1), renderFiles()) }, '削除'));
      })
    );
  };

  const save = () => {
    const lk = d.link.trim();
    if (lk && !/^https:\/\//.test(lk)) return toast('リンクは https:// で始まるものを入力してください。', true);
    const files = d.files.filter((f) => f.url.trim() || f.name.trim()).map((f) => ({ name: f.name.trim(), url: f.url.trim() }));
    if (files.some((f) => !/^https:\/\//.test(f.url))) return toast('添付ファイルのリンクは、https:// で始まるものを入力してください。', true);
    if (!d.text.trim() && !lk) return toast('内容かリンクを入力してください。', true);
    const item = P.sanitizePosts({ items: [{ id: d.id || P.newPostId(), at: d.at, from: d.from.trim(), text: d.text.trim(), status: d.status.trim(), note: d.note.trim(), link: lk || null, chatId: d.chatId, groupId: d.groupId || null, files }] }).items[0];
    const i = st.posts.items.findIndex((x) => x.id === item.id);
    if (i >= 0) st.posts.items[i] = item;
    else st.posts.items.push(item);
    st.postForm = null;
    app.savePosts();
    toast('記録しました。');
  };

  box.append(
    h('h3', {}, d.id ? '記録を編集' : '投稿を記録'),
    h('h4', {}, 'Teamsの投稿のリンク'),
    link,
    h('h4', {}, '投稿の文章を貼り付け(任意)'),
    paste,
    h('div', { class: 'grid2' }, h('div', {}, h('h4', {}, '投稿日時(日本時間)'), at), h('div', {}, h('h4', {}, '投稿者'), from)),
    h('h4', {}, '内容'),
    text,
    h('div', { class: 'grid2' }, h('div', {}, h('h4', {}, '状態'), status), h('div', {}, h('h4', {}, '備考'), note)),
    h('datalist', { id: 'pstatus-list' }, ['要望中', '確認中', '対応中', '対応済み', '参考'].map((s) => h('option', { value: s }))),
    h('h4', {}, '添付ファイル(任意)'),
    h('p', { class: 'kv' }, 'Teamsで添付ファイルの「…」→「リンクをコピー」で得たリンクを貼ります。'),
    filesBox,
    h('div', { class: 'btns left' }, h('button', { onclick: () => (d.files.push({ name: '', url: '' }), renderFiles()) }, '＋ 添付ファイルを追加')),
    h('h4', {}, 'グループ'),
    group,
    info,
    h('div', { class: 'btns left' }, h('button', { class: 'primary', onclick: save }, d.id ? '保存' : '記録する'), h('button', { onclick: () => ((st.postForm = null), app.rerenderList()) }, 'キャンセル'))
  );
  renderFiles();
  updateInfo();
  return box;
}
