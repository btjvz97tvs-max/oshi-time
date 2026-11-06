// にじさんじ全員のチャンネル・配信中/予定・最近の動画を Holodex API から集めて書き出す
//   accounts.json にアカウントがないとき … data.json（そのまま）
//   アカウントがあるとき             … data.enc.json（暗号化。登録された人だけが開ける）
// 実行: HOLODEX_API_KEY=xxxx node scripts/fetch-data.mjs
import { readFile, writeFile, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';

const nacl = createRequire(import.meta.url)('../vendor/nacl-fast.js');

const KEY = process.env.HOLODEX_API_KEY;
const BASE = process.env.HOLODEX_BASE || 'https://holodex.net/api/v2';
const ORG = 'Nijisanji';
const OUT = new URL('../data.json', import.meta.url);
const OUT_ENC = new URL('../data.enc.json', import.meta.url);
const ACCOUNTS = new URL('../accounts.json', import.meta.url);

const b64u = (u8) => Buffer.from(u8).toString('base64url');
const unb64u = (s) => new Uint8Array(Buffer.from(String(s), 'base64url'));

async function readAccounts() {
  try {
    const d = JSON.parse(await readFile(ACCOUNTS, 'utf8'));
    return Array.isArray(d.accounts) ? d.accounts.filter(Boolean) : [];
  } catch {
    return [];
  }
}

// 書き出し。アカウントが1つでもあれば、平文の data.json は作らずに暗号化した data.enc.json だけを作る。
// 毎回ランダムな「中身の鍵」で全体を暗号化し、その鍵を、登録された人それぞれの公開鍵で包む（X25519 + XSalsa20-Poly1305）。
async function writeOutput(data) {
  const accounts = await readAccounts();
  if (accounts.length === 0) {
    await writeFile(OUT, JSON.stringify(data));
    await rm(OUT_ENC, { force: true });
    return '公開（アカウントなし）';
  }
  const recipients = accounts.filter((a) => a.v === 3 && typeof a.pub === 'string');
  const contentKey = nacl.randomBytes(nacl.secretbox.keyLength);
  const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
  const box = nacl.secretbox(new TextEncoder().encode(JSON.stringify(data)), nonce, contentKey);
  const eph = nacl.box.keyPair();
  const keys = [];
  for (const a of recipients) {
    const pub = unb64u(a.pub);
    if (pub.length !== nacl.box.publicKeyLength) continue;
    const n = nacl.randomBytes(nacl.box.nonceLength);
    keys.push({ pub: a.pub, nonce: b64u(n), key: b64u(nacl.box(contentKey, n, pub, eph.secretKey)) });
  }
  const out = { v: 3, updated: data.updated, epk: b64u(eph.publicKey), nonce: b64u(nonce), box: b64u(box), keys };
  await writeFile(OUT_ENC, JSON.stringify(out));
  await rm(OUT, { force: true });
  return `暗号化（開ける人 ${keys.length}人）`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function get(path, params = {}) {
  const url = new URL(BASE + path);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch(url, {
      headers: { 'X-APIKEY': KEY, 'User-Agent': 'oshi-time (personal fan app)' },
    });
    if (res.ok) return res.json();
    if (res.status === 429 || res.status >= 500) {
      await sleep(2000 * (attempt + 1));
      continue;
    }
    throw new Error(`Holodex ${res.status} ${url.pathname}`);
  }
  throw new Error(`Holodex: 何度試しても応答がありません ${url.pathname}`);
}

// 50件ずつページをめくる。新しいIDが出てこなくなったら止める
async function paged(path, params, max) {
  const seen = new Map();
  for (let offset = 0; offset < max; offset += 50) {
    const page = await get(path, { ...params, limit: 50, offset });
    const items = Array.isArray(page) ? page : page?.items ?? [];
    let added = 0;
    for (const it of items) {
      if (it?.id && !seen.has(it.id)) {
        seen.set(it.id, it);
        added++;
      }
    }
    if (items.length < 50 || added === 0) break;
    await sleep(400);
  }
  return [...seen.values()];
}

const cleanGroup = (s) => (s || '').replace(/^[a-z]\s+/, '').trim();

function toLiver(c) {
  return {
    id: c.id,
    name: c.name || c.english_name || c.id,
    en: c.english_name || '',
    photo: c.photo || '',
    x: c.twitter || '',
    group: cleanGroup(c.suborg || c.group),
    subs: Number(c.subscriber_count) || 0,
  };
}

function toVideo(v) {
  const start = v.start_actual || v.start_scheduled || v.available_at || v.published_at || null;
  const out = {
    id: v.id,
    title: v.title || '',
    ch: v.channel?.id || v.channel_id || '',
    status: v.status || 'past',
    start,
  };
  if (v.topic_id) out.topic = v.topic_id;
  if (v.duration) out.dur = v.duration;
  if (v.live_viewers) out.viewers = v.live_viewers;
  return out;
}

async function main() {
  if (!KEY) {
    // キー未設定でもサイト自体は表示できるよう、空のデータを書いて正常終了する
    const how = await writeOutput({ updated: new Date().toISOString(), error: 'no-key', livers: [], videos: [] });
    console.warn(`HOLODEX_API_KEY が設定されていません。空のデータを書き出しました（${how}）。`);
    return;
  }

  const channels = await paged(
    '/channels',
    { org: ORG, type: 'vtuber', sort: 'subscriber_count', order: 'desc' },
    1000
  );
  const live = await paged('/live', { org: ORG, type: 'stream', max_upcoming_hours: 72 }, 500);
  const recent = await paged(
    '/videos',
    { org: ORG, type: 'stream', status: 'past', sort: 'available_at', order: 'desc' },
    200
  );

  // VirtuaReal（中国のプロジェクト）は Holodex では同じ組織に入っているが、ここでは外す
  const isVirtuaReal = (c) =>
    /virtuareal/i.test(`${c.group || ''} ${c.suborg || ''} ${c.name || ''} ${c.english_name || ''}`);
  const livers = new Map();
  for (const c of channels) if (!c.inactive && !isVirtuaReal(c)) livers.set(c.id, toLiver(c));

  // にじさんじのチャンネルの動画だけを入れる（他の事務所のコラボ配信などは入れない）
  const videos = new Map();
  for (const v of [...live, ...recent]) {
    if (v.status === 'missing') continue;
    const ch = v.channel?.id || v.channel_id;
    if (!livers.has(ch)) continue;
    if (!videos.has(v.id)) videos.set(v.id, toVideo(v));
  }

  const data = {
    updated: new Date().toISOString(),
    livers: [...livers.values()],
    videos: [...videos.values()].filter((v) => v.ch && v.start),
  };
  const how = await writeOutput(data);
  console.log(`ライバー ${data.livers.length}人 / 動画・配信 ${data.videos.length}件 を書き出しました（${how}）`);
  await report(data);
}

// 確認用のまとめをログに出す：いま配信中の人と、名簿（livers.json）と結びつかなかったチャンネル
async function report(data) {
  let roster = [];
  try {
    roster = JSON.parse(await readFile(new URL('../livers.json', import.meta.url), 'utf8')).livers || [];
  } catch {
    return;
  }
  const strip = (s) => String(s || '')
    .replace(/【[^】]*】|\[[^\]]*\]|\([^)]*\)|（[^）]*）/g, ' ')
    .replace(/\b(channel|ch)\b\.?|にじさんじ|nijisanji(\s*en)?/gi, ' ')
    .split(/[\/／|｜]/)[0];
  const ja = (s) => strip(s).normalize('NFKC').toLowerCase()
    .replace(/[\s・･.。、,'’"_\-‐ー〜~★☆]/g, '')
    .replace(/[ぁ-ゖ]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60));
  const en = (s) => String(s || '').normalize('NFKC').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean).sort().join(' ');
  const byYt = new Set(roster.map((r) => r.yt).filter(Boolean));
  const names = new Map();
  for (const r of roster) {
    for (const n of [r.n, ...(r.a || [])]) names.set(ja(n), r.n);
    if (r.e) names.set('en:' + en(r.e), r.n);
  }
  const matchOf = (c) => {
    if (byYt.has(c.id)) return roster.find((r) => r.yt === c.id).n;
    const cj = ja(c.name);
    if (names.has(cj)) return names.get(cj);
    if (names.has('en:' + en(c.en))) return names.get('en:' + en(c.en));
    if (names.has('en:' + en(strip(c.name)))) return names.get('en:' + en(strip(c.name)));
    if (cj.length >= 3) for (const [k, n] of names) if (!k.startsWith('en:') && k.length >= 3 && cj.includes(k)) return n;
    return null;
  };
  const counts = ['live', 'upcoming', 'past'].map((s) => `${s} ${data.videos.filter((v) => v.status === s).length}`).join(' / ');
  // ログは誰でも見られるので、配信の中身（誰が配信中か）は出さず、数だけ出す
  console.log(`配信の内訳: ${counts}`);
  const unmatched = data.livers.filter((c) => !matchOf(c));
  const matched = new Set(data.livers.map(matchOf).filter(Boolean));
  console.log(`名簿と結びついた人: ${matched.size} / ${roster.length}`);
  console.log(`名簿にいないチャンネル (${unmatched.length}): ${unmatched.map((c) => `${c.name}〈${c.group || '-'}〉`).join('、')}`);
  console.log(`チャンネルが見つからなかった名簿の人: ${roster.filter((r) => !matched.has(r.n)).map((r) => r.n).join('、') || 'なし'}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
