// にじさんじ全員のチャンネル・配信中/予定・最近の動画を Holodex API から集めて data.json に書き出す
// 実行: HOLODEX_API_KEY=xxxx node scripts/fetch-data.mjs
import { readFile, writeFile } from 'node:fs/promises';

const KEY = process.env.HOLODEX_API_KEY;
const BASE = process.env.HOLODEX_BASE || 'https://holodex.net/api/v2';
const ORG = 'Nijisanji';
const OUT = new URL('../data.json', import.meta.url);

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
    group: cleanGroup(c.suborg),
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
    await writeFile(
      OUT,
      JSON.stringify({ updated: new Date().toISOString(), error: 'no-key', livers: [], videos: [] })
    );
    console.warn('HOLODEX_API_KEY が設定されていません。空の data.json を書き出しました。');
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

  const livers = new Map();
  for (const c of channels) if (!c.inactive) livers.set(c.id, toLiver(c));
  // 一覧に無いチャンネル（公式チャンネルなど）の動画も、名前と写真だけ拾っておく
  for (const v of [...live, ...recent]) {
    const c = v.channel;
    if (c?.id && !livers.has(c.id)) livers.set(c.id, toLiver(c));
  }

  const videos = new Map();
  for (const v of [...live, ...recent]) {
    if (v.status === 'missing') continue;
    if (!videos.has(v.id)) videos.set(v.id, toVideo(v));
  }

  const data = {
    updated: new Date().toISOString(),
    livers: [...livers.values()],
    videos: [...videos.values()].filter((v) => v.ch && v.start),
  };
  await writeFile(OUT, JSON.stringify(data));
  console.log(`ライバー ${data.livers.length}人 / 動画・配信 ${data.videos.length}件 を書き出しました`);
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
  const chName = new Map(data.livers.map((c) => [c.id, c.name]));
  const live = data.videos.filter((v) => v.status === 'live');
  const counts = ['live', 'upcoming', 'past'].map((s) => `${s} ${data.videos.filter((v) => v.status === s).length}`).join(' / ');
  console.log(`配信の内訳: ${counts}`);
  console.log(`いま配信中: ${live.map((v) => chName.get(v.ch) || v.ch).join('、') || 'なし'}`);
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
