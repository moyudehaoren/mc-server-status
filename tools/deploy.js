// 把本项目所有文件同步到 GitHub 仓库（走 Contents API，本机无需安装 git）。
//
// 用法：
//   node tools/deploy.js --check           # 只验证令牌与仓库、列出将同步的文件
//   node tools/deploy.js --dry-run         # 同上但不写入
//   node tools/deploy.js                   # 全量同步（新增 + 更新，内容相同则跳过）
//   node tools/deploy.js --pages           # 同步后顺便开启 GitHub Pages
//
// 令牌读取顺序（绝不会打印令牌本身）：
//   1) 环境变量 GH_TOKEN / GITHUB_TOKEN
//   2) E:\dsh\.secrets\gh-token.txt
//   3) <项目>\..\.secrets\gh-token.txt
//   4) scripts/host.config.json 的 token 字段
//
// 同步到仓库的默认分支（通常 main），自动排除 .git/.secrets/node_modules/日志。

const fs = require('node:fs');
const path = require('node:path');

const API = 'https://api.github.com';
const root = path.resolve(__dirname, '..');
const REPO_NAME = 'mc-server-status';

const args = process.argv.slice(2);
const checkOnly = args.includes('--check') || args.includes('--dry-run');
const wantPages = args.includes('--pages');

const EXCLUDE_DIRS = new Set(['.git', '.secrets', 'node_modules', '.npm-cache']);

// 读取 .gitignore，并叠加"令牌类文件"安全兜底规则：
// 这些文件绝不能进公开仓库（GitHub 的 secret scanning 也会拒绝这种提交）。
function loadIgnoreMatchers() {
  const patterns = [
    'host.config.json', '.secrets/', '*.log', '*.token', '*.key', '*.pem', '.env', '.env.*'
  ];
  // status.json / tunnel.json 由自动化维护（心跳脚本 + Actions 工作流），
  // 本地同步默认跳过，免得把过期的本地状态覆盖上去。首次建仓用 --with-state 强制包含。
  if (!args.includes('--with-state')) patterns.push('status.json', 'tunnel.json');
  try {
    for (const line of fs.readFileSync(path.join(root, '.gitignore'), 'utf8').split(/\r?\n/)) {
      const p = line.trim();
      if (!p || p.startsWith('#') || p.startsWith('!')) continue;
      patterns.push(p);
    }
  } catch { /* 没有 .gitignore 就只用兜底规则 */ }

  return patterns.map((raw) => {
    let p = raw.replace(/^\//, '');
    const dirOnly = p.endsWith('/');
    if (dirOnly) p = p.slice(0, -1);
    const hasSlash = p.includes('/');
    const body = p
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*\*/g, '\u0000')
      .replace(/\*/g, '[^/]*')
      .replace(/\u0000/g, '.*')
      .replace(/\?/g, '[^/]');
    return new RegExp((hasSlash ? '^' : '(^|.*/)') + body + (dirOnly ? '(/.*)?$' : '$'));
  });
}

const ignoreMatchers = loadIgnoreMatchers();
const isIgnored = (rel) => ignoreMatchers.some((r) => r.test(rel));

