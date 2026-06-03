// GitHub Explorer local dev server.
// Run: node server.js, then visit http://localhost:3457

const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const cheerio = require('cheerio');
const fetch = require('node-fetch');

const PORT = Number(process.env.PORT || 3457);
const AI_API_KEY = process.env.AI_API_KEY || '';
const AI_API_URL = process.env.AI_API_URL || 'https://api.moonshot.cn/v1/chat/completions';
const AI_MODEL = process.env.AI_MODEL || 'moonshot-v1-8k';
const ROOT_DIR = __dirname;
const CACHE_TTL = 10 * 60 * 1000;
const AI_CACHE_TTL = 30 * 60 * 1000;

const scrapeCache = new Map();
const aiCache = new Map();

const CATEGORY_URLS = {
  trending: 'https://github.com/trending?since=daily',
  newest: 'https://github.com/trending?since=weekly',
  ai: 'https://github.com/trending/artificial-intelligence?since=daily',
  design: 'https://github.com/trending/design-systems?since=weekly',
  tools: 'https://github.com/trending/devops-tools?since=daily',
  mobile: 'https://github.com/trending/mobile-development?since=daily',
  security: 'https://github.com/trending/cyber-security?since=weekly',
};

const FALLBACK_URLS = {
  design: 'https://github.com/trending?since=weekly',
  tools: 'https://github.com/trending?since=daily',
};

const CATEGORY_KEYWORDS = {
  ai: ['ai', 'llm', 'machine-learning', 'deep-learning', 'neural', 'transformer', 'gpt', 'openai', 'diffusion', 'langchain', 'agent', 'chatbot', 'nlp', 'pytorch', 'tensorflow'],
  design: ['design', 'ui-kit', 'component', 'tailwindcss', 'shadcn', 'radix', 'chakra', 'material', 'ant-design', 'figma', 'theme', 'css', 'animation'],
  tools: ['cli', 'tool', 'devop', 'docker', 'k8s', 'terraform', 'monitoring', 'log', 'debug', 'terminal', 'shell', 'automation', 'workflow', 'git', 'sdk', 'api', 'proxy'],
  mobile: ['react-native', 'flutter', 'android', 'ios', 'swiftui', 'jetpack', 'compose', 'expo', 'ionic', 'cross-platform', 'mobile'],
  security: ['security', 'cyber', 'ctf', 'hack', 'penetration', 'exploit', 'vulnerability', 'crypto', 'encryption', 'firewall', 'malware', 'forensic'],
};

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

function getCached(key, ttl) {
  const entry = scrapeCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > ttl) {
    scrapeCache.delete(key);
    return null;
  }
  return entry.data;
}

function setCache(key, data) {
  scrapeCache.set(key, { data, ts: Date.now() });
}

async function fetchPage(targetUrl) {
  const res = await fetch(targetUrl, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml',
      'Accept-Language': 'en-US,en;q=0.9,zh-CN;q=0.8',
      'Cache-Control': 'no-cache',
    },
  });

  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

function parseNum(text = '') {
  const cleaned = String(text).replace(/<[^>]+>/g, '').replace(/,/g, '').trim();
  const unitMatch = cleaned.match(/(\d+\.?\d*)\s*([km])/i);
  if (unitMatch) {
    const value = Number.parseFloat(unitMatch[1]);
    return unitMatch[2].toLowerCase() === 'm' ? Math.round(value * 1000000) : Math.round(value * 1000);
  }
  const n = Number.parseInt(cleaned, 10);
  return Number.isNaN(n) ? 0 : n;
}

function parseGrowth(text = '') {
  const cleaned = String(text).replace(/[,+\s]/g, '');
  const kMatch = cleaned.match(/(\d+\.?\d*)k/i);
  if (kMatch) return Math.round(Number.parseFloat(kMatch[1]) * 1000);
  const n = Number.parseInt(cleaned, 10);
  return Number.isNaN(n) ? 0 : n;
}

function parseTrending(html) {
  const $ = cheerio.load(html);
  const repos = [];

  $('.Box-row').each((_, el) => {
    const $row = $(el);
    const $link = $row.find('h2 a[href^="/"]').first();
    const href = ($link.attr('href') || '').trim().replace(/^\/|\/$/g, '');
    if (!href || !href.includes('/')) return;

    const rawText = $link.text().replace(/\s+/g, ' ').trim();
    const [ownerFromText, nameFromText] = rawText.split('/').map(s => s.trim());
    const [ownerFromHref, nameFromHref] = href.split('/');
    const owner = ownerFromText || ownerFromHref;
    const name = nameFromText || nameFromHref;
    if (!owner || !name) return;

    const description = $row.find('p').first().text().replace(/\s+/g, ' ').trim();
    const starText = $row.find('a[href*="/stargazers"]').first().text().trim();
    const forkText = $row.find('a[href*="/forks"]').first().text().trim();
    const todayText = $row.find('span.d-inline-block.float-sm-right').first().text().trim();
    const language = $row.find('[itemprop="programmingLanguage"]').first().text().trim();
    const topics = [];
    $row.find('.topic-tag, .topic-tag-link').each((i, t) => {
      const topic = $(t).text().trim();
      if (topic) topics.push(topic);
    });

    repos.push({
      owner,
      name,
      fullName: `${owner}/${name}`,
      url: `https://github.com/${owner}/${name}`,
      avatarUrl: `https://github.com/${owner}.png`,
      description,
      stars: parseNum(starText),
      forks: parseNum(forkText),
      todayStars: parseGrowth(todayText),
      language,
      topics,
      source: 'trending',
    });
  });

  return repos;
}

