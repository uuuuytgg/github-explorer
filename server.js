// GitHub Explorer v2 — 爬虫 + AI 后端
// 1) 爬取 github.com/trending（无需认证，无速率限制）
// 2) 调用 Kimi AI API 生成中文简介
//
// 运行: node server.js
// 访问: http://localhost:3457

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');
const cheerio = require('cheerio');
const fetch = require('node-fetch');

const PORT = 3457;

// ══════════════════════════════════════════
// ⚙️ 配置区
// ══════════════════════════════════════════

/**
 * ┌─────────────────────────────┐
 * │  👇 在这里粘贴你的 Kimi API Key │
 * │    格式: sk-xxxxxxxxxxxx     │
 * └─────────────────────────────┘
 */
const KIMI_API_KEY = 'sk-kimi-Srjh1I9pk4adQ2MdTM4oZEm8RJEwl2Jpsu68TUHRIkOdw3b20LyoZFHpWUlVFWIR';

// 缓存: 爬取数据有效期 (毫秒)
const CACHE_TTL = 10 * 60 * 1000; // 10 分钟
// 缓存: AI 描述有效期 (更长，避免重复调用)
const AI_CACHE_TTL = 30 * 60 * 1000; // 30 分钟

// ══════════════════════════════════════════
// 🗄️ 内存缓存
// ══════════════════════════════════════════
const scrapeCache = new Map(); // key → { data, ts }
const aiCache = new Map();      // repoKey → { zhDesc, ts }

function getCached(key, ttl) {
  const entry = scrapeCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > ttl) { scrapeCache.delete(key); return null; }
  return entry.data;
}

function setCache(key, data) {
  scrapeCache.set(key, { data, ts: Date.now() });
}

// ══════════════════════════════════════════
// 🕷️ 爬虫模块 — 抓取 GitHub Trending
// ══════════════════════════════════════════

/**
 * 用 node-fetch 抓取 HTML，用 cheerio 解析
 * 目标: https://github.com/trending?since=daily (以及分类页)
 */
async function fetchPage(urlStr) {
  const res = await fetch(urlStr, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml',
      'Accept-Language': 'en-US,en;q=0.9,zh-CN;q=0.8',
    },
  });
  return res.text();
}

