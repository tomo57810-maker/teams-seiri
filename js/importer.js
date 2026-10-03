// 取得ツールが書き出した chats.json を読み込んで、形を確かめる。
// 読み込んだファイルは信用しない:必要な項目だけを取り出し、文字列に直す(画面には textContent で出す)。

const str = (v, max = 500) => (typeof v === 'string' ? v.slice(0, max) : null);

export function parseImport(text) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new Error('ファイルの形式が正しくありません(JSONとして読めません)。');
  }
  if (!raw || !Array.isArray(raw.chats)) throw new Error('チャット一覧のファイルではありません(chats がありません)。');
  if (raw.chats.length > 20000) throw new Error('チャットの件数が多すぎます。');

  const chats = raw.chats.map((c, i) => {
    if (!c || typeof c.id !== 'string' || !Array.isArray(c.members)) throw new Error(`${i + 1}件目のチャットの形式が正しくありません。`);
    return {
      id: c.id,
      type: str(c.type, 40) || 'other',
      topic: str(c.topic, 300),
      createdAt: str(c.createdAt, 40),
      updatedAt: str(c.updatedAt, 40),
      webUrl: str(c.webUrl, 2000),
      hidden: !!c.hidden,
      lastMessage: null,
      members: c.members.filter((m) => m && typeof m.id === 'string').map((m) => ({ id: m.id, name: str(m.name, 200) || '(名前なし)', email: str(m.email, 200) })),
    };
  });
  const me = raw.me && typeof raw.me.id === 'string' ? { id: raw.me.id, name: str(raw.me.name, 200), email: str(raw.me.email, 200) } : null;
  return { source: raw.source === 'sample' ? 'sample' : 'graph', fetchedAt: str(raw.fetchedAt, 40) || new Date().toISOString(), me, chats };
}
