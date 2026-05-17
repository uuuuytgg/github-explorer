#!/usr/bin/env node
/**
 * GitHub Explorer — 离线爬虫 + AI 翻译脚本
 * 
 * 用途: GitHub Actions 定时运行，抓取 GitHub Trending HTML，
 *       调用 AI API 生成中文简介，输出静态 JSON 到 data/ 目录。
 * 
 * 运行: node scripts/scrape.js
 * 环境变量:
 *   AI_API_KEY  — AI API 密钥（必需）
 *   AI_API_URL  — AI API 端点 (默认 Kimi)
 *   AI_MODEL    — 模型名 (默认 moonshot-v1-8k)
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

// ══════════════════════════════════════════
// 配置
// ══════════════════════════════════════════

const DATA_DIR = path.join(__dirname, '..', 'data');
const AI_API_KEY = process.env.AI_API_KEY || '';
const AI_API_URL = process.env.AI_API_URL || 'https://api.moonshot.cn/v1/chat/completions';
const AI_MODEL = process.env.AI_MODEL || 'moonshot-v1-8k';

// AI 并发控制
const AI_CONCURRENCY = 6;
const AI_TIMEOUT_MS = 25000;
const AI_MAX_TOKENS = 120;

// 分类定义
const CATEGORIES = {
  trending: {
    url: 'https://github.com/trending?since=daily',
    label: '热门趋势',
    icon: '🔥',
    priority: 1,
  },
  newest: {
    url: 'https://github.com/trending?since=weekly',
    label: '本周新星',
    icon: '🆕',
    priority: 2,
  },
  ai: {
    url: 'https://github.com/trending?since=daily',
    label: 'AI & LLM',
    icon: '🤖',
    keywords: ['ai','llm','gpt','openai','claude','diffusion','agent','chatbot','langchain','langgraph','rag','embedding','vector','pytorch','tensorflow','transformer','neural','deep-learning','machine-learning','stable-diffusion','sora','veo','gen-ai','generative','nlp','llama','mistral','gemini','copilot','autogen','crewai','composio','mlx','whisper','tts','stt','voice','speech','multimodal','openai','anthropic','ollama','fine-tune','rlhf','sft','inference','pretrained','model-hub','huggingface','jupyter'],
    priority: 1,
  },
  design: {
    url: 'https://github.com/trending?since=weekly',
    label: '设计系统',
    icon: '🎨',
    keywords: ['design','ui','ux','interface','frontend','component-library','tailwind','shadcn','radix','chakra','material design','ant-design','figma','theme','template','dashboard','style','animation','css','canvas','svg','icon','typography','color','palette','responsive','layout','storybook','motion','framer'],
    priority: 3,
  },
  tools: {
    url: 'https://github.com/trending?since=daily',
    label: '开发工具',
    icon: '🛠',
    keywords: ['cli','terminal','shell','runtime','bundler','package-manager','devops','docker','k8s','kubernetes','terraform','monitoring','logging','debug','profiler','workflow','ci/cd','git','github-actions','sdk','api','proxy','server','framework','engine','platform','analytics','pipeline','automation','scaffold','config','migration','generator','formatter','linter','compiler','transpiler','test-runner','coverage','benchmark','cms','publishing','newsletter','subscription'],
    priority: 3,
  },
  mobile: {
    url: 'https://github.com/trending?since=daily',
    label: '移动开发',
    icon: '📱',
    keywords: ['mobile','android','ios','iphone','ipad','flutter','react-native','swiftui','jetpack-compose','expo','capacitor','kotlin','swift','dart','watchos','tvos','smartwatch','wearable','cross-platform','pwa','hybrid-app','play-store','app-store','material-you','adaptive'],
    priority: 3,
  },
  security: {
    url: 'https://github.com/trending?since=daily',
    label: '安全研究',
    icon: '🔐',
    keywords: ['security','auth','authentication','authorization','oauth','jwt','token','ssl','tls','certificate','encryption','decrypt','cipher','crypto','cryptography','hash','firewall','malware','antivirus','ctf','capture-the-flag','penetration-test','pentest','exploit','vulnerability','cve','zeroday','zero-day','patch','forensic','cyber','risk','compliance','audit','intrusion','detection','ids','ips','waf','scan','scanner','privacy','gdpr','sandbox','isolate','privilege','escalation','phishing','ransomware','ddos','mitm','reverse-engineering','obfuscation'],
    priority: 3,
  },
};

// ══════════════════════════════════════════
// HTTP 工具
// ══════════════════════════════════════════

function fetchHTML(urlStr) {
  return new Promise((resolve, reject) => {
    const get = urlStr.startsWith('https') ? https.get : http.get;
    const req = get(urlStr, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
        'Accept-Language': 'en-US,en;q=0.9,zh-CN;q=0.8',
        'Cache-Control': 'no-cache',
      },
      timeout: 20000,
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        fetchHTML(res.headers.location).then(resolve).catch(reject);
        return;
      }
      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => resolve(body));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
  });
}

function fetchJSON(urlStr, body) {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(urlStr);
    const mod = urlObj.protocol === 'https:' ? https : http;
    const postData = JSON.stringify(body);
    const req = mod.request(urlObj, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${AI_API_KEY}`,
        'Content-Length': Buffer.byteLength(postData),
      },
      timeout: AI_TIMEOUT_MS,
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve({ status: res.statusCode, body: JSON.parse(data) });
        } catch {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    req.write(postData);
    req.end();
  });
}

// ══════════════════════════════════════════
// HTML 解析（轻量级，基于正则 + 行解析）
// ══════════════════════════════════════════

function parseTrendingHTML(html) {
  const repos = [];
  
  // 按 Box-row 分割（支持 article 和 div）
  const sections = html.split(/<(?:article|div)[^>]*class="[^"]*Box-row[^"]*"/);
  const blocks = sections.slice(1);
  
  for (const block of blocks) {
    const repo = parseRepoBlock(block);
    if (repo && repo.fullName) {
      repos.push(repo);
    }
  }
  
  // 回退：匹配所有 h2 内的仓库链接
  if (repos.length === 0) {
    return parseTrendingFallback(html);
  }
  
  return repos;
}

function parseRepoBlock(block) {
  try {
    const h2Match = block.match(/<h2[^>]*>[\s\S]*?<a[^>]*href="\/([^"]+)"[^>]*>([\s\S]*?)<\/a>/);
    if (!h2Match) return null;
    
    const href = h2Match[1].trim().replace(/\/$/, '');
    const rawText = h2Match[2].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
    const parts = rawText.split('/').map(s => s.trim()).filter(Boolean);
    if (parts.length < 2) return null;
    
    const owner = parts[0];
    const name = parts[1];
    
    // 描述: 移除 h2 区域后，匹配第一个有实质内容的 p 标签
    const afterH2 = block.replace(/<h2[^>]*>[\s\S]*?<\/h2>/i, '');
    // 尝试 col-9 类名（GitHub Trending 的描述段落）
    let descMatch = afterH2.match(/<p[^>]*class="[^"]*col-9[^"]*"[^>]*>([\s\S]*?)<\/p>/);
    if (!descMatch) {
      // 回退：取第一个有内容的 p 标签，排除空洞的
      const pMatches = [...afterH2.matchAll(/<p[^>]*>([\s\S]*?)<\/p>/g)];
      descMatch = pMatches.find(m => {
        const text = m[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
        return text.length > 5 && !/^(Star|Fork|Today|\d)/i.test(text);
      }) || pMatches[0];
    }
    const desc = descMatch ? descMatch[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim() : '';
    
    let stars = 0;
    const starMatch = block.match(/\/stargazers[^"]*"[^>]*>([\s\S]*?)<\/a>/);
    if (starMatch) stars = parseNum(starMatch[1]);
    
    let forks = 0;
    const forkMatch = block.match(/\/forks[^"]*"[^>]*>([\s\S]*?)<\/a>/);
    if (forkMatch) forks = parseNum(forkMatch[1]);
    
    // 今日新增 Star: 更精确的匹配 + 合理性检查
    let todayStars = 0;
    const todayMatch = block.match(/float-sm-right[^>]*>\s*([\d,]+)\s*stars?\s*today[^<]*<\/span>/i);
    if (!todayMatch) {
      // 回退
      const alt = block.match(/float-sm-right[^>]*>([\s\S]*?)<\/span>/);
      if (alt) {
        const nums = alt[1].replace(/[^0-9]/g, '');
        todayStars = parseInt(nums, 10) || 0;
      }
    } else {
      todayStars = parseInt(todayMatch[1].replace(/,/g, ''), 10) || 0;
    }
    // 合理性检查: 单日增长不可能超过 100k
    if (todayStars > 100000) todayStars = 0;
    
    let language = '';
    const langMatch = block.match(/itemprop="programmingLanguage"[^>]*>([^<]+)</);
    if (langMatch) language = langMatch[1].trim();
    
    // Topics: 支持多种类名
    const topics = [];
    const topicRegex = /<a[^>]*(?:topic-tag-link|topic-tag)[^>]*>([^<]*)<\/a>/g;
    let tm;
    while ((tm = topicRegex.exec(block)) !== null) {
      const t = tm[1].trim();
      if (t && t.length < 30) topics.push(t);
    }
    
    return {
      fullName: `${owner}/${name}`,
      owner, name,
      description: desc,
      url: `https://github.com/${owner}/${name}`,
      avatarUrl: `https://github.com/${owner}.png`,
      stars, forks, todayStars,
      language,
      topics,
    };
  } catch {
    return null;
  }
}


function parseTrendingFallback(html) {
  const repos = [];
  const seen = new Set();
  const regex = /<h2[^>]*>[\s\S]*?<a[^>]*href="\/([^"/]+\/[^"/]+)"[^>]*>/g;
  let match;
  
  while ((match = regex.exec(html)) !== null) {
    const href = match[1].trim();
    if (seen.has(href)) continue;
    seen.add(href);
    
    const parts = href.split('/');
    if (parts.length < 2) continue;
    
    const pos = match.index;
    const context = html.substring(Math.max(0, pos - 500), Math.min(html.length, pos + 3000));
    
    const descMatch = context.match(/<p[^>]*>([\s\S]*?)<\/p>/);
    const desc = descMatch ? descMatch[1].replace(/<[^>]+>/g, '').trim() : '';
    
    let stars = 0;
    const starMatch = context.match(/\/stargazers[^"]*"[^>]*>([\s\S]*?)<\/a>/);
    if (starMatch) stars = parseNum(starMatch[1]);
    
    let forks = 0;
    const forkMatch = context.match(/\/forks[^"]*"[^>]*>([\s\S]*?)<\/a>/);
    if (forkMatch) forks = parseNum(forkMatch[1]);
    
    let todayStars = 0;
    const todayMatch = context.match(/float-sm-right[^>]*>([\s\S]*?)<\/span>/);
    if (todayMatch) {
      todayStars = parseInt(todayMatch[1].replace(/[^0-9]/g, '')) || 0;
    }
    
    let language = '';
    const langMatch = context.match(/itemprop="programmingLanguage"[^>]*>([^<]+)</);
    if (langMatch) language = langMatch[1].trim();
    
    repos.push({
      fullName: href,
      owner: parts[0],
      name: parts[1],
      description: desc,
      url: `https://github.com/${href}`,
      avatarUrl: `https://github.com/${parts[0]}.png`,
      stars, forks, todayStars,
      language,
      topics: [],
    });
  }
  
  return repos;
}

function parseNum(text) {
  const cleaned = text.replace(/<[^>]+>/g, '').replace(/[,+\s]/g, '').trim();
  if (/(\d+\.?\d*)[kK]/.test(cleaned)) return Math.round(parseFloat(RegExp.$1) * 1000);
  if (/(\d+\.?\d*)[mM]/.test(cleaned)) return Math.round(parseFloat(RegExp.$1) * 1000000);
  const n = parseInt(cleaned, 10);
  return isNaN(n) ? 0 : n;
}

// ══════════════════════════════════════════
// AI 翻译
// ══════════════════════════════════════════

async function callAI(repo) {
  const starsStr = repo.stars >= 1000 ? (repo.stars/1000).toFixed(1)+'k' : repo.stars;
  const prompt = `请用一句话（不超过50个字）为以下GitHub开源项目写一个中文简介，突出它的核心功能和用途。只输出简介文字本身，不要加任何格式、标题或解释。

项目名：${repo.fullName}
原始描述：${repo.description || '无'}
语言：${repo.language || '未知'}
⭐${starsStr}
${repo.topics && repo.topics.length ? '标签：' + repo.topics.join(', ') : ''}`;

  try {
    const { status, body } = await fetchJSON(AI_API_URL, {
      model: AI_MODEL,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: AI_MAX_TOKENS,
      temperature: 0.4,
    });
    
    if (status !== 200) {
      console.error(`  [AI] HTTP ${status}: ${JSON.stringify(body).substring(0,200)}`);
      return '';
    }
    
    const text = body.choices?.[0]?.message?.content || '';
    return text.trim().replace(/^["'""]|["'""]$/g, '');
  } catch (err) {
    console.error(`  [AI] ${repo.fullName}: ${err.message}`);
    return '';
  }
}

async function translateBatch(repos, concurrency) {
  if (!AI_API_KEY) {
    console.log('  ⚠️  未配置 AI_API_KEY，跳过翻译');
    return;
  }
  
  const toTranslate = repos.filter(r => 
    r.description && r.description.length > 10 && !r.zhDesc
  );
  
  if (toTranslate.length === 0) {
    console.log('  无需翻译');
    return;
  }
  
  console.log(`  翻译 ${toTranslate.length} 个项目 (并发=${concurrency})...`);
  
  const results = new Array(toTranslate.length);
  let idx = 0;
  
  async function worker() {
    while (idx < toTranslate.length) {
      const i = idx++;
      const repo = toTranslate[i];
      const zhDesc = await callAI(repo);
      results[i] = zhDesc;
      if (zhDesc) {
        repo.zhDesc = zhDesc;
        process.stdout.write('.');
      } else {
        process.stdout.write('x');
      }
    }
  }
  
  const workers = Array(Math.min(concurrency, toTranslate.length))
    .fill(null)
    .map(() => worker());
  
  await Promise.all(workers);
  console.log('');
}

// ══════════════════════════════════════════
// 关键词过滤
// ══════════════════════════════════════════

function filterByKeywords(repos, keywords) {
  if (!keywords || keywords.length === 0) return repos;
  const thresholds = { 3: 3, 2: 5, 1: 999 }; // 至少匹配几个关键词
  return repos.filter(r => {
    const text = [r.name, r.description, r.language || '', (r.topics||[]).join(' ')].join(' ').toLowerCase();
    let matches = 0;
    for (const kw of keywords) {
      const search = kw.toLowerCase();
      // 精确匹配或空格分隔的词匹配
      if (text.includes(search) || text.split(/[\s_-]+/).some(w => w.startsWith(search))) {
        matches++;
      }
    }
    return matches >= 1;
  });
}

// ══════════════════════════════════════════
// 主流程
// ══════════════════════════════════════════

async function main() {
  console.log('╔══════════════════════════════════════╗');
  console.log('║  GitHub Explorer — 离线数据生成     ║');
  console.log('╚══════════════════════════════════════╝');
  console.log('');
  console.log(`AI API: ${AI_API_KEY ? '✅ 已配置' : '❌ 未配置'}`);
  console.log(`模型: ${AI_MODEL}`);
  console.log('');
  
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  
  const allData = {};
  const entries = Object.entries(CATEGORIES);
  
  // Phase 1: 抓取
  console.log('📡 Phase 1: 抓取 GitHub Trending...\n');
  
  for (const [key, cfg] of entries) {
    process.stdout.write(`  [${cfg.icon} ${cfg.label}] ${cfg.url} ... `);
    try {
      const html = await fetchHTML(cfg.url);
      console.log(`✅ ${(html.length/1024).toFixed(0)}KB`);
      allData[key] = { html, cfg };
    } catch (err) {
      console.log(`❌ ${err.message}`);
      allData[key] = { html: '', cfg, error: err.message };
    }
  }
  
  // Phase 2: 解析
  console.log('\n🔍 Phase 2: 解析 HTML...\n');
  
  const categoryResults = {};
  let totalRepos = 0;
  
  for (const [key, { html, cfg }] of Object.entries(allData)) {
    if (!html) {
      categoryResults[key] = { repos: [], error: allData[key].error };
      continue;
    }
    
    let repos = parseTrendingHTML(html);
    
    if (cfg.keywords && repos.length > 0) {
      repos = filterByKeywords(repos, cfg.keywords);
    }
    
    const seen = new Set();
    repos = repos.filter(r => {
      if (seen.has(r.fullName)) return false;
      seen.add(r.fullName);
      return true;
    }).slice(0, 25);

    // Fallback: 如果关键词过滤后为 0，尝试从同 URL 的主力分类借
    if (repos.length === 0 && key !== 'trending' && key !== 'newest') {
      const mainKey = cfg.url.includes('since=weekly') ? 'newest' : 'trending';
      const mainResult = categoryResults[mainKey];
      if (mainResult && mainResult.repos && mainResult.repos.length > 0) {
        const filtered = filterByKeywords(mainResult.repos, cfg.keywords || []);
        if (filtered.length > 0) {
          repos = filtered.slice(0, 25);
          console.log(`    ↪ 回退: 从 ${mainKey} 借 ${repos.length} 个`);
        }
      }
    }
    
    categoryResults[key] = { repos };
    totalRepos += repos.length;
    console.log(`  [${cfg.icon} ${cfg.label}] ${repos.length} 个项目`);
  }
  
  console.log(`  总计: ${totalRepos} 个项目`);
  
  // Phase 3: AI 翻译（按优先级）
  console.log('\n🤖 Phase 3: AI 中文翻译...\n');
  
  if (AI_API_KEY) {
    const allRepos = [];
    for (const [key, { repos }] of Object.entries(categoryResults)) {
      if (!repos) continue;
      const priority = CATEGORIES[key]?.priority || 99;
      for (const repo of repos) {
        allRepos.push({ ...repo, _priority: priority, _category: key });
      }
    }
    allRepos.sort((a, b) => a._priority - b._priority);
    
    const seen = new Set();
    const uniqueRepos = allRepos.filter(r => {
      if (seen.has(r.fullName)) return false;
      seen.add(r.fullName);
      return true;
    }).slice(0, 50);
    
    await translateBatch(uniqueRepos, AI_CONCURRENCY);
    
    const transMap = {};
    for (const r of uniqueRepos) {
      if (r.zhDesc) transMap[r.fullName] = r.zhDesc;
    }
    for (const [key, { repos }] of Object.entries(categoryResults)) {
      if (!repos) continue;
      for (const repo of repos) {
        if (transMap[repo.fullName]) repo.zhDesc = transMap[repo.fullName];
      }
    }
  }
  
  // Phase 4: 写入 JSON
  console.log('\n💾 Phase 4: 写入 data/*.json...\n');
  
  const timestamp = new Date().toISOString();
  const manifest = {
    updated: timestamp,
    categories: {},
  };
  
  for (const [key, { repos, error }] of Object.entries(categoryResults)) {
    const cfg = CATEGORIES[key];
    const filePath = path.join(DATA_DIR, `${key}.json`);
    
    const payload = {
      category: key,
      label: cfg.label,
      icon: cfg.icon,
      updated: timestamp,
      count: repos ? repos.length : 0,
      repos: repos || [],
      error: error || null,
    };
    
    fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), 'utf-8');
    console.log(`  ✅ data/${key}.json (${repos ? repos.length : 0} 项目)`);
    
    manifest.categories[key] = {
      label: cfg.label,
      icon: cfg.icon,
      count: repos ? repos.length : 0,
    };
  }
  
  fs.writeFileSync(
    path.join(DATA_DIR, 'manifest.json'),
    JSON.stringify(manifest, null, 2),
    'utf-8'
  );
  console.log('  ✅ data/manifest.json');
  
  console.log('\n🎉 完成！');
  console.log(`  数据更新时间: ${timestamp}`);
  console.log(`  AI 翻译: ${AI_API_KEY ? '✅' : '❌ 未配置'}`);
}

main().catch(err => {
  console.error('\n❌ 致命错误:', err.message);
  process.exit(1);
});
