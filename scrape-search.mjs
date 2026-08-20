/**
 * TrustMRR POST /api/search 列表采集
 *
 * 先请求 page=1 拿到 total / pages，再按每片 20 页分片（单 IP 每 UTC 分钟约 20 次）。
 * 片内串行；遇 429 停发，等 wait-s（默认 50）再重试。全部分片完成后 --merge。
 *
 *   node scrape-search.mjs --plan
 *   node scrape-search.mjs --shard 0
 *   node scrape-search.mjs --merge
 *   node scrape-search.mjs --all          # 本地：plan + 逐片（片间也等 wait-s）
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { resolve } from 'path';

const SEARCH_URL = 'https://trustmrr.com/api/search';
const PLAN_FILE = 'search-plan.json';
const LIST_FILE = 'search-list.json';
const FAIL_FILE = 'search-failed.json';

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
  const shardFlag = get('--shard');
  return {
    help: argv.includes('--help') || argv.includes('-h'),
    plan: argv.includes('--plan'),
    merge: argv.includes('--merge'),
    all: argv.includes('--all'),
    shard:
      shardFlag === true
        ? num('--shard', 'SHARD_INDEX', 0)
        : shardFlag != null
          ? Number(shardFlag)
          : process.env.SHARD_INDEX != null
            ? Number(process.env.SHARD_INDEX)
            : null,
    pagesPerShard: Math.max(1, num('--pages-per-shard', 'PAGES_PER_SHARD', 20)),
    intervalMs: Math.max(0, num('--interval-ms', 'INTERVAL_MS', 200)),
    waitS: Math.max(0, num('--wait-s', 'WAIT_S', 50)),
    maxAttempts: Math.max(1, num('--max-attempts', 'MAX_ATTEMPTS', 3)),
    limit: Math.max(1, num('--limit', 'LIMIT', 100)),
    sortBy: typeof get('--sort-by') === 'string' ? get('--sort-by') : process.env.SORT_BY || 'latest',
  };
}

const args = parseArgs(process.argv.slice(2));
const waitMs = Math.round(args.waitS * 1000);

function printHelp() {
  console.log(`Usage:
  node scrape-search.mjs --plan
  node scrape-search.mjs --shard N
  node scrape-search.mjs --merge
  node scrape-search.mjs --all

  --pages-per-shard N   每片页数，默认 20（对齐单 IP 每分钟额度）
  --interval-ms N       片内串行间隔，默认 200
  --wait-s N            429 后等待秒数，默认 50
  --limit N             默认 100
  --sort-by latest

环境变量：PAGES_PER_SHARD / WAIT_S / SHARD_INDEX / TRUSTMRR_COOKIE
`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function iso(ms = Date.now()) {
  return new Date(ms).toISOString();
}

function buildHeaders() {
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    Accept: 'application/json',
    'Content-Type': 'application/json',
    Origin: 'https://trustmrr.com',
    Referer: 'https://trustmrr.com/search',
  };
  if (process.env.TRUSTMRR_COOKIE) headers.Cookie = process.env.TRUSTMRR_COOKIE;
  return headers;
}

function writeJson(filePath, data) {
  writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function setGitHubOutput(name, value) {
  const str = typeof value === 'string' ? value : JSON.stringify(value);
  console.log(`${name}=${str}`);
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${str}\n`);
  }
}

function shardRanges(pages, size) {
  const shards = [];
  for (let start = 1, index = 0; start <= pages; start += size, index++) {
    shards.push({
      index,
      fromPage: start,
      toPage: Math.min(start + size - 1, pages),
    });
  }
  return shards;
}

function shardFile(index) {
  return `search-shard-${index}.json`;
}

async function fetchPage(page) {
  const body = { sortBy: args.sortBy, limit: args.limit, page };
  const sentAt = Date.now();
  const res = await fetch(SEARCH_URL, {
    method: 'POST',
    headers: buildHeaders(),
    body: JSON.stringify(body),
  });
  const recvAt = Date.now();
  const text = await res.text();
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = null;
  }
  return {
    ok: res.ok,
    status: res.status,
    sentAt,
    recvAt,
    rttMs: recvAt - sentAt,
    page,
    data,
    error: res.ok ? null : text.slice(0, 500),
  };
}

async function fetchPageWithRetry(page) {
  let last = null;
  for (let attempt = 1; attempt <= args.maxAttempts; attempt++) {
    try {
      last = await fetchPage(page);
    } catch (err) {
      last = {
        ok: false,
        status: 0,
        sentAt: Date.now(),
        recvAt: Date.now(),
        rttMs: 0,
        page,
        data: null,
        error: err.message,
      };
    }
    last.attempts = attempt;
    const mark = last.ok ? '✓' : last.status === 429 ? '⛔' : '⚠️';
    console.log(
      `   [${mark}] page=${page}  HTTP ${last.status}  ${last.rttMs}ms  attempt ${attempt}/${args.maxAttempts}`
    );
    if (last.ok) return last;
    if (last.status === 429 && attempt < args.maxAttempts) {
      console.log(`   ⏸  429，等待 ${args.waitS}s 后重试 page=${page}`);
      await sleep(waitMs);
      continue;
    }
    if (last.status !== 429 && attempt < args.maxAttempts) {
      await sleep(400);
    }
  }
  return last;
}

function buildPlan(pagination) {
  const total = Number(pagination?.total) || 0;
  const pages =
    Number(pagination?.pages) || Math.max(1, Math.ceil(total / args.limit) || 0);
  const shards = pages > 0 ? shardRanges(pages, args.pagesPerShard) : [];
  return {
    plannedAt: iso(),
    url: SEARCH_URL,
    sortBy: args.sortBy,
    limit: args.limit,
    pagesPerShard: args.pagesPerShard,
    total,
    pages,
    shardCount: shards.length,
    shards,
  };
}

async function runPlan() {
  console.log(`Plan: POST ${SEARCH_URL}  page=1  limit=${args.limit}  sortBy=${args.sortBy}`);
  const first = await fetchPageWithRetry(1);
  if (!first.ok || !first.data?.pagination) {
    throw new Error(`plan 失败：HTTP ${first?.status} ${first?.error || ''}`);
  }
  const plan = buildPlan(first.data.pagination);
  writeJson(PLAN_FILE, plan);
  const matrix = { shard: plan.shards.map((s) => s.index) };
  setGitHubOutput('matrix', matrix);
  setGitHubOutput('shard_count', String(plan.shardCount));
  setGitHubOutput('pages', String(plan.pages));
  setGitHubOutput('total', String(plan.total));
  console.log(
    `\n${PLAN_FILE}: total=${plan.total}  pages=${plan.pages}  shards=${plan.shardCount} × ${args.pagesPerShard} pages`
  );
  for (const s of plan.shards) {
    console.log(`   shard ${s.index}: page ${s.fromPage}–${s.toPage}`);
  }
  return plan;
}

function loadPlan() {
  if (!existsSync(PLAN_FILE)) {
    throw new Error(`找不到 ${PLAN_FILE}，先跑 node scrape-search.mjs --plan`);
  }
  return readJson(PLAN_FILE);
}

async function runShard(index) {
  const plan = loadPlan();
  const spec = plan.shards.find((s) => s.index === index);
  if (!spec) {
    throw new Error(`plan 里没有 shard ${index}`);
  }
  const pages = [];
  for (let page = spec.fromPage; page <= spec.toPage; page++) {
    pages.push(page);
  }
  console.log(`\nShard ${index}: page ${spec.fromPage}–${spec.toPage} (${pages.length} 请求)\n`);

  const startups = [];
  const pageLogs = [];
  const failures = [];

  for (let i = 0; i < pages.length; i++) {
    const page = pages[i];
    const result = await fetchPageWithRetry(page);
    const list = result.ok ? result.data?.startups || [] : [];
    if (result.ok) {
      startups.push(...list);
      pageLogs.push({ page, count: list.length, status: result.status, attempts: result.attempts });
    } else {
      failures.push({
        page,
        status: result.status,
        error: result.error || null,
        attempts: result.attempts,
        retryable: result.status !== 404,
        at: iso(),
      });
      pageLogs.push({ page, count: 0, status: result.status, attempts: result.attempts });
    }
    if (i < pages.length - 1) await sleep(args.intervalMs);
  }

  const out = {
    shard: index,
    fromPage: spec.fromPage,
    toPage: spec.toPage,
    scrapedAt: iso(),
    startups,
    pages: pageLogs,
    failures,
  };
  const file = shardFile(index);
  writeJson(file, out);
  console.log(`\n${file}: startups=${startups.length}  failedPages=${failures.length}`);
  return out;
}

function runMerge() {
  const plan = existsSync(PLAN_FILE) ? readJson(PLAN_FILE) : { shards: [], total: 0, pages: 0 };
  const shardCount = plan.shardCount || plan.shards?.length || 0;
  const map = new Map();
  const failures = [];
  const seenPages = new Set();

  for (let i = 0; i < shardCount; i++) {
    const file = shardFile(i);
    if (!existsSync(file)) {
      const spec = plan.shards?.[i];
      const fromPage = spec?.fromPage ?? i * args.pagesPerShard + 1;
      const toPage = spec?.toPage ?? fromPage + args.pagesPerShard - 1;
      for (let page = fromPage; page <= toPage && page <= (plan.pages || toPage); page++) {
        failures.push({
          page,
          status: 0,
          error: `missing ${file}`,
          attempts: 0,
          retryable: true,
          at: iso(),
        });
      }
      continue;
    }
    const doc = readJson(file);
    for (const s of doc.startups || []) {
      if (s?.slug && !map.has(s.slug)) map.set(s.slug, s);
    }
    failures.push(...(doc.failures || []));
    for (const p of doc.pages || []) {
      if (p.status >= 200 && p.status < 300) seenPages.add(p.page);
    }
  }

  for (let page = 1; page <= (plan.pages || 0); page++) {
    if (!seenPages.has(page) && !failures.some((f) => f.page === page)) {
      failures.push({
        page,
        status: 0,
        error: 'missing-page',
        attempts: 0,
        retryable: true,
        at: iso(),
      });
    }
  }

  const startups = [...map.values()];
  writeJson(LIST_FILE, {
    scrapedAt: iso(),
    source: SEARCH_URL,
    sortBy: plan.sortBy || args.sortBy,
    limit: plan.limit || args.limit,
    pagination: {
      total: plan.total || startups.length,
      pages: plan.pages || 0,
      fetched: startups.length,
    },
    startups,
  });
  writeJson(FAIL_FILE, {
    failedAt: iso(),
    retry: 'node scrape-search.mjs --all',
    failures,
  });
  console.log(
    `\nMerged ${shardCount} shards → ${LIST_FILE} (${startups.length}/${plan.total || '?'})  ${FAIL_FILE} (${failures.length})`
  );
}

async function runAll() {
  const plan = await runPlan();
  for (let i = 0; i < plan.shards.length; i++) {
    if (i > 0) {
      console.log(`\n⏸  同 IP 下一片前等待 ${args.waitS}s\n`);
      await sleep(waitMs);
    }
    await runShard(plan.shards[i].index);
  }
  runMerge();
}

async function main() {
  if (args.help) {
    printHelp();
    return;
  }
  if (args.merge) {
    runMerge();
    return;
  }
  if (args.plan) {
    await runPlan();
    return;
  }
  if (args.all) {
    await runAll();
    return;
  }
  if (args.shard == null) {
    printHelp();
    return;
  }
  await runShard(Number(args.shard));
}

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isDirectRun) {
  main().catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}