/** 解析 trending 页面 → 结构化数据数组 */
function parseTrending(html) {
  const $ = cheerio.load(html);
  const repos = [];

  $('.Box-row').each((_, el) => {
    const $row = $(el);

    // Repo name — h2 > a
    const $link = $row.find('h2 a[href^="/"]');
    const href = ($link.attr('href') || '').trim();
    if (!href) return;
    const fullName = href.replace(/^\//, '').replace(/\/$/, '');
    // Clean up text like "oven-sh /      bun"
    const rawText = $link.text().replace(/\s+/g, ' ').trim();
    const parts = rawText.split('/').map(s => s.trim());
    if (parts.length < 2) return;
    const owner = parts[0];
    const name = parts[1];

    // Description — <p> tag is the primary selector now
    let desc = $row.find('p').first().text().trim();
    if (!desc) {
      // fallback: try other description patterns
      desc = $row.find('.col-9.text-gray.my-1, .text-gray.text-normal, [class*="description"]').first().text().trim();
    }

    // Stars (total)
    const starText = $row.find('a[href*="/stargazers"]').text().trim()
                 || $row.find('a[id*="stars"], .Link--muted.d-inline-block.mr-3').first().text().trim();
    const stars = parseStarNum(starText);

    // Forks
    const forkText = $row.find('a[href*="/forks"]').text().trim()
                 || $row.find('.d-inline-block.mr-3 a[href*="forks"]').text().trim();
    const forks = parseNum(forkText);

    // Today's stars growth
    const todayEl = $row.find('span.d-inline-block.float-sm-right');
    const todayGrowth = todayEl ? $(todayEl).text().trim() : '';
    const todayStars = parseGrowth(todayGrowth);

    // Language
    const lang = $row.find('[itemprop="programmingLanguage"]').text().trim();

    // Topics (trending page might not have these)
    const topics = [];
    $row.find('.topic-tag, .topic-tag-link').each((i, t) => topics.push($(t).text().trim()));

    // Avatar URL
    const avatarUrl = `https://avatars.githubusercontent.com/${encodeURIComponent(owner)}?s=80`;

    repos.push({
      owner,
      name,
      fullName,
      url: `https://github.com/${fullName}`,
      description: desc,
      stars,
      forks,
      todayStars,
      language: lang || undefined,
      topics,
      avatarUrl,
      source: 'trending',
    });
  });

  return repos;
}

function parseStarNum(s) {
  s = s.replace(/,/g, '');
  if (/(\d+\.?\d*)k/i.test(s)) return Math.round(parseFloat(RegExp.$1) * 1000);
  const n = parseInt(s, 10);
  return isNaN(n) ? 0 : n;
}

function parseNum(s) {
  s = s.replace(/,/g, '');
  if (/(\d+\.?\d*)[km]/i.test(s)) {
    const m = parseFloat(RegExp.$1);
    return /m/i.test(RegExp.$2) ? Math.round(m * 1000000) : Math.round(m * 1000);
  }
  const n = parseInt(s, 10);
  return isNaN(n) ? 0 : n;
}

function parseGrowth(s) {
  s = s.replace(/[,+\s]/g, '');
  if (/(\d+\.?\d*)\s*(today|today)/i.test(s)) return Math.round(parseFloat(RegExp.$1));
  if (/(\d+\.?\d*)k/i.test(s)) return Math.round(parseFloat(RegExp.$1) * 1000);
  const n = parseInt(s, 10);
  return isNaN(n) ? 0 : n;
}

// 各板块对应的 GitHub Trending 分类 URL
const CATEGORY_URLS = {
  trending: 'https://github.com/trending?since=daily',
  newest:   'https://github.com/trending?since=weekly',
  ai:       'https://github.com/trending/artificial-intelligence?since=daily',
  design:   'https://github.com/trending/design-systems?since=weekly', // fallback to general
  tools:    'https://github.com/trending/devops-tools?since=daily',    // fallback to general
  mobile:   'https://github.com/trending/mobile-development?since=daily',
  security: 'https://github.com/trending/cyber-security?since=weekly',
};

// 备用 URL（如果分类不存在则回退到通用）
const FALLBACK_URLS = {
  design: 'https://github.com/trending?since=weekly',
  tools:  'https://github.com/trending?since=daily',
};

/** 爬取指定分类 */
async function scrapeCategory(category) {
  const cacheKey = 'cat_' + category;
  const cached = getCached(cacheKey, CACHE_TTL);
  if (cached) return cached;

  let targetUrl = CATEGORY_URLS[category] || CATEGORY_URLS.trending;
  
  try {
    const html = await fetchPage(targetUrl);
    const repos = parseTrending(html);
    
    if (repos.length === 0 && FALLBACK_URLS[category]) {
      // 分类页面可能没有内容，回退到通用
      const html2 = await fetchPage(FALLBACK_URLS[category]);
      const repos2 = parseTrending(html2);
      
      // 如果有 AI 关键词过滤
      if (['ai','design','tools','security'].includes(category)) {
        setCache(cacheKey, filterByCategory(repos2, category));
        return filterByCategory(repos2, category);
      }
      setCache(cacheKey, repos2);
      return repos2;
    }

    setCache(cacheKey, repos);
    return repos;
  } catch (err) {
    console.error(`[爬虫] ${category} 失败:`, err.message);
    throw err;
  }
}

/** 对通用 trending 数据按关键词做二次筛选 */
function filterByCategory(repos, category) {
  const KEYWORDS = {
    ai:       ['ai', 'llm', 'machine-learning', 'deep-learning', 'neural', 'transformer', 'gpt', 'openai', 'diffusion', 'stable-diffusion', 'langchain', 'agent', 'chatbot', 'nlp', 'pytorch', 'tensorflow'],
    design:   ['design', 'ui-kit', 'component', 'tailwindcss', 'shadcn', 'radix', 'chakra', 'material', 'ant-design', 'element', 'vuetify', 'bootstrap', 'figma', 'sketch', 'theme', 'css', 'animation'],
    tools:    ['cli', 'tool', 'devop', 'docker', 'k8s', 'terraform', 'ansible', 'monitoring', 'log', 'debug', 'terminal', 'shell', 'automation', 'workflow', 'ci-cd', 'git', 'sdk', 'api', 'proxy'],
    mobile:   ['react-native', 'flutter', 'android', 'ios', 'swiftui', 'jetpack', 'compose', 'expo', 'ionic', 'cordova', 'cross-platform', 'mobile', 'appkit'],
    security:  ['security', 'cyber', 'ctf', 'hack', 'penetration', 'exploit', 'vulnerability', 'crypto', 'encryption', 'firewall', 'ids', 'ips', 'malware', 'forensic', 'red-team'],
  };
  const kw = KEYWORDS[category] || [];
  return repos.filter(r => {
    const text = `${r.name} ${r.description} ${r.language || ''}`.toLowerCase();
    return kw.some(k => text.includes(k));
  });
}

// ══════════════════════════════════════════
// 🤖 AI 模块 — Kimi 中文简介生成
// ══════════════════════════════════════════

async function callKimi(prompt) {
  if (!KIMI_API_KEY) {
    throw new Error('KIMI_API_KEY 未配置！请在 server.js 中填入你的 API Key。');
  }

  const res = await fetch('https://api.moonshot.cn/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${KIMI_API_KEY}`,
    },
    body: JSON.stringify({
      model: 'moonshot-v1-8k',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.4,
      max_tokens: 150,
    }),
  });

  if (!res.ok) {
    const errBody = await res.json().catch(() => ({}));
    throw new Error(`Kimi API ${res.status}: ${(errBody.error?.message || errBody.message || res.statusText)}`);
  }

  const data = await res.json();
  const content = data.choices?.[0]?.message?.content?.trim() || '';
  // 清理可能的 markdown 标记
  return content.replace(/^["'`]|\n|["'`]$/g, '');
}

/** 为单个项目生成中文简介 */
async function getAiDescription(repo) {
  const cacheKey = `${repo.fullName}_${repo.description}`;
  const cached = aiCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < AI_CACHE_TTL) {
    return cached.zhDesc;
  }

  const prompt = `请用简洁的中文（不超过80字）介绍以下开源项目，直接输出中文描述，不要加任何前缀或格式：

项目名: ${repo.fullName}
原始描述: ${repo.description || '(无)'}
编程语言: ${repo.language || '未知'}
今日新增 Star: ${repo.todayStars}
标签: ${(repo.topics||[]).join(', ')}`;

  try {
    const zhDesc = await callKimi(prompt);
    aiCache.set(cacheKey, { zhDesc, ts: Date.now() });
    return zhDesc || repo.description || '暂无描述';
  } catch (err) {
    console.error(`[AI] ${repo.fullName} 简介生成失败:`, err.message);
    return repo.description || 'AI 生成失败';
  }
}

