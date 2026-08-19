import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
const data = JSON.parse(readFileSync('data-mock.json', 'utf8'));
const BASE_URL = 'https://trustmrr.com';
const DELAY_MS = 200; // batch 模式：组与组之间的间隔
const BATCH_SIZE = 2; // 同时在途的最大请求数

// 并发策略：batch = 现有 Promise.all 整批等待；pool = 补位任务池
// 命令行：node main.mjs --batch  /  node main.mjs --pool
const CONCURRENCY_MODE = process.argv.includes('--pool')
  ? 'pool'
  : process.argv.includes('--batch')
    ? 'batch'
    : 'batch';

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
    // 1) 拼接所有 __next_f.push 片段
    const chunks = [];
    const re = /self\.__next_f\.push\(\[1,\s*("(?:\\.|[^"\\])*")\s*\]\)/g;
    let m;
    while ((m = re.exec(htmlText)) !== null) chunks.push(JSON.parse(m[1]));
    const lines = chunks.join('').split('\n');
  
    // 2) 逐行去掉 hexId 前缀后解析，跳过 I[...] 引用行
    const objects = [];
    const seen = new Set();
    for (const line of lines) {
      const body = line.slice(line.indexOf(':') + 1);
      if (!body.startsWith('[')) continue;
      let value;
      try {
        value = JSON.parse(body);
      } catch {
        continue; // 含裸 $ 标记的行不完整，跳过
      }
      // 3) 递归遍历，收集符合特征的数据对象
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
            return; // 命中的对象整体视为数据，不深入其子结构
          }
          Object.values(v).forEach(walk);
        }
      };
      walk(value);
    }
    return objects;
  }

  /** 从详情页 RSC 中解析匹配 slug 的 startup；找不到返回 null。 */
export function parseStartupDetailFromHtml(html, slug) {
    const found = extractRscData(html, [
      { key: 'self', test: (o) => o.startup && typeof o.startup === 'object' },
    ]);
    const startup = found.find((o) => o.startup?.slug === slug)?.startup;
    return startup ? enrichStartup(startup) : null;
  }


async function scrapeStartup(slug, index, total) {
    const url = `${BASE_URL}/startup/${slug}`;
    const fetchStarted = performance.now();
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'text/html,application/xhtml+xml',
          'Accept-Language': 'en-US,en;q=0.9',
        }
      });
      
      if (!res.ok) {
        console.log(`   [${index + 1}/${total}] ⚠️  ${slug}: HTTP ${res.status}`);
        return null;
      }
      
      const html = await res.text();
      
      const fetchMs = performance.now() - fetchStarted;
      const parseStarted = performance.now();
      const startup = parseStartupDetailFromHtml(html, slug);
      const parseMs = performance.now() - parseStarted;
      console.log(`   [${index + 1}/${total}] ✓ ${slug} fetchTime: ${fetchMs.toFixed(1)}ms, parseTime: ${parseMs.toFixed(1)}ms`);
      return { startup, fetchMs, parseMs };
    } catch (err) {
      console.log(`   [${index + 1}/${total}] ✗ ${slug}: ${err.message}`);
      return null;
    }
  }

  function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

/**
 * 现有方式：每批 BATCH_SIZE 个 Promise.all，最慢的那个堵整组。
 * 组间再 sleep(DELAY_MS)。
 */
async function scrapeWithBatch(slugs) {
  const startups = [];
  let failures = 0;

  for (let i = 0; i < slugs.length; i += BATCH_SIZE) {
    const batch = slugs.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(
      batch.map((slug, j) => scrapeStartup(slug, i + j, slugs.length))
    );
    for (const item of results) {
      if (item) {
        startups.push(item);
      } else {
        failures++;
      }
    }
    if (i + BATCH_SIZE < slugs.length) await sleep(DELAY_MS);
  }

  return { startups, failures };
}

/**
 * 优化方式：任务池，不用 Promise.all。
 * 在途数 < BATCH_SIZE 就立刻发下一个；某个结束再补一个。
 * 全部完成（cursor 走完且 inFlight === 0）才收口。
 * 结果按 slug 原顺序回填，方便和 batch 模式对比输出。
 */
function scrapeWithPool(slugs) {
  const slots = new Array(slugs.length);
  let cursor = 0;
  let inFlight = 0;

  return new Promise((resolve) => {
    function finish() {
      const startups = [];
      let failures = 0;
      for (const item of slots) {
        if (item) startups.push(item);
        else failures++;
      }
      resolve({ startups, failures });
    }

    function launch() {
      while (inFlight < BATCH_SIZE && cursor < slugs.length) {
        const i = cursor++;
        inFlight++;
        scrapeStartup(slugs[i], i, slugs.length)
          .then((item) => {
            slots[i] = item;
          })
          .catch((err) => {
            console.log(`   [${i + 1}/${slugs.length}] ✗ ${slugs[i]}: ${err.message}`);
            slots[i] = null;
          })
          .finally(() => {
            inFlight--;
            if (cursor < slugs.length) {
              launch();
            } else if (inFlight === 0) {
              finish();
            }
          });
      }

      if (slugs.length === 0) finish();
    }

    launch();
  });
}

function writeOutput(filePath, data) {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, JSON.stringify(data, null, 2), 'utf8');
  }

  // ─── MAIN ───
async function main() {

    const startTime = Date.now();
      // Step 1: Collect ALL slugs
  const slugs = data.map(item => item.slug);
  
  console.log(`\n[2/3] Scraping ${slugs.length} startup detail pages...`);
  console.log(`   mode=${CONCURRENCY_MODE}  concurrency=${BATCH_SIZE}${CONCURRENCY_MODE === 'batch' ? `  delay=${DELAY_MS}ms` : ''}\n`);

  const { startups, failures } = CONCURRENCY_MODE === 'pool'
    ? await scrapeWithPool(slugs)
    : await scrapeWithBatch(slugs);
    const wallSec = (Date.now() - startTime) / 1000;
    const jsonData = {
        startups: startups.map(item => item.startup),
    }
    
    const outputPath = `${CONCURRENCY_MODE === 'pool' ? 'pool' : 'batch'}.json`;
    writeOutput(outputPath, jsonData);
    console.log(`\n[3/3] Output written to ${outputPath}\n`);
    console.log(`\n🎉 All done in ${wallSec.toFixed(1)}s  (mode=${CONCURRENCY_MODE})\n`);
    console.log(`📊 Success: ${startups.length}/${slugs.length}  failed: ${failures}`);
    console.log(`⏱️ Wall clock: ${wallSec.toFixed(1)}s`);
    console.log(`⏱️ Total fetch time (sum): ${((startups.reduce((acc, curr) => acc + curr.fetchMs, 0) / 1000).toFixed(1))}s`);
    console.log(`⏱️ Total parse time (sum): ${((startups.reduce((acc, curr) => acc + curr.parseMs, 0) / 1000).toFixed(1))}s`);
    console.log(`\n对比另一模式：node main.mjs ${CONCURRENCY_MODE === 'pool' ? '--batch' : '--pool'}`);
}

main().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
  });
