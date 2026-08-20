/**
 * TrustMRR POST /api/search 限流探针（GitHub Actions / 本地）
 *
 * 主队列：page 1→50 循环，按间隔发出，不等待上一个返回。
 * 第一次 429：立刻停发，等 wait-s（默认 50）秒，再对缓存的 429 串行重试
 *（等上一条返回再发下一条）。仍 429 则再等 wait-s 后重试同一条。
 *
 *   node probe-search-ratelimit.mjs
 *   node probe-search-ratelimit.mjs --interval-ms 200 --wait-s 50
 */
import { fileURLToPath } from 'url';
import { resolve } from 'path';

const SEARCH_URL = 'https://trustmrr.com/api/search';

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
  return {
    help: argv.includes('--help') || argv.includes('-h'),
    intervalMs: Math.max(0, num('--interval-ms', 'INTERVAL_MS', 200)),
    waitS: Math.max(0, num('--wait-s', 'WAIT_S', 50)),
    retryTimeoutMs: Math.max(1000, num('--retry-timeout-ms', 'RETRY_TIMEOUT_MS', 120_000)),
    maxCycles: Math.max(1, num('--max-cycles', 'MAX_CYCLES', 3)),
    maxRequests: Math.max(1, num('--max-requests', 'MAX_REQUESTS', 800)),
    maxPage: Math.max(1, num('--max-page', 'MAX_PAGE', 50)),
    limit: Math.max(1, num('--limit', 'LIMIT', 100)),
    sortBy: typeof get('--sort-by') === 'string' ? get('--sort-by') : process.env.SORT_BY || 'latest',
  };
}

const args = parseArgs(process.argv.slice(2));
const waitMs = Math.round(args.waitS * 1000);

