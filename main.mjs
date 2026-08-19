import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const BASE_URL = 'https://trustmrr.com';
const WINDOW_LIMIT = 120;
const WINDOW_MS = 60_000;
const WINDOW_PAD_MS = 200; // 贴着 t0+60s 再留一截，避免边界 429
const DEFAULT_CONCURRENCY = 10;
const MAX_ATTEMPTS = 3;
const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  Accept: 'text/html,application/xhtml+xml',
  'Accept-Language': 'en-US,en;q=0.9',
};

const args = parseArgs(process.argv.slice(2));

/** 追加 profileUrl / tagLine / founded 等派生字段，不覆盖已有字段。 */
export function enrichStartup(startup) {
  const xHandle = startup.xHandle ?? '';
  startup.profileUrl = `${BASE_URL}/startup/${startup.slug}`;
  startup.tagLine = startup.aiEnrichment?.valueProposition ?? '';
  startup.founded = startup.foundedDate ? String(new Date(startup.foundedDate).getFullYear()) : '';
  startup.location = startup.country ?? '';
  startup.founderProfile = xHandle ? `${BASE_URL}/founder/${xHandle}` : '';
  startup.founderTwitter = xHandle ? `https://x.com/${xHandle}` : '';
  return startup;
}

function extractRscData(htmlText, matchers = []) {
  const chunks = [];
  const re = /self\.__next_f\.push\(\[1,\s*("(?:\\.|[^"\\])*")\s*\]\)/g;
  let m;
  while ((m = re.exec(htmlText)) !== null) chunks.push(JSON.parse(m[1]));
  const lines = chunks.join('').split('\n');

  const objects = [];
  const seen = new Set();
  for (const line of lines) {
    const body = line.slice(line.indexOf(':') + 1);
    if (!body.startsWith('[')) continue;
    let value;
    try {
      value = JSON.parse(body);
    } catch {
      continue;
    }
    const walk = (v) => {
      if (Array.isArray(v)) {
        v.forEach(walk);
      } else if (v && typeof v === 'object') {
        const hit = matchers.find((x) => x.test(v));
        if (hit) {
          const data = hit.key === 'self' ? v : v[hit.key];
          const tag = JSON.stringify(data);
          if (!seen.has(tag)) {
            seen.add(tag);
            objects.push(data);
          }
          return;
        }
        Object.values(v).forEach(walk);
      }
    };
    walk(value);
  }
  return objects;
}

export function parseStartupDetailFromHtml(html, slug) {
  const found = extractRscData(html, [
    { key: 'self', test: (o) => o.startup && typeof o.startup === 'object' },
  ]);
  const startup = found.find((o) => o.startup?.slug === slug)?.startup;
  return startup ? enrichStartup(startup) : null;
}

function printHelp() {
  console.log(`Usage:
  node main.mjs                          # 全量 → batch.json + failed.json
  node main.mjs --mock                   # 用 data-mock.json
  node main.mjs --shard N --shards M     # 分片（GHA 并行）
  node main.mjs --retry [failed.json]    # 只跑失败清单里可重试的 slug
  node main.mjs --merge --shards M       # 合并 shard-*.json / failed-*.json
  node main.mjs --concurrency 10

失败会写入 failed.json（分片时为 failed-N.json），下一轮：
  node main.mjs --retry failed.json
`);
}

function parseArgs(argv) {
  const get = (flag) => {
    const i = argv.indexOf(flag);
    if (i < 0) return null;
    if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) return argv[i + 1];
    return true;
  };
  const num = (flag, env, fallback) => {
    const raw = get(flag);
    const n = Number(raw === true || raw == null ? process.env[env] ?? fallback : raw);
    return Number.isFinite(n) ? n : fallback;
  };
  const retryFlag = get('--retry');
  return {
    mock: argv.includes('--mock'),
    merge: argv.includes('--merge'),
    retry: Boolean(retryFlag) || process.env.RETRY === 'true',
    retryFile:
      typeof retryFlag === 'string'
        ? retryFlag
        : process.env.RETRY_FILE || 'failed.json',
    shard: num('--shard', 'SHARD_INDEX', 0),
    shards: num('--shards', 'SHARD_COUNT', 1),
    concurrency: Math.max(1, num('--concurrency', 'CONCURRENCY', DEFAULT_CONCURRENCY)),
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function writeOutput(filePath, data) {
  const dir = dirname(filePath);
  if (dir && dir !== '.') mkdirSync(dir, { recursive: true });
  writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

function isRetryable(failure) {
  if (!failure) return false;
  if (failure.retryable === false) return false;
  if (failure.status === 404 || failure.reason === 'http-404') return false;
  return true;
}

function failureRecord(slug, extra = {}) {
  return {
    slug,
    reason: extra.reason || 'unknown',
    status: extra.status ?? null,
    error: extra.error || null,
    attempts: extra.attempts ?? 1,
    retryable: isRetryable({ status: extra.status, reason: extra.reason }),
    at: extra.at || new Date().toISOString(),
  };
}

let windowLock = Promise.resolve();
let windowStart = null;
let windowUsed = 0;

function acquireWindowSlot(totalHint = '') {
  windowLock = windowLock.then(async () => {
    const now = Date.now();
    if (windowStart != null && now >= windowStart + WINDOW_MS) {
      windowStart = null;
      windowUsed = 0;
    }
    if (windowUsed >= WINDOW_LIMIT) {
      const wait = windowStart + WINDOW_MS + WINDOW_PAD_MS - Date.now();
      if (wait > 0) {
        console.log(
          `   ⏸ window ${windowUsed}/${WINDOW_LIMIT} 已满，等待 ${(wait / 1000).toFixed(1)}s${totalHint}`
        );
        await sleep(wait);
      }
      windowStart = null;
      windowUsed = 0;
    }
    if (windowStart == null) windowStart = Date.now();
    windowUsed++;
  });
  return windowLock;
}

function markWindowExhausted() {
  windowLock = windowLock.then(() => {
    windowUsed = WINDOW_LIMIT;
  });
  return windowLock;
}

async function scrapeOnce(slug, index, total) {
  await acquireWindowSlot(`  [${index + 1}/${total}]`);
  const url = `${BASE_URL}/startup/${slug}`;
  const fetchStarted = performance.now();
  try {
    const res = await fetch(url, { headers: HEADERS, redirect: 'follow' });
    if (res.status === 429) {
      await markWindowExhausted();
      console.log(`   [${index + 1}/${total}] ⚠️  ${slug}: HTTP 429`);
      return { ok: false, slug, status: 429, reason: 'http-429' };
    }
    if (!res.ok) {
      console.log(`   [${index + 1}/${total}] ⚠️  ${slug}: HTTP ${res.status}`);
      return { ok: false, slug, status: res.status, reason: `http-${res.status}` };
    }
    const html = await res.text();
    const fetchMs = performance.now() - fetchStarted;
    const parseStarted = performance.now();
    const startup = parseStartupDetailFromHtml(html, slug);
    const parseMs = performance.now() - parseStarted;
    if (!startup) {
      console.log(`   [${index + 1}/${total}] ⚠️  ${slug}: parse miss  fetchTime: ${fetchMs.toFixed(1)}ms`);
      return { ok: false, slug, status: 200, reason: 'parse', fetchMs, parseMs };
    }
    console.log(
      `   [${index + 1}/${total}] ✓ ${slug} fetchTime: ${fetchMs.toFixed(1)}ms, parseTime: ${parseMs.toFixed(1)}ms`
    );
    return { ok: true, slug, startup, fetchMs, parseMs };
  } catch (err) {
    console.log(`   [${index + 1}/${total}] ✗ ${slug}: ${err.message}`);
    return { ok: false, slug, status: 0, reason: 'network', error: err.message };
  }
}

async function scrapeWithRetry(slug, index, total) {
  let last = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    last = await scrapeOnce(slug, index, total);
    last.attempts = attempt;
    if (last.ok) return last;
    if (!isRetryable(last)) return last;
    if (attempt < MAX_ATTEMPTS) {
      if (last.status !== 429) await sleep(400);
      console.log(`   [${index + 1}/${total}] ↻ retry ${attempt}/${MAX_ATTEMPTS} ${slug}`);
    }
  }
  return last;
}

function scrapeWithPool(slugs, { concurrency, onProgress }) {
  const slots = new Array(slugs.length);
  let cursor = 0;
  let inFlight = 0;

  return new Promise((resolve) => {
    function finish() {
      const startups = [];
      const failures = [];
      for (let i = 0; i < slots.length; i++) {
        const item = slots[i];
        if (item?.ok) startups.push(item);
        else failures.push(failureRecord(slugs[i], item || { reason: 'unknown' }));
      }
      resolve({ startups, failures });
    }

    function launch() {
      while (inFlight < concurrency && cursor < slugs.length) {
        const i = cursor++;
        inFlight++;
        scrapeWithRetry(slugs[i], i, slugs.length)
          .then((item) => {
            slots[i] = item;
            onProgress?.(i, item, slots);
          })
          .catch((err) => {
            slots[i] = { ok: false, slug: slugs[i], status: 0, reason: 'network', error: err.message };
            onProgress?.(i, slots[i], slots);
          })
          .finally(() => {
            inFlight--;
            if (cursor < slugs.length) launch();
            else if (inFlight === 0) finish();
          });
      }
      if (slugs.length === 0) finish();
    }

    launch();
  });
}

function outputPaths() {
  if (args.shards > 1) {
    return { ok: `shard-${args.shard}.json`, fail: `failed-${args.shard}.json` };
  }
  return { ok: 'batch.json', fail: 'failed.json' };
}

function failDoc(failPath, failures, extra = {}) {
  const { failedAt, retry, failures: _ignored, ...rest } = extra;
  return {
    ...rest,
    failedAt: failedAt || new Date().toISOString(),
    retry: retry || `node main.mjs --retry ${failPath}`,
    failures,
  };
}

function flushOutputs(okPath, failPath, startups, failures, extra = {}) {
  writeOutput(okPath, { startups: startups.map((item) => item.startup) });
  writeOutput(failPath, failDoc(failPath, failures, extra));
}

function checkpointRetry(slugOrder, startups, failures, failPath, extra = {}) {
  const merged = mergeIntoBatch('batch.json', slugOrder, startups);
  writeOutput('batch.json', { startups: merged });
  writeOutput(failPath, failDoc(failPath, failures, extra));
}

function loadCatalog() {
  const file = args.mock ? 'data-mock.json' : 'data.json';
  if (!existsSync(file)) {
    throw new Error(`找不到 ${file}`);
  }
  return { file, records: JSON.parse(readFileSync(file, 'utf8')) };
}

function pickSlugs(records) {
  const all = records.map((item) => item.slug).filter(Boolean);
  if (args.retry) {
    if (!existsSync(args.retryFile)) {
      throw new Error(`找不到失败清单 ${args.retryFile}`);
    }
    const doc = JSON.parse(readFileSync(args.retryFile, 'utf8'));
    const listed = doc.failures || [];
    const retryable = listed.filter(isRetryable).map((f) => f.slug);
    const carried = listed.filter((f) => !isRetryable(f));
    return { slugs: retryable, carried, retrySource: args.retryFile };
  }
  if (args.shards > 1) {
    const slugs = all.filter((_, i) => i % args.shards === args.shard);
    return { slugs, carried: [], retrySource: null };
  }
  return { slugs: all, carried: [], retrySource: null };
}

function mergeIntoBatch(existingPath, slugOrder, newStartups) {
  const map = new Map();
  if (existsSync(existingPath)) {
    const prev = JSON.parse(readFileSync(existingPath, 'utf8'));
    for (const s of prev.startups || []) {
      if (s?.slug) map.set(s.slug, s);
    }
  }
  for (const item of newStartups) {
    map.set(item.startup.slug, item.startup);
  }
  return slugOrder.map((slug) => map.get(slug)).filter(Boolean);
}

function mergeShards(shardCount, slugOrder) {
  const map = new Map();
  const failures = [];
  for (let i = 0; i < shardCount; i++) {
    const okPath = `shard-${i}.json`;
    const failPath = `failed-${i}.json`;
    if (existsSync(okPath)) {
      const doc = JSON.parse(readFileSync(okPath, 'utf8'));
      for (const s of doc.startups || []) {
        if (s?.slug) map.set(s.slug, s);
      }
    }
    if (existsSync(failPath)) {
      const doc = JSON.parse(readFileSync(failPath, 'utf8'));
      failures.push(...(doc.failures || []));
    }
  }
  const startups = slugOrder.map((slug) => map.get(slug)).filter(Boolean);
  const present = new Set([...map.keys(), ...failures.map((f) => f.slug)]);
  for (const slug of slugOrder) {
    if (!present.has(slug)) {
      failures.push(failureRecord(slug, { reason: 'missing-shard' }));
    }
  }
  writeOutput('batch.json', { startups });
  writeOutput('failed.json', failDoc('failed.json', failures));
  console.log(
    `\nMerged ${shardCount} shards → batch.json (${startups.length})  failed.json (${failures.length})`
  );
}

async function main() {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    printHelp();
    return;
  }

  const { file, records } = loadCatalog();
  const slugOrder = records.map((item) => item.slug).filter(Boolean);

  if (args.merge) {
    mergeShards(args.shards > 1 ? args.shards : 4, slugOrder);
    return;
  }

  const { slugs, carried } = pickSlugs(records);
  const { ok: okPath, fail: failPath } = outputPaths();
  const startTime = Date.now();

  if (slugs.length === 0) {
    console.log(args.retry ? '没有可重试的失败记录' : '没有可抓取的 slug');
    writeOutput(failPath, failDoc(failPath, carried));
    return;
  }

  console.log(`\nScraping ${slugs.length} startup detail pages...`);
  console.log(`   source=${file}  concurrency=${args.concurrency}`);
  console.log(`   window=${WINDOW_LIMIT} req / ${WINDOW_MS / 1000}s  pad=${WINDOW_PAD_MS}ms`);
  if (args.shards > 1) console.log(`   shard=${args.shard}/${args.shards} → ${okPath} + ${failPath}`);
  if (args.retry) {
    console.log(`   retry from ${args.retryFile}  skip-404=${carried.length}`);
  }
  console.log('');

  let lastFlush = 0;
  const { startups, failures } = await scrapeWithPool(slugs, {
    concurrency: args.concurrency,
    onProgress: (_i, _item, slots) => {
      const done = slots.filter(Boolean).length;
      if (done - lastFlush < 20 && done !== slots.length) return;
      lastFlush = done;
      const ok = [];
      const fail = [...carried];
      for (let i = 0; i < slots.length; i++) {
        const item = slots[i];
        if (!item) continue;
        if (item.ok) ok.push(item);
        else fail.push(failureRecord(slugs[i], item));
      }
      if (args.retry) {
        checkpointRetry(slugOrder, ok, fail, failPath, { partial: true, done, total: slugs.length });
      } else {
        flushOutputs(okPath, failPath, ok, fail, { partial: true, done, total: slugs.length });
      }
    },
  });

  const allFailures = [...carried, ...failures];
  if (args.retry) {
    checkpointRetry(slugOrder, startups, allFailures, failPath);
  } else {
    flushOutputs(okPath, failPath, startups, allFailures);
  }

  const wallSec = (Date.now() - startTime) / 1000;
  const retryableLeft = allFailures.filter(isRetryable).length;
  console.log(`\nOutput: ${args.retry ? 'batch.json' : okPath}  failures: ${failPath}`);
  console.log(`Success: ${startups.length}/${slugs.length}  failed: ${allFailures.length} (retryable ${retryableLeft})`);
  console.log(`Wall clock: ${wallSec.toFixed(1)}s`);
  if (startups.length) {
    const fetchSum = startups.reduce((acc, item) => acc + (item.fetchMs || 0), 0) / 1000;
    const parseSum = startups.reduce((acc, item) => acc + (item.parseMs || 0), 0) / 1000;
    console.log(`Total fetch time (sum): ${fetchSum.toFixed(1)}s`);
    console.log(`Total parse time (sum): ${parseSum.toFixed(1)}s`);
  }
  if (retryableLeft) {
    console.log(`\n下一轮只跑失败：node main.mjs --retry ${failPath}`);
  }
}

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isDirectRun) {
  main().catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}