function readToken() {
  const candidates = [
    process.env.GH_TOKEN,
    process.env.GITHUB_TOKEN,
    'E:\\dsh\\.secrets\\gh-token.txt',
    path.join(root, '..', '.secrets', 'gh-token.txt'),
    path.join(root, 'scripts', 'host.config.json')
  ];
  for (const c of candidates) {
    if (!c) continue;
    try {
      if (c.endsWith('.json')) {
        const j = JSON.parse(fs.readFileSync(c, 'utf8'));
        const t = String(j.token || '');
        if (t && !/填入|xxx|your|placeholder/i.test(t)) return t.replace(/[\s"']/g, '');
        continue;
      }
      const t = fs.readFileSync(c, 'utf8').replace(/[\s"']/g, '');
      if (t) return t;
    } catch { /* 换下一个候选 */ }
  }
  return null;
}

async function api(pathname, token, options = {}) {
  const res = await fetch(API + pathname, {
    ...options,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'mc-server-status-deploy',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(options.headers || {})
    }
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
  return { status: res.status, ok: res.ok, json };
}

function walk(dir, base, out = [], ignored = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (EXCLUDE_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, base, out, ignored);
    } else {
      const rel = path.relative(base, full).split(path.sep).join('/');
      if (isIgnored(rel)) ignored.push(rel);
      else out.push(rel);
    }
  }
  return { files: out, ignored };
}

const contentPath = (rel) => '/contents/' + rel.split('/').map(encodeURIComponent).join('/');

(async () => {
  const token = readToken();
  if (!token) {
    console.error('✗ 找不到令牌。请把令牌保存到 E:\\dsh\\.secrets\\gh-token.txt');
    process.exit(1);
  }

  const me = await api('/user', token);
  if (!me.ok) {
    console.error(`✗ 令牌无效或权限不足：HTTP ${me.status} ${me.json?.message || ''}`);
    process.exit(1);
  }
  const owner = me.json.login;
  console.log(`✓ 令牌有效，账号：${owner}`);

  const repo = await api(`/repos/${owner}/${REPO_NAME}`, token);
  if (!repo.ok) {
    console.error(`✗ 无法访问 ${owner}/${REPO_NAME}（HTTP ${repo.status}）。先在网页上创建公开空仓库，并确认令牌的 Repository access 勾了这个仓库。`);
    process.exit(1);
  }
  const branch = repo.json.default_branch || 'main';
  console.log(`✓ 仓库可访问：${repo.json.full_name}（${repo.json.private ? '私有' : '公开'}，默认分支 ${branch}）`);

  // --set-var NAME=VALUE ：设置/更新仓库 Actions 变量（非敏感值用它，敏感值用 Secrets）
  const svIndex = args.indexOf('--set-var');
  if (svIndex >= 0 && args[svIndex + 1]) {
    const raw = args[svIndex + 1];
    const eq = raw.indexOf('=');
    if (eq <= 0) {
      console.error('✗ --set-var 需要写成 NAME=VALUE');
      process.exit(1);
    }
    const name = raw.slice(0, eq);
    const value = raw.slice(eq + 1);
    const varPath = `/repos/${owner}/${REPO_NAME}/actions/variables/${encodeURIComponent(name)}`;
    let r = await api(varPath, token, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, value })
    });
    if (r.status === 404) {
      r = await api(`/repos/${owner}/${REPO_NAME}/actions/variables`, token, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, value })
      });
    }
    if (r.ok) console.log(`✓ 仓库变量 ${name} = ${value}`);
    else console.error(`✗ 设置变量 ${name} 失败：HTTP ${r.status} ${r.json?.message || ''}`);
  }

  // --trigger-workflow 文件名（例如 tunnel-check.yml）：手动触发一次 workflow_dispatch
  const twIndex = args.indexOf('--trigger-workflow');
  if (twIndex >= 0 && args[twIndex + 1]) {
    const wf = args[twIndex + 1];
    const r = await api(
      `/repos/${owner}/${REPO_NAME}/actions/workflows/${encodeURIComponent(wf)}/dispatches`,
      token,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ref: branch })
      }
    );
    if (r.status === 204) console.log(`✓ 已触发工作流 ${wf}（ref=${branch}）`);
    else console.error(`✗ 触发工作流失败：HTTP ${r.status} ${r.json?.message || ''}（需要令牌有 Actions: Read and write）`);
  }

  // --delete 路径：删除仓库里的文件（可写多次），用于清理已废弃的文件
  const deleteTargets = [];
  args.forEach((a, i) => {
    if (a === '--delete' && args[i + 1]) deleteTargets.push(args[i + 1]);
  });
  for (const rel of deleteTargets) {
    const existing = await api(`/repos/${owner}/${REPO_NAME}${contentPath(rel)}?ref=${branch}`, token);
    if (!existing.ok) {
      console.log(`• 远端不存在，跳过删除：${rel}`);
      continue;
    }
    const del = await api(`/repos/${owner}/${REPO_NAME}${contentPath(rel)}`, token, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: `chore: 删除 ${rel}`, sha: existing.json.sha, branch })
    });
    if (del.ok) console.log(`✓ 已删除远端文件 ${rel}`);
    else console.error(`✗ 删除失败 ${rel}：HTTP ${del.status} ${del.json?.message || ''}`);
  }

  const { files: fileList, ignored } = walk(root, root);
  const files = fileList.sort();
  console.log(`\n将同步 ${files.length} 个文件：`);
  for (const f of files) console.log('  ' + f);
  if (ignored.length) {
    console.log(`已排除 ${ignored.length} 个被忽略的文件（含令牌，不会推送）：`);
    for (const f of ignored) console.log('  ✗ ' + f);
  }

  if (checkOnly) {
    console.log('\n--check 完成，未写入任何内容。');
    return;
  }

  console.log('');
  // ---- 第一遍：只读对比，挑出有变化的文件 ----
  const changes = [];
  let skipped = 0;
  for (const rel of files) {
    const content = fs.readFileSync(path.join(root, rel));
    const existing = await api(`/repos/${owner}/${REPO_NAME}${contentPath(rel)}?ref=${branch}`, token);
    if (existing.ok && existing.json.content !== undefined) {
      const remote = Buffer.from(String(existing.json.content || '').replace(/\n/g, ''), 'base64');
      if (remote.equals(content)) {
        skipped++;
        continue;
      }
    }
    changes.push({ rel, content });
  }

  if (!changes.length) {
    console.log(`所有 ${files.length} 个文件都已是最新，无需提交。`);
  } else {
    console.log(`有变化 ${changes.length} 个（未变 ${skipped} 个）：`);
    for (const c of changes) console.log('  变更 ' + c.rel);

    // ---- 第二遍：用 Git Data API 一次提交完，避免"一个文件一个 commit"造成构建风暴 ----
    const refRes = await api(`/repos/${owner}/${REPO_NAME}/git/ref/heads/${branch}`, token);
    const parentSha = refRes.ok ? refRes.json.object.sha : null;
    let baseTree = null;
    if (parentSha) {
      const parentRes = await api(`/repos/${owner}/${REPO_NAME}/git/commits/${parentSha}`, token);
      if (!parentRes.ok) {
        console.error(`✗ 读取父提交失败：HTTP ${parentRes.status} ${parentRes.json?.message || ''}`);
        process.exit(1);
      }
      baseTree = parentRes.json.tree.sha;
    }

    const treeEntries = [];
    for (const c of changes) {
      const blob = await api(`/repos/${owner}/${REPO_NAME}/git/blobs`, token, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: c.content.toString('base64'), encoding: 'base64' })
      });
      if (!blob.ok) {
        console.error(`✗ 创建 blob 失败 ${c.rel}：HTTP ${blob.status} ${blob.json?.message || ''}`);
        process.exit(1);
      }
      treeEntries.push({ path: c.rel, mode: '100644', type: 'blob', sha: blob.json.sha });
    }

    const treeBody = { tree: treeEntries };
    if (baseTree) treeBody.base_tree = baseTree;
    const treeRes = await api(`/repos/${owner}/${REPO_NAME}/git/trees`, token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(treeBody)
    });
    if (!treeRes.ok) {
      console.error(`✗ 创建 tree 失败：HTTP ${treeRes.status} ${treeRes.json?.message || ''}`);
      process.exit(1);
    }

    const commitBody = { message: `chore: 同步 ${changes.length} 个文件`, tree: treeRes.json.sha };
    if (parentSha) commitBody.parents = [parentSha];
    const commitRes = await api(`/repos/${owner}/${REPO_NAME}/git/commits`, token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(commitBody)
    });
    if (!commitRes.ok) {
      console.error(`✗ 创建 commit 失败：HTTP ${commitRes.status} ${commitRes.json?.message || ''}`);
      process.exit(1);
    }

    const upd = parentSha
      ? await api(`/repos/${owner}/${REPO_NAME}/git/refs/heads/${branch}`, token, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sha: commitRes.json.sha, force: false })
        })
      : await api(`/repos/${owner}/${REPO_NAME}/git/refs`, token, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: commitRes.json.sha })
        });
    if (!upd.ok) {
      console.error(`✗ 更新分支失败：HTTP ${upd.status} ${upd.json?.message || ''}`);
      process.exit(1);
    }

    console.log(`✓ 已提交 1 个 commit（含 ${changes.length} 个文件）：${commitRes.json.sha.slice(0, 7)}`);
    console.log('  GitHub Pages 会重建一次，约 1 分钟后生效。');
  }

  if (wantPages) {
    const pages = await api(`/repos/${owner}/${REPO_NAME}/pages`, token, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: { branch, path: '/' } })
    });
    if (pages.ok) {
      console.log(`✓ GitHub Pages 已开启：https://${owner}.github.io/${REPO_NAME}/`);
    } else if (pages.status === 409) {
      console.log(`• GitHub Pages 之前已开启：https://${owner}.github.io/${REPO_NAME}/`);
    } else {
      console.error(`✗ 开启 Pages 失败：HTTP ${pages.status} ${pages.json?.message || ''}`);
      console.error('  可以手动开：仓库 Settings → Pages → Source: Deploy from a branch → ' + branch + ' / (root)');
    }
  }

  process.exit(0);
})();
