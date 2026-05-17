# GitHub Explorer · 开源项目发现

> 发现 GitHub 上最精彩的开源世界。离线优先架构，自动抓取 Trending 排行，AI 驱动的中文项目简介。

[![GitHub Pages](https://img.shields.io/badge/deployed-GitHub%20Pages-blue)](https://uuuuytgg.github.io/github-explorer/)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

## 在线地址

**[https://uuuuytgg.github.io/github-explorer/](https://uuuuytgg.github.io/github-explorer/)**

## 功能

- **7 大分类浏览**：热门趋势、本周新星、AI & LLM、设计系统、开发工具、移动开发、安全研究
- **AI 中文简介**：用一句话看懂每个项目的核心功能（需配置 API Key）
- **离线优先**：GitHub Actions 每 15 分钟预抓取数据，前端秒开
- **无外部依赖**：零 CDN 请求，使用系统字体栈，内联 SVG 图标
- **暗色/亮色主题**：Material Design 3 Monet 动态色彩系统

## 架构

```
 GitHub Trending       GitHub Actions (cron: */15)       data/*.json
 (服务端渲染 HTML)  ─── scrape.js 抓取+翻译 ───────→   (预计算静态JSON)
                                                              │
                                                      GitHub Pages
                                                     index.html ← JSON
                                                    (同源, 零延迟)
```

### 数据流

1. **GitHub Actions** 每 15 分钟用 `scripts/scrape.js` 抓取 github.com/trending
2. 抓取纯 HTML（无 API 限流），用正则解析出项目数据
3. 调用 AI API 生成中文简介（zhDesc 字段）
4. 输出静态 JSON 到 `data/` 目录，自动提交回仓库
5. **GitHub Pages** 托管前端，浏览器直接从同源加载 JSON（毫秒级）

当预计算 JSON 不可用时，前端自动回退到 CORS 代理实时抓取。

## 快速开始

```bash
# 克隆仓库
git clone https://github.com/uuuuytgg/github-explorer.git
cd github-explorer

# 启动本地服务器
node server.js

# 访问 http://localhost:3457
```

### 手动抓取数据

```bash
node scripts/scrape.js
```

### 配置 AI 翻译（可选）

1. 在 [GitHub 仓库 Settings > Secrets and variables > Actions](https://github.com/uuuuytgg/github-explorer/settings/secrets/actions) 添加 `AI_API_KEY`
2. 支持 Kimi / DeepSeek / OpenAI 兼容接口
3. 可选：通过 `AI_API_URL` 和 `AI_MODEL` 自定义模型

```bash
# 本地开发时通过环境变量传入
AI_API_KEY=sk-your-key-here node scripts/scrape.js
```

## 技术栈

| 组件 | 技术 |
|------|------|
| 前端 | 原生 HTML + CSS + JavaScript（零框架） |
| 设计系统 | Material Design 3 / Monet / oklch 色域 |
| 离线抓取 | Node.js（零依赖，纯内置模块） |
| 定时任务 | GitHub Actions (cron: */15) |
| 托管 | GitHub Pages |
| AI 翻译 | Kimi / DeepSeek / OpenAI API |

## 项目结构

```
github-explorer/
├── index.html              # 前端单页应用
├── server.js               # 本地开发服务器
├── scripts/
│   └── scrape.js           # 离线抓取 + AI 翻译脚本
├── data/                   # 预计算 JSON 数据（自动生成）
│   ├── trending.json
│   ├── ai.json
│   └── ...
├── .github/workflows/
│   └── scrape.yml          # GitHub Actions 定时任务
├── .env.example
├── package.json
└── README.md
```

## License

MIT © 2026
