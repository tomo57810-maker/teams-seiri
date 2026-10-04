// 画面で共通に使う小さな部品。
const TYPE_LABEL = { group: 'グループ', oneOnOne: '1対1', meeting: '会議' };
export const typeLabel = (t) => TYPE_LABEL[t] || 'その他';

// DOMを作る。文字は必ず textNode にする(チャット名などに含まれる記号が、HTMLとして解釈されないようにする)
export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === false || v == null) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'text') el.textContent = v;
    else if (k === 'value') el.value = v;
    else if (k === 'checked') el.checked = !!v;
    else el.setAttribute(k, v);
  }
  for (const c of children.flat(Infinity)) if (c != null && c !== false) el.append(c.nodeType ? c : document.createTextNode(c));
  return el;
}

let toastTimer;
export function toast(msg, isErr = false) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.className = isErr ? 'toast err' : 'toast';
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), isErr ? 15000 : 3500);
}

export function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const opt = { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' };
  if (d.getFullYear() !== new Date().getFullYear()) opt.year = 'numeric';
  return d.toLocaleString('ja-JP', opt);
}
