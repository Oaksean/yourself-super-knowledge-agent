'use strict';
const { app, BrowserWindow, ipcMain, dialog, shell, clipboard, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const { Store, nowIso } = require('./core/store');
const fetcher = require('./core/fetcher');
const summarizer = require('./core/summarize');
const office = require('./core/office');
const { Tracker, hashText } = require('./core/tracker');
const exporter = require('./core/exporter');

const isSelfTest = process.argv.includes('--self-test');
const selfTestOutArg = process.argv.find((a) => a.startsWith('--self-test-out='));

// 启动追踪（排查“点了没反应”类问题用，正常运行时几乎无开销）
const bootLog = (msg) => {
  try {
    require('fs').appendFileSync(
      require('path').join(__dirname, 'output', 'boot.log'),
      new Date().toISOString() + ' ' + msg + '\n'
    );
  } catch (e) {
    /* ignore */
  }
};
bootLog; // 保留供自检排查
if (isSelfTest) bootLog('argv=' + JSON.stringify(process.argv) + ' selfTest=' + isSelfTest);

let mainWindow = null;
let store = null;
let tracker = null;
let clipboardTimer = null;
let lastClipText = '';
const logBuffer = [];

function dataDir() {
  // 允许用 --data-dir 指定，便于自检隔离
  const arg = process.argv.find((a) => a.startsWith('--data-dir='));
  if (arg) return arg.split('=')[1];
  return path.join(app.getPath('userData'), 'data');
}

function log(level, msg) {
  const line = { at: new Date().toISOString(), level, msg };
  logBuffer.push(line);
  if (logBuffer.length > 200) logBuffer.shift();
  if (level === 'error') console.error(msg);
  else console.log(msg);
  if (mainWindow && !mainWindow.isDestroyed()) {
    try {
      mainWindow.webContents.send('log', line);
    } catch (e) {
      /* ignore */
    }
  }
}

function sendSnapshot(reason) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    mainWindow.webContents.send('data:changed', { reason, snapshot: store.snapshot() });
  } catch (e) {
    /* ignore */
  }
}

function broadcast(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

/** 标题归一化：去空白与标点、转小写，用于「同主题近似重复」提示 */
function normTitle(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[\s\u3000]/g, '')
    .replace(/[《》「」"'“”·:：,，。.、!！?？\-—_/\\|()（）\[\]【】]/g, '');
}

/** 来源归一化：忽略协议大小写、www、utm/from/spm 参数和尾部斜杠，用于判重 */
function sourceKey(url) {
  if (!url) return '';
  try {
    const u = new URL(String(url).trim());
    u.hash = '';
    ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'from', 'spm'].forEach((k) =>
      u.searchParams.delete(k)
    );
    return (u.hostname.replace(/^www\./i, '').toLowerCase() + u.pathname.replace(/\/+$/, '')).toLowerCase();
  } catch (e) {
    return String(url || '').trim().toLowerCase();
  }
}

/* ------------------ 业务动作 ------------------ */

/** 文档里的链接归一化：去掉跟踪参数、hash 与图片/静态资源 */
function cleanDocLink(raw) {
  try {
    const u = new URL(String(raw || '').trim());
    if (!/^https?:$/.test(u.protocol)) return '';
    if (/\.(png|jpe?g|gif|svg|webp|ico|css|js|zip|rar|7z)$/i.test(u.pathname)) return '';
    u.hash = '';
    ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'from', 'spm'].forEach((k) =>
      u.searchParams.delete(k)
    );
    return u.toString().replace(/\/+$/, '');
  } catch (e) {
    return '';
  }
}