function filterByCategory(repos, category) {
  const keywords = CATEGORY_KEYWORDS[category] || [];
  if (keywords.length === 0) return repos;

  return repos.filter(repo => {
    const text = [repo.name, repo.description, repo.language, repo.topics.join(' ')].join(' ').toLowerCase();
    return keywords.some(keyword => text.includes(keyword));
  });
}

async function scrapeCategory(category) {
  const cacheKey = `category:${category}`;
  const cached = getCached(cacheKey, CACHE_TTL);
  if (cached) return cached;

  const targetUrl = CATEGORY_URLS[category] || CATEGORY_URLS.trending;
  let repos = parseTrending(await fetchPage(targetUrl));

  if (repos.length === 0 && FALLBACK_URLS[category]) {
    repos = parseTrending(await fetchPage(FALLBACK_URLS[category]));
  }

  repos = filterByCategory(repos, category);
  setCache(cacheKey, repos);
  return repos;
}

async function callAI(prompt) {
  if (!AI_API_KEY) throw new Error('AI_API_KEY is not configured.');

  const res = await fetch(AI_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${AI_API_KEY}`,
    },
    body: JSON.stringify({
      model: AI_MODEL,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.4,
      max_tokens: 150,
    }),
  });

  if (!res.ok) throw new Error(`AI API ${res.status}`);
  const data = await res.json();
  return (data.choices?.[0]?.message?.content || '').trim().replace(/^["'`]|["'`]$/g, '');
}

async function describeRepo(repo) {
  const cacheKey = `${repo.fullName}:${repo.description}`;
  const cached = aiCache.get(cacheKey);
  if (cached && Date.now() - cached.ts < AI_CACHE_TTL) return cached.value;

  const prompt = `请用简洁中文介绍这个 GitHub 开源项目，不超过80字，只输出简介文本。\n\n项目名：${repo.fullName}\n原始描述：${repo.description || '无'}\n语言：${repo.language || '未知'}`;
  const value = await callAI(prompt);
  aiCache.set(cacheKey, { value, ts: Date.now() });
  return value;
}

async function enrichWithAI(repos) {
  if (!AI_API_KEY) return repos.map(repo => ({ ...repo, zhDesc: repo.description || '暂无描述' }));

  const result = [...repos];
  for (let i = 0; i < result.length; i += 5) {
    const batch = result.slice(i, i + 5);
    await Promise.all(batch.map(async repo => {
      try {
        repo.zhDesc = await describeRepo(repo);
      } catch {
        repo.zhDesc = repo.description || '暂无描述';
      }
    }));
  }
  return result;
}

function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function resolveStaticPath(pathname) {
  let decodedPathname;
  try {
    decodedPathname = decodeURIComponent(pathname);
  } catch {
    return { error: 'bad-request' };
  }

  const requestedPath = decodedPathname === '/' ? 'index.html' : decodedPathname.replace(/^\/+/, '');
  const filePath = path.resolve(ROOT_DIR, requestedPath);
  const root = ROOT_DIR.toLowerCase();
  const file = filePath.toLowerCase();

  if (file !== root && !file.startsWith(root + path.sep)) return { error: 'forbidden' };
  return { filePath };
}

function serveStatic(pathname, res) {
  const resolved = resolveStaticPath(pathname);
  if (resolved.error === 'bad-request') {
    res.writeHead(400);
    res.end('Bad request');
    return;
  }
  if (resolved.error === 'forbidden') {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(resolved.filePath, (err, data) => {
    if (err) {
      fs.readFile(path.join(ROOT_DIR, 'index.html'), (fallbackErr, fallbackData) => {
        if (fallbackErr) {
          res.writeHead(404);
          res.end('Not found');
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(fallbackData);
      });
      return;
    }

    const ext = path.extname(resolved.filePath);
    res.writeHead(200, { 'Content-Type': MIME_TYPES[ext] || 'text/plain; charset=utf-8' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname || '/';

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  try {
    if (pathname.startsWith('/api/scrape/')) {
      const category = pathname.replace('/api/scrape/', '') || 'trending';
      const repos = await scrapeCategory(category);
      sendJson(res, 200, parsed.query.ai === 'true' ? await enrichWithAI(repos.slice(0, 12)) : repos);
      return;
    }

    if (pathname === '/api/health') {
      sendJson(res, 200, {
        status: 'ok',
        aiConfigured: Boolean(AI_API_KEY),
        categories: Object.keys(CATEGORY_URLS),
        uptime: process.uptime(),
      });
      return;
    }

    serveStatic(pathname, res);
  } catch (error) {
    sendJson(res, 500, { error: error.message });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`GitHub Explorer dev server: http://localhost:${PORT}`);
  if (!AI_API_KEY) {
    console.warn('AI_API_KEY is not configured; AI descriptions will fall back to source descriptions.');
  }
});
