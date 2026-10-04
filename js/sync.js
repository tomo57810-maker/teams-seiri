// PCのブラウザ(Chrome・Edge)で、OneDriveの「Teams整理」フォルダを直接読み書きする。
// 使うのは「File System Access API」。フォルダは利用者が自分で選んだものだけ、選んだ間だけ使える。
// スマホのブラウザは、この機能に対応していない(ファイルを選ぶ/書き出す方式になる)。
import { dbGet, dbSet, dbDelete } from './db.js';

export const folderSupported = typeof window !== 'undefined' && 'showDirectoryPicker' in window;

const KEY = 'dirHandle';
export const CHATS_FILE = 'chats.json';
export const GROUPS_FILE = 'groups.json';

// フォルダを選んでもらう(ボタンを押した直後に呼ぶ必要がある)
export async function connectFolder() {
  const handle = await window.showDirectoryPicker({ id: 'teams-seiri', mode: 'readwrite' });
  await dbSet(KEY, handle);
  return handle;
}

export const savedFolder = () => dbGet(KEY, null).catch(() => null);
export const forgetFolder = () => dbDelete(KEY);

// 読み書きの許可があるか(ボタンを押さなくても調べられる)
export async function hasPermission(handle) {
  try {
    return (await handle.queryPermission({ mode: 'readwrite' })) === 'granted';
  } catch {
    return false;
  }
}

// 許可を求める(ボタンを押した直後に呼ぶ必要がある)
export async function requestPermission(handle) {
  try {
    return (await handle.requestPermission({ mode: 'readwrite' })) === 'granted';
  } catch {
    return false;
  }
}

export async function readText(handle, name) {
  try {
    const file = await (await handle.getFileHandle(name)).getFile();
    return await file.text();
  } catch (e) {
    if (e && e.name === 'NotFoundError') return null; // まだファイルがない
    throw e;
  }
}

export async function writeText(handle, name, text) {
  const writable = await (await handle.getFileHandle(name, { create: true })).createWritable();
  await writable.write(text);
  await writable.close();
}

// スマホ用:ファイルとして書き出す(ダウンロード)
export function downloadText(name, text) {
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