/** 解析 Word / Excel：正文 + 超链接目标 + 正文里的纯文本网址 → 统一成候选链接 */
async function analyzeOfficeFile(filePath) {
  if (!filePath) throw new Error('没有选择文件');
  const doc = office.readOfficeFile(filePath);
  const fromText = fetcher.extractLinksFromText(doc.text) || [];
  const merged = [];
  const seen = new Set();
  const push = (rawUrl, label) => {
    const url = cleanDocLink(rawUrl);
    if (!url || seen.has(url)) return;
    seen.add(url);
    const meta = fetcher.classifyLink(url);
    if (!meta) return;
    const host = meta.host || '';
    merged.push({
      url,
      label: label || host,
      kind: meta.kind,
      site: meta.site,
      host
    });
  };
  (doc.hyperlinks || []).forEach((u) => push(u));
  fromText.forEach((l) => push(l.url, l.label));

  const result = await summarizer.analyzeDocument(
    { fileName: doc.fileName, text: doc.text, candidates: merged },
    store.getSettings().llm
  );
  const matchedCat = store.getCategories().find((c) => c.name === (result.category || '').trim());
  const picked = Array.isArray(result.links) && result.links.length ? result.links : merged.slice(0, 4);

  return {
    title: result.title || doc.fileName.replace(/\.[^.]+$/, ''),
    sourceUrl: doc.filePath,
    sourceType: 'file',
    summary: result.summary,
    keyPoints: result.keyPoints || [],
    tags: result.tags || [],
    category: result.category,
    categoryId: matchedCat ? matchedCat.id : 0,
    summarySource: result.summarySource,
    warning: result.warning || '',
    coverUrl: '',
    charCount: doc.text.length,
    contentHash: hashText(doc.text),
    rawText: doc.text,
    links: picked,
    docLinks: merged,
    docKind: doc.kind,
    docDetail: doc.detail,
    fileName: doc.fileName,
    filePath: doc.filePath
  };
}

async function previewCapture({ url, rawText }) {
  const settings = store.getSettings();
  const fetched = await fetcher.fetchSource({
    url: url ? fetcher.normalizeUrl(url) : '',
    rawText,
    githubToken: settings.githubToken
  });
  const result = await summarizer.summarize(
    { title: fetched.title, text: fetched.text, sourceType: fetched.sourceType },
    settings.llm
  );

  const matchedCat = store
    .getCategories()
    .find((c) => c.name === (result.category || '').trim());

  return {
    title: result.title || fetched.title,
    sourceUrl: fetched.finalUrl || '',
    sourceType: fetched.sourceType,
    summary: result.summary,
    keyPoints: result.keyPoints,
    tags: result.tags,
    category: result.category,
    categoryId: matchedCat ? matchedCat.id : 0,
    summarySource: result.summarySource,
    warning: result.warning || '',
    coverUrl: fetched.coverUrl || '',
    charCount: fetched.text.length,
    contentHash: hashText(fetched.text),
    rawText: fetched.text,
    links: Array.isArray(fetched.links) ? fetched.links : []
  };
}

