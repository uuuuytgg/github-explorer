#!/usr/bin/env node

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT_DIR, 'data');
const MIN_TOTAL_REPOS = Number(process.env.MIN_TOTAL_REPOS || 10);
const REQUIRED_CATEGORIES = ['trending', 'newest'];

function readDataSnapshot() {
  const snapshot = new Map();
  if (!fs.existsSync(DATA_DIR)) return snapshot;

  for (const name of fs.readdirSync(DATA_DIR)) {
    if (!name.endsWith('.json')) continue;
    const filePath = path.join(DATA_DIR, name);
    snapshot.set(filePath, fs.readFileSync(filePath));
  }
  return snapshot;
}

function restoreDataSnapshot(snapshot) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  for (const [filePath, contents] of snapshot.entries()) {
    fs.writeFileSync(filePath, contents);
  }
}

function readCategory(name) {
  const filePath = path.join(DATA_DIR, `${name}.json`);
  if (!fs.existsSync(filePath)) throw new Error(`missing data/${name}.json`);
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function validateData() {
  let totalRepos = 0;
  const errors = [];

  for (const name of REQUIRED_CATEGORIES) {
    const payload = readCategory(name);
    if (payload.error) errors.push(`${name}: ${payload.error}`);
    if (!Array.isArray(payload.repos) || payload.repos.length === 0) {
      errors.push(`${name}: empty repos`);
    }
  }

  for (const name of fs.readdirSync(DATA_DIR)) {
    if (!name.endsWith('.json') || name === 'manifest.json') continue;
    const payload = JSON.parse(fs.readFileSync(path.join(DATA_DIR, name), 'utf8'));
    if (payload.error) errors.push(`${name}: ${payload.error}`);
    totalRepos += Array.isArray(payload.repos) ? payload.repos.length : 0;
  }

  if (totalRepos < MIN_TOTAL_REPOS) {
    errors.push(`total repos ${totalRepos} < ${MIN_TOTAL_REPOS}`);
  }

  if (errors.length > 0) {
    throw new Error(errors.join('; '));
  }
}

const snapshot = readDataSnapshot();
const result = spawnSync(process.execPath, [path.join('scripts', 'scrape.js')], {
  cwd: ROOT_DIR,
  env: process.env,
  stdio: 'inherit',
});

if (result.status !== 0) {
  restoreDataSnapshot(snapshot);
  process.exit(result.status || 1);
}

try {
  validateData();
} catch (error) {
  restoreDataSnapshot(snapshot);
  console.error(`\n❌ 数据校验失败，已恢复旧 data/*.json：${error.message}`);
  process.exit(1);
}