/** 批量生成中文简介（并发控制，最多同时 5 个） */
async function batchGenerateDescriptions(repos) {
  if (!KIMI_API_KEY) {
    // 没有 key 时返回简单翻译
    return repos.map(r => ({ ...r, zhDesc: r.description || '暂无描述' }));
  }

  const BATCH_SIZE = 5;
  const results = [...repos];
  
  for (let i = 0; i < results.length; i += BATCH_SIZE) {
    const batch = results.slice(i, i + BATCH_SIZE);
    await Promise.all(batch.map(async (r) => {
      r.zhDesc = await getAiDescription(r);
    }));
    // 小延迟避免触发速率限制
    if (i + BATCH_SIZE < results.length) {
      await sleep(500);
    }
  }

  return results;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ══════════════════════════════════════════
// 🌐 HTTP 服务器 & 路由
// ══════════════════════════════════════════

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.json': 'application/json',
  '.png':  'image/png',
  '.svg':  'image/svg+xml',
};

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;

  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  try {
    // ─── API: 爬取分类数据 ───
    if (pathname.startsWith('/api/scrape/')) {
      const category = pathname.replace('/api/scrape/', '') || 'trending';
      const useAI = parsed.query.ai === 'true';
      
      console.log(`[API] 爬取分类: ${category}, AI=${useAI}`);
      const repos = await scrapeCategory(category);

      if (useAI && repos.length > 0) {
        const enriched = await batchGenerateDescriptions(repos.slice(0, 12)); // AI 只处理前12个
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(enriched));
      } else {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(repos));
      }
      return;
    }

    // ─── API: 健康检查 ───
    if (pathname === '/api/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        status: 'ok',
        kimi: !!KIMI_API_KEY,
        categories: Object.keys(CATEGORY_URLS),
        uptime: process.uptime(),
      }));
      return;
    }

    // ─── 静态文件服务 ───
    let filePath = path.join(__dirname, pathname === '/' ? 'index.html' : pathname);
    const ext = path.extname(filePath);

    fs.readFile(filePath, async (err, data) => {
      if (err) {
        // SPA fallback
        fs.readFile(path.join(__dirname, 'index.html'), (e2, d2) => {
          if (e2) { res.writeHead(404); res.end('Not found'); return; }
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(d2);
        });
        return;
      }
      res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'text/plain' });
      res.end(data);
    });

  } catch (err) {
    console.error('[Server Error]', err.message);
    res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: err.message }));
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('');
  console.log('╔══════════════════════════════════════╗');
  console.log('║  🚀 GitHub Explorer v2 已启动          ║');
  console.log(`║  📍 http://localhost:${PORT}              ║`);
  console.log(`║  🤖 AI: ${KIMI_API_KEY ? '✅ 已配置' : '❌ 未配置'}                    ║`);
  console.log('╚══════════════════════════════════════╝');
  console.log('');

  if (!KIMI_API_KEY) {
    console.warn('⚠️  警告: Kimi API Key 未配置!');
    console.warn('   请在 server.js 顶部找到 KIMI_API_KEY 并填入你的密钥');
    console.warn('   不影响基础功能，但中文 AI 简介将不可用\n');
  }
});