function registerIpc() {
  ipcMain.handle('app:bootstrap', () => ({
    snapshot: store.snapshot(),
    info: {
      version: app.getVersion(),
      dataFile: store.file,
      platform: process.platform,
      logs: logBuffer.slice(-40)
    }
  }));

  ipcMain.handle('app:snapshot', () => store.snapshot());

  /* ---------- Word / Excel 导入 ---------- */
  ipcMain.handle('file:pick', async () => {
    try {
      const win = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
      const opts = {
        title: '导入 Word / Excel',
        properties: ['openFile'],
        filters: [{ name: 'Word / Excel 文档', extensions: ['docx', 'xlsx'] }]
      };
      const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
      if (r.canceled || !r.filePaths || !r.filePaths.length) return { ok: false, canceled: true };
      return { ok: true, path: r.filePaths[0], name: path.basename(r.filePaths[0]) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('file:analyze', async (e, filePath) => {
    try {
      const draft = await analyzeOfficeFile(filePath);
      return { ok: true, draft };
    } catch (err) {
      log('error', '文档解析失败：' + err.message);
      return { ok: false, error: err.message };
    }
  });

  // 保存文档条目，并按勾选把文中链接抓成独立知识（每个链接一条，归到同一分类）
  ipcMain.handle('file:import', async (e, payload) => {
    try {
      const p = payload || {};
      const d = p.draft || {};
      if (!d.title || !String(d.title).trim()) throw new Error('标题不能为空');
      const settings = store.getSettings();
      const item = store.addItem({
        title: String(d.title).trim(),
        sourceUrl: d.sourceUrl || d.filePath || '',
        sourceType: 'file',
        summary: d.summary || '',
        keyPoints: d.keyPoints || [],
        categoryId: Number(d.categoryId) || 0,
        tags: (d.tags || []).slice(0, 8),
        note: d.note || '',
        contentHash: d.contentHash || '',
        coverUrl: '',
        enableTrack: false,
        trackIntervalHours: 24,
        charCount: Number(d.charCount) || 0,
        links: Array.isArray(d.links) ? d.links : []
      });

      const added = [];
      const failed = [];
      if (p.fetchLinks) {
        const list = (Array.isArray(d.links) ? d.links : []).slice(0, 4);
        for (const l of list) {
          try {
            const fetched = await fetcher.fetchSource({ url: l.url, githubToken: settings.githubToken });
            const res = await summarizer.summarize(
              { title: fetched.title, text: fetched.text, sourceType: fetched.sourceType },
              settings.llm
            );
            const cat = store.getCategories().find((c) => c.name === (res.category || '').trim());
            const child = store.addItem({
              title: res.title || fetched.title,
              sourceUrl: fetched.finalUrl || l.url,
              sourceType: fetched.sourceType || 'web',
              summary: res.summary,
              keyPoints: res.keyPoints || [],
              categoryId: cat ? cat.id : item.categoryId,
              tags: (res.tags || []).concat(['来自文档']).slice(0, 8),
              note: `自动抓取自《${item.title}》中的链接`,
              contentHash: hashText(fetched.text),
              coverUrl: fetched.coverUrl || '',
              enableTrack: false,
              charCount: fetched.text.length,
              links: Array.isArray(fetched.links) ? fetched.links : []
            });
            added.push({ id: child.id, title: child.title });
          } catch (err) {
            failed.push({ url: l.url, error: err.message });
          }
        }
      }
      sendSnapshot('file-import');
      return { ok: true, item, added, failed };
    } catch (err) {
      log('error', '文档导入失败：' + err.message);
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('capture:preview', async (e, payload) => {    try {
      const draft = await previewCapture(payload || {});
      return { ok: true, draft };
    } catch (err) {
      log('error', '抓取失败：' + err.message);
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('capture:save', (e, payload) => {
    try {
      const d = payload || {};
      if (!d.title || !d.title.trim()) throw new Error('标题不能为空');
      const item = store.addItem({
        title: d.title.trim(),
        sourceUrl: d.sourceUrl || '',
        sourceType: d.sourceType || 'web',
        summary: d.summary || '',
        keyPoints: d.keyPoints || [],
        categoryId: d.categoryId || 0,
        tags: d.tags || [],
        note: d.note || '',
        contentHash: d.contentHash || '',
        coverUrl: d.coverUrl || '',
        enableTrack: !!d.enableTrack,
        trackIntervalHours: Number(d.trackIntervalHours) || 24,
        charCount: Number(d.charCount) || 0,
        links: Array.isArray(d.links) ? d.links : []
      });
      sendSnapshot('add');
      return { ok: true, item };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  // 重新抓取正文 + 重算摘要 + 重抽外链（保留笔记、分类、星标与追踪设置，旧摘要进版本记录）
  ipcMain.handle('item:reextract', async (e, id) => {
    try {
      const item = store.getItem(Number(id));
      if (!item) throw new Error('条目不存在');
      if (item.sourceType === 'file') throw new Error('本地文件条目无法重新抓取，请重新导入该文件');
      if (!item.sourceUrl) throw new Error('该条目是手动录入的文本，没有来源链接，无法重新抓取');
      const fetched = await fetcher.fetchSource({
        url: item.sourceUrl,
        githubToken: store.getSettings().githubToken
      });
      const result = await summarizer.summarize(
        { title: fetched.title, text: fetched.text, sourceType: fetched.sourceType },
        store.getSettings().llm
      );
      const changed = hashText(fetched.text) !== item.contentHash;
      store.pushVersion(item.id, {
        summary: item.summary,
        keyPoints: item.keyPoints || [],
        reason: '重新抓取'
      });
      const updated = store.updateItem(item.id, {
        title: item.title || result.title || fetched.title,
        sourceType: fetched.sourceType || item.sourceType,
        summary: result.summary || item.summary,
        keyPoints: result.keyPoints && result.keyPoints.length ? result.keyPoints : item.keyPoints,
        tags: (item.tags || []).length ? item.tags : result.tags || [],
        links: Array.isArray(fetched.links) ? fetched.links : item.links || [],
        coverUrl: fetched.coverUrl || item.coverUrl || '',
        contentHash: hashText(fetched.text),
        charCount: fetched.text.length,
        lastCheckAt: new Date().toISOString(),
        hasUpdate: false
      });
      sendSnapshot('reextract');
      return { ok: true, item: updated, changed, summarySource: result.summarySource, warning: result.warning || '' };
    } catch (err) {
      log('error', '重新抓取失败：' + err.message);
      return { ok: false, error: err.message };
    }
  });

  // 重复检测：同一来源（忽略 utm/尾斜杠）或同一正文哈希，认为重复
  ipcMain.handle('item:findDuplicate', (e, payload) => {
    try {
      const p = payload || {};
      const key = sourceKey(p.sourceUrl);
      const hash = String(p.contentHash || '');
      const titleNorm = normTitle(p.title);
      const excludeId = Number(p.excludeId) || 0;
      const matches = [];
      store.getItems().forEach((it) => {
        if (it.id === excludeId) return;
        if (key && sourceKey(it.sourceUrl) === key) {
          matches.push({ id: it.id, title: it.title, createAt: it.createAt, reason: 'same-source' });
          return;
        }
        if (hash && it.contentHash && it.contentHash === hash) {
          matches.push({ id: it.id, title: it.title, createAt: it.createAt, reason: 'same-content' });
          return;
        }
        // 不同链接但标题高度接近 → 提示可能同主题，由用户决定
        if (titleNorm && titleNorm.length >= 8) {
          const tn = normTitle(it.title);
          const shorter = Math.min(tn.length, titleNorm.length);
          if (tn === titleNorm || (shorter >= 8 && (tn.includes(titleNorm) || titleNorm.includes(tn)))) {
            matches.push({ id: it.id, title: it.title, createAt: it.createAt, reason: 'similar-title' });
          }
        }
      });
      return { ok: true, matches };
    } catch (err) {
      return { ok: false, error: err.message, matches: [] };
    }
  });

  ipcMain.handle('item:refreshLinks', async (e, id) => {
    try {
      const item = store.getItem(id);
      if (!item) throw new Error('条目不存在');
      if (item.sourceType === 'file') throw new Error('文档导入的条目没有网页来源，链接请在导入时勾选抓取');
      if (!item.sourceUrl) throw new Error('该条目没有来源链接，无法提取外链');
      const fetched = await fetcher.fetchSource({
        url: item.sourceUrl,
        githubToken: store.getSettings().githubToken
      });
      const links = Array.isArray(fetched.links) ? fetched.links : [];
      store.updateItem(id, { links });
      sendSnapshot('links');
      return { ok: true, links };
    } catch (err) {
      log('error', '外链提取失败：' + err.message);
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('tree:summary', async (e, payload) => {
    try {
      const categoryId = Number((payload || {}).categoryId) || 0;
      const force = !!(payload || {}).force;
      const cats = store.getCategories();
      const cat = cats.find((c) => c.id === categoryId);
      const categoryName = cat ? cat.name : '未分类';
      const items = store.getItems().filter((i) => Number(i.categoryId) === categoryId);
      if (!items.length) {
        return { ok: true, data: { summary: '该分类下还没有内容。', keyPoints: [], tags: [], summarySource: 'local' } };
      }
      const cached = store.getCategorySummary(categoryId);
      if (cached && !force && Number(cached.count) === items.length && cached.summary) {
        return { ok: true, data: cached, cached: true };
      }
      const data = await summarizer.summarizeCategory({ categoryName, items }, store.getSettings().llm);
      const saved = store.setCategorySummary(categoryId, {
        summary: data.summary,
        keyPoints: data.keyPoints || [],
        tags: data.tags || [],
        count: items.length,
        source: data.summarySource || 'local',
        warning: data.warning || ''
      });
      sendSnapshot('tree');
      return { ok: true, data: saved };
    } catch (err) {
      log('error', '归类总结失败：' + err.message);
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('item:update', (e, { id, patch }) => {
    try {
      const before = store.getItem(id);
      if (!before) throw new Error('条目不存在');
      if (patch && patch.enableTrack && before.sourceType === 'file') {
        throw new Error('本地文档条目无法追踪原文变化，请对文中链接单独开启追踪');
      }
      const item = store.updateItem(id, patch || {});
      if (!item) throw new Error('条目不存在');
      sendSnapshot('update');
      return { ok: true, item };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('item:delete', (e, ids) => {
    try {
      store.deleteItems(ids || []);
      sendSnapshot('delete');
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('item:recheck', async (e, { id, force }) => {
    try {
      const r = await tracker.checkItem(id, { force: !!force });
      sendSnapshot('recheck');
      return { ok: true, changed: r.changed };
    } catch (err) {
      log('error', '手动检查失败：' + err.message);
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('track:scanAll', async () => {
    try {
      const r = await tracker.checkDue();
      sendSnapshot('scan');
      return { ok: true, summary: r };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('category:add', (e, payload) => {
    try {
      const cat = store.addCategory(payload || {});
      sendSnapshot('category');
      return { ok: true, category: cat };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('category:update', (e, { id, patch }) => {
    try {
      const cat = store.updateCategory(id, patch || {});
      sendSnapshot('category');
      return { ok: true, category: cat };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('category:delete', (e, id) => {
    try {
      store.deleteCategory(id);
      sendSnapshot('category');
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('export:markdown', async (e, { ids, all, groupByCategory }) => {
    try {
      const items = all ? store.getItems() : store.getItems().filter((i) => (ids || []).includes(i.id));
      if (!items.length) throw new Error('没有可导出的内容');
      const cats = store.getCategories();
      const content = exporter.buildMarkdown(items, cats, { groupByCategory: !!groupByCategory });
      const defaultName =
        !all && items.length === 1
          ? `${exporter.safeFileName(items[0].title)}.md`
          : `随手贴-${new Date().toISOString().slice(0, 10)}.md`;
      const picked = await dialog.showSaveDialog(mainWindow, {
        title: '导出 Markdown',
        defaultPath: path.join(app.getPath('documents'), defaultName),
        filters: [{ name: 'Markdown', extensions: ['md'] }]
      });
      if (picked.canceled || !picked.filePath) return { ok: true, canceled: true };
      const saved = exporter.writeFile(picked.filePath, content);
      log('info', `已导出 Markdown：${saved.path}`);
      return { ok: true, path: saved.path };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('export:backup', async () => {
    try {
      const data = store.exportAll();
      const picked = await dialog.showSaveDialog(mainWindow, {
        title: '备份知识库',
        defaultPath: path.join(
          app.getPath('documents'),
          `随手贴备份-${new Date().toISOString().slice(0, 10)}.json`
        ),
        filters: [{ name: 'JSON', extensions: ['json'] }]
      });
      if (picked.canceled || !picked.filePath) return { ok: true, canceled: true };
      exporter.writeFile(picked.filePath, JSON.stringify(data, null, 2));
      return { ok: true, path: picked.filePath };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('import:backup', async (e, { mode } = {}) => {
    try {
      const picked = await dialog.showOpenDialog(mainWindow, {
        title: '选择备份文件',
        properties: ['openFile'],
        filters: [{ name: 'JSON', extensions: ['json'] }]
      });
      if (picked.canceled || !picked.filePaths.length) return { ok: true, canceled: true };
      const raw = fs.readFileSync(picked.filePaths[0], 'utf8');
      const payload = JSON.parse(raw);
      const r = store.importAll(payload, mode === 'replace' ? 'replace' : 'merge');
      sendSnapshot('import');
      return { ok: true, result: r };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('settings:save', (e, patch) => {
    try {
      const settings = store.updateSettings(patch || {});
      if (patch && patch.trackIntervalMinutes) tracker.start(settings.trackIntervalMinutes);
      if (patch && patch.clipboardWatch !== undefined) {
        settings.clipboardWatch ? startClipboardWatch() : stopClipboardWatch();
      }
      sendSnapshot('settings');
      return { ok: true, settings };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('settings:testLLM', async (e, llm) => {
    try {
      const settings = store.getSettings();
      const conf = Object.assign({}, settings.llm, llm || {});
      const r = await summarizer.testLLM(conf);
      return { ok: true, reply: r.reply };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('file:open', async (e, filePath) => {
    try {
      const p = String(filePath || '');
      if (!/\.(docx|xlsx)$/i.test(p) || !fs.existsSync(p)) throw new Error('文件已被移动或删除，找不到原文件');
      const msg = await shell.openPath(p);
      return msg ? { ok: false, error: msg } : { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('shell:open', async (e, url) => {
    try {
      if (!/^https?:\/\//i.test(String(url))) throw new Error('链接格式不正确');
      await shell.openExternal(url);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });

  ipcMain.handle('clipboard:read', () => clipboard.readText());

  ipcMain.handle('app:openDataDir', () => {
    shell.openPath(path.dirname(store.file));
    return { ok: true };
  });

  ipcMain.handle('app:clearData', () => {
    try {
      store.clearAll();
      sendSnapshot('clear');
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
}

/* ------------------ 剪贴板监听 ------------------ */
function startClipboardWatch() {
  stopClipboardWatch();
  lastClipText = clipboard.readText() || '';
  clipboardTimer = setInterval(() => {
    const t = (clipboard.readText() || '').trim();
    if (!t || t === lastClipText) return;
    lastClipText = t;
    if (/^https?:\/\/(mp\.weixin\.qq\.com|github\.com|raw\.githubusercontent\.com)/i.test(t) || /^https?:\/\/[^\s]+$/i.test(t)) {
      broadcast('clipboard:found', { text: t });
    }
  }, 2500);
}

function stopClipboardWatch() {
  if (clipboardTimer) {
    clearInterval(clipboardTimer);
    clipboardTimer = null;
  }
}

/* ------------------ 窗口 ------------------ */
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 1024,
    minHeight: 640,
    show: false,
    backgroundColor: '#f5f7f6',
    title: '随手贴',
    autoHideMenuBar: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  mainWindow.once('ready-to-show', () => {
    if (!isSelfTest) mainWindow.show();
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://')) {
      e.preventDefault();
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function buildMenu() {
  const template = [
    {
      label: '文件',
      submenu: [
        {
          label: '新增知识',
          accelerator: 'CmdOrCtrl+N',
          click: () => broadcast('menu:action', 'add')
        },
        {
          label: '导出全库 Markdown',
          click: () => broadcast('menu:action', 'export-all')
        },
        { type: 'separator' },
        { label: '退出', role: 'quit' }
      ]
    },
    {
      label: '视图',
      submenu: [
        { label: '重新加载', role: 'reload' },
        { label: '开发者工具', role: 'toggleDevTools' },
        { type: 'separator' },
        { label: '放大', role: 'zoomIn' },
        { label: '缩小', role: 'zoomOut' },
        { label: '实际大小', role: 'resetZoom' },
        { type: 'separator' },
        { label: '全屏', role: 'togglefullscreen' }
      ]
    },
    {
      label: '帮助',
      submenu: [
        {
          label: '关于随手贴',
          click: () => {
            dialog.showMessageBox(mainWindow, {
              type: 'info',
              title: '关于随手贴',
              message: '随手贴 v' + app.getVersion(),
              detail:
                '本地碎片知识库：公众号 / GitHub / 网页 / 文本 一键摘要归档。\n数据全部保存在本机：' +
                (store ? store.file : '')
            });
          }
        }
      ]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/* ------------------ 启动 ------------------ */
app.whenReady().then(async () => {
  if (isSelfTest) bootLog('whenReady');
  store = new Store(isSelfTest ? path.join(dataDir(), 'selftest') : dataDir());
  tracker = new Tracker({
    store,
    fetcher,
    summarizer,
    onUpdate: (evt) => {
      if (evt.type === 'changed') {
        log('info', `检测到更新：${evt.title}`);
      }
      sendSnapshot('tracker:' + evt.type);
      broadcast('tracker:event', evt);
    },
    onLog: (l) => log(l.level, l.msg)
  });

  registerIpc();

  if (isSelfTest) {
    const { runSelfTest } = require('./scripts/selfTest');
    const outPath =
      selfTestOutArg && selfTestOutArg.includes('=')
        ? selfTestOutArg.split('=').slice(1).join('=')
        : path.join(app.getPath('userData'), 'self-test-result.txt');
    await runSelfTest({ app, BrowserWindow, store, outPath, rootDir: __dirname });
    bootLog('selftest returned');
    return;
  }

  createWindow();
  buildMenu();

  const settings = store.getSettings();
  tracker.start(settings.trackIntervalMinutes);
  if (settings.clipboardWatch) startClipboardWatch();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  stopClipboardWatch();
  if (tracker) tracker.stop();
});