function printHelp() {
  console.log(`Usage:
  node probe-search-ratelimit.mjs
  node probe-search-ratelimit.mjs --interval-ms 200 --wait-s 50

  --interval-ms N          主队列发出间隔，默认 200（不等待返回）
  --wait-s N               第一次 429 后停发等待秒数，默认 50
  --retry-timeout-ms N     串行重试同一条 429 的总超时，默认 120000
  --max-cycles N           打满→等待→串行重试 的轮数，默认 3
  --max-requests N         最多发出次数，默认 800
  --max-page N             page 循环上限，默认 50
  --limit N                默认 100
  --sort-by latest         默认 latest

环境变量：INTERVAL_MS / WAIT_S / RETRY_TIMEOUT_MS / MAX_CYCLES / TRUSTMRR_COOKIE
`);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function iso(ms) {
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

function publicHeaders(headers) {
  const out = { ...headers };
  if (out.Cookie) out.Cookie = '<redacted>';
  return out;
}

function headersToObject(headers) {
  const out = {};
  headers.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

function interesting429Headers(headers) {
  const keys = [
    'retry-after',
    'x-ratelimit-limit',
    'x-ratelimit-remaining',
    'x-ratelimit-reset',
    'ratelimit-limit',
    'ratelimit-remaining',
    'ratelimit-reset',
    'x-rate-limit-limit',
    'x-rate-limit-remaining',
    'x-rate-limit-reset',
  ];
  const out = {};
  for (const key of keys) {
    const value = headers.get(key);
    if (value != null) out[key] = value;
  }
  return out;
}

function printDump(title, dump) {
  console.log(`\n========== ${title} ==========`);
  console.log(JSON.stringify(dump, null, 2));
  console.log('========== END DUMP ==========\n');
}

const requestHeaders = buildHeaders();
const samples = [];

let seq = 0;
let pageCursor = 1;
let paused = false;
let retryQueue = [];
let cycles = 0;
let stop = false;
let stopReason = '';
let inflight = 0;
let first429Dump = null;
let last429Dump = null;

function nextPage() {
  const page = pageCursor;
  pageCursor = pageCursor >= args.maxPage ? 1 : pageCursor + 1;
  return page;
}

function shouldStopSending() {
  return stop || seq >= args.maxRequests;
}

async function waitInflight() {
  const start = Date.now();
  while (inflight > 0 && Date.now() - start < 30_000) {
    await sleep(50);
  }
}

async function sleepInterruptible(ms) {
  const step = 50;
  for (let t = 0; t < ms && !stop && !paused; t += step) {
    await sleep(Math.min(step, ms - t));
  }
}

async function cooldown(reason) {
  console.log(`\n⏸  ${reason}，停止发请求，等待 ${args.waitS}s\n`);
  const started = Date.now();
  while (!stop && Date.now() - started < waitMs) {
    await sleep(Math.min(200, waitMs - (Date.now() - started)));
  }
  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`▶  已等待 ${elapsed}s，串行重试 ${retryQueue.length} 条 429\n`);
}

async function sendOnce(kind, page) {
  if (shouldStopSending()) return null;
  const id = ++seq;
  const sentAt = Date.now();
  const body = { sortBy: args.sortBy, limit: args.limit, page };
  inflight++;

  try {
    const res = await fetch(SEARCH_URL, {
      method: 'POST',
      headers: requestHeaders,
      body: JSON.stringify(body),
    });
    const recvAt = Date.now();
    const text = await res.text().catch(() => '');
    const rateHeaders = interesting429Headers(res.headers);
    const dump = {
      id,
      kind,
      page,
      url: SEARCH_URL,
      method: 'POST',
      sentAt: iso(sentAt),
      recvAt: iso(recvAt),
      rttMs: recvAt - sentAt,
      status: res.status,
      requestHeaders: publicHeaders(requestHeaders),
      requestBody: body,
      responseHeaders: headersToObject(res.headers),
      responseBody: text.slice(0, 2000),
      rateLimitHeaders: rateHeaders,
    };

    const sample = {
      id,
      kind,
      page,
      sentAt,
      recvAt,
      status: res.status,
      rttMs: recvAt - sentAt,
      rateHeaders,
    };
    samples.push(sample);

    const mark = res.status === 200 ? '✓' : res.status === 429 ? '⛔' : '⚠️';
    const extra = Object.keys(rateHeaders).length ? `  ${JSON.stringify(rateHeaders)}` : '';
    console.log(
      `[#${String(id).padStart(4, '0')}] ${iso(sentAt)} → ${iso(recvAt)}  ${String(sample.rttMs).padStart(5)}ms  ${mark} HTTP ${res.status}  ${kind.toUpperCase().padEnd(5)} page=${page}${extra}`
    );

    if (res.status === 429) {
      last429Dump = dump;
      if (!first429Dump) {
        first429Dump = dump;
        printDump('FIRST 429', dump);
      }
      if (kind !== 'retry') {
        retryQueue.push({ id, page, sentAt, recvAt });
        paused = true;
      }
    }

    return sample;
  } catch (err) {
    const recvAt = Date.now();
    const sample = {
      id,
      kind,
      page,
      sentAt,
      recvAt,
      status: 0,
      rttMs: recvAt - sentAt,
      error: err.message,
    };
    samples.push(sample);
    console.log(
      `[#${String(id).padStart(4, '0')}] ${iso(sentAt)} → ${iso(recvAt)}  ${String(recvAt - sentAt).padStart(5)}ms  ✗ NET ${err.message}  ${kind.toUpperCase().padEnd(5)} page=${page}`
    );
    return sample;
  } finally {
    inflight--;
  }
}

async function runMainBurst() {
  paused = false;
  while (!stop && !paused) {
    if (shouldStopSending()) {
      stop = true;
      stopReason = stopReason || `达到 max-requests=${args.maxRequests}`;
      return;
    }
    sendOnce('main', nextPage());
    await sleepInterruptible(args.intervalMs);
  }
  await waitInflight();
}

async function runSerialRetry() {
  const retryStarted = Date.now();
  while (retryQueue.length && !stop) {
    if (Date.now() - retryStarted > args.retryTimeoutMs) {
      stop = true;
      stopReason = `串行重试 ${args.retryTimeoutMs / 1000}s 仍有 429`;
      return;
    }
    if (shouldStopSending()) {
      stop = true;
      stopReason = stopReason || `达到 max-requests=${args.maxRequests}`;
      return;
    }
    const item = retryQueue[0];
    const result = await sendOnce('retry', item.page);
    if (!result) return;
    if (result.status === 200) {
      retryQueue.shift();
      console.log(`   → page=${item.page} 重试成功，缓存剩余 ${retryQueue.length}`);
      continue;
    }
    console.log(`   → page=${item.page} 仍 ${result.status || 'NET'}，再等 ${args.waitS}s`);
    await sleep(waitMs);
  }
}

function analyze() {
  const ok = samples.filter((s) => s.status === 200);
  const limited = samples.filter((s) => s.status === 429);
  const other = samples.filter((s) => s.status !== 200 && s.status !== 429);
  console.log('\n========== 分析摘要 ==========');
  console.log(`stop: ${stopReason || 'normal'}`);
  console.log(`sent=${samples.length}  200=${ok.length}  429=${limited.length}  other=${other.length}  cycles=${cycles}`);
  console.log(`interval=${args.intervalMs}ms  wait=${args.waitS}s  page=1..${args.maxPage}  limit=${args.limit}  sortBy=${args.sortBy}`);

  if (!limited.length) {
    console.log('未打到 429。加大 --max-requests 或减小 --interval-ms 再试。');
    console.log('========== END ==========\n');
    return;
  }

  const bySent = [...samples].sort((a, b) => a.sentAt - b.sentAt || a.id - b.id);
  const byRecv = [...samples].sort((a, b) => a.recvAt - b.recvAt || a.id - b.id);
  const first429Sent = bySent.find((s) => s.status === 429);
  const first429Recv = byRecv.find((s) => s.status === 429);
  const okBeforeFirst429Send = bySent.filter(
    (s) => s.status === 200 && s.sentAt <= first429Sent.sentAt
  ).length;
  const okBeforeFirst429Recv = byRecv.filter(
    (s) => s.status === 200 && s.recvAt <= first429Recv.recvAt
  ).length;

  console.log(`\n第一次 429（按发出） #${first429Sent.id} sent=${iso(first429Sent.sentAt)} recv=${iso(first429Sent.recvAt)}`);
  console.log(`第一次 429（按返回） #${first429Recv.id} sent=${iso(first429Recv.sentAt)} recv=${iso(first429Recv.recvAt)}`);
  console.log(`第一次 429 发出之前的 200 次数: ${okBeforeFirst429Send}`);
  console.log(`第一次 429 返回之前的 200 次数: ${okBeforeFirst429Recv}`);
  if (ok.length) {
    console.log(`#1 发出 → 第一次 429 发出: ${((first429Sent.sentAt - bySent[0].sentAt) / 1000).toFixed(3)}s`);
    console.log(`#1 返回 → 第一次 429 返回: ${((first429Recv.recvAt - byRecv[0].recvAt) / 1000).toFixed(3)}s`);
  }

  const recoveries = [];
  let pending429 = null;
  for (const s of byRecv) {
    if (s.status === 429 && pending429 == null) pending429 = s;
    if (s.status === 200 && pending429 && s.kind === 'retry') {
      recoveries.push({
        limitedFrom: pending429,
        recovered: s,
        waitMs: s.recvAt - pending429.recvAt,
      });
      pending429 = null;
    }
  }

  if (recoveries.length) {
    console.log('\n429 → 200 恢复:');
    for (const [i, rec] of recoveries.entries()) {
      console.log(
        `  cycle ${i + 1}: 429 #${rec.limitedFrom.id} ${iso(rec.limitedFrom.recvAt)} → 200 #${rec.recovered.id} ${iso(rec.recovered.recvAt)}  wait=${(rec.waitMs / 1000).toFixed(3)}s`
      );
    }
  }

  const headerHits = limited
    .map((s) => s.rateHeaders)
    .filter((h) => h && Object.keys(h).length);
  if (headerHits.length) {
    console.log('\n429 限流相关响应头（去重）:');
    const seen = new Set();
    for (const h of headerHits) {
      const tag = JSON.stringify(h);
      if (seen.has(tag)) continue;
      seen.add(tag);
      console.log(`  ${tag}`);
    }
  } else {
    console.log('\n429 响应没有 Retry-After / X-RateLimit-* 头。');
  }

  console.log('\n怎么读这段日志:');
  console.log('  · 连续 200 的条数 ≈ 窗口额度（按发出顺序更接近服务端计数）');
  console.log(`  · 第一次 429 后固定等待 ${args.waitS}s，再串行重试；恢复时刻相对整分/首请求可对照`);
  console.log('  · 恢复后下一波还能打满相近条数 → 固定窗口；额度越打越少 → 滑动');
  console.log('========== END ==========\n');
}

async function main() {
  if (args.help) {
    printHelp();
    return;
  }

  console.log('TrustMRR /api/search rate-limit probe');
  console.log(`url=${SEARCH_URL}  interval=${args.intervalMs}ms  wait=${args.waitS}s`);
  console.log(`maxCycles=${args.maxCycles}  maxRequests=${args.maxRequests}  page=1..${args.maxPage} loop`);
  console.log(`body={ sortBy: "${args.sortBy}", limit: ${args.limit}, page }`);
  console.log(`cookie=${process.env.TRUSTMRR_COOKIE ? 'yes' : 'no'}`);
  console.log('');

  while (!stop) {
    await runMainBurst();
    if (stop) break;
    if (!retryQueue.length) {
      stop = true;
      stopReason = stopReason || '主队列结束且无 429';
      break;
    }

    cycles += 1;
    console.log(`\n—— cycle ${cycles}/${args.maxCycles}：额度打满，缓存 ${retryQueue.length} 条 429 ——`);
    await cooldown('第一轮额度打满（429）');
    if (stop) break;
    await runSerialRetry();
    if (stop) break;

    if (cycles >= args.maxCycles) {
      stop = true;
      stopReason = `已完成 ${cycles} 轮 打满→等待→串行重试`;
      break;
    }

    console.log('\n→ 缓存已空，继续主队列\n');
  }

  await waitInflight();

  if (stopReason.includes('仍有 429')) {
    printDump('429 TIMEOUT DUMP', last429Dump || first429Dump || { error: 'no dump' });
  }

  analyze();
}

const isDirectRun = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isDirectRun) {
  main().catch((err) => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
}
