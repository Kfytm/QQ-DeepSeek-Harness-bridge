// 轻量浏览器 MCP：playwright-core + 系统 Chrome/Edge。
// 只给 5 个工具：web_open / web_read / web_click / web_screenshot / web_close。
// 独立 profile 目录，不碰日常浏览器数据；要登录某站就在弹出的窗口里扫一次码，cookie 留在专用 profile。
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { chromium } from 'playwright-core';

const CHROME_CANDIDATES = [
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
];
const CHROME = CHROME_CANDIDATES.find((p) => fs.existsSync(p)) || '';
const PROFILE_DIR = process.env.WEB_MCP_PROFILE || 'D:\\DSH\\browser-profile';
const SHOT_DIR = process.env.WEB_MCP_SHOTS || 'D:\\DSH\\_web_shots';
const TEXT_LIMIT = 12000;

const server = new McpServer({ name: 'web-browser', version: '0.1.0' });

let context = null;
let page = null;

async function ensurePage() {
  if (!CHROME) throw new Error('找不到 Chrome/Edge 可执行文件');
  if (!context) {
    // playwright 1.58 起 --user-data-dir 必须走 launchPersistentContext
    context = await chromium.launchPersistentContext(PROFILE_DIR, {
      executablePath: CHROME,
      headless: false,
      viewport: { width: 1280, height: 800 }
    });
    page = context.pages()[0] || null;
  }
  if (!page || page.isClosed()) {
    page = await context.newPage();
  }
  return page;
}

function cleanText(value) {
  return String(value ?? '')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
    .slice(0, TEXT_LIMIT);
}

async function readCurrent(p) {
  const title = await p.title().catch(() => '');
  const url = p.url();
  const text = await p.evaluate(() => document.body?.innerText ?? '').catch(() => '');
  return { title, url, text: cleanText(text) };
}

async function withPage(fn) {
  try {
    const p = await ensurePage();
    return await fn(p);
  } catch (error) {
    return { content: [{ type: 'text', text: `浏览器操作失败：${error?.message ?? error}` }], isError: true };
  }
}

server.tool('web_open', '用系统浏览器打开网页，返回标题和正文文本。', {
  url: z.string().describe('http(s) 地址')
}, async ({ url }) => withPage(async (p) => {
  await p.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await p.waitForTimeout(800);
  const r = await readCurrent(p);
  return { content: [{ type: 'text', text: `【标题】${r.title}\n【地址】${r.url}\n\n${r.text}` }] };
}));

server.tool('web_read', '读取当前页面正文（不重新导航）。', {}, async () => withPage(async (p) => {
  const r = await readCurrent(p);
  return { content: [{ type: 'text', text: `【标题】${r.title}\n【地址】${r.url}\n\n${r.text}` }] };
}));

server.tool('web_click', '按可见文字或 CSS 选择器点击当前页面上的元素。', {
  text: z.string().optional().describe('按可见文字点击'),
  selector: z.string().optional().describe('按 CSS 选择器点击')
}, async ({ text, selector }) => withPage(async (p) => {
  if (selector) await p.click(selector, { timeout: 10000 });
  else if (text) await p.getByText(text, { exact: false }).first().click({ timeout: 10000 });
  else throw new Error('需要 text 或 selector');
  await p.waitForTimeout(500);
  const r = await readCurrent(p);
  return { content: [{ type: 'text', text: `点击后：【标题】${r.title}\n【地址】${r.url}\n\n${r.text.slice(0, 5000)}` }] };
}));

server.tool('web_screenshot', '截当前页面并返回图片（JPEG 压缩，能看到画面）。', {
  fullPage: z.boolean().optional().describe('是否整页截图，默认否')
}, async ({ fullPage }) => withPage(async (p) => {
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  const file = path.join(SHOT_DIR, `web-${Date.now()}.jpg`);
  await p.screenshot({ path: file, fullPage: !!fullPage, type: 'jpeg', quality: 60 });
  const buf = fs.readFileSync(file);
  return {
    content: [
      { type: 'text', text: `截图：${file}（${Math.round(buf.length / 1024)}KB）` },
      { type: 'image', mimeType: 'image/jpeg', data: buf.toString('base64') }
    ]
  };
}));

server.tool('web_image', '按 URL 下载一张图片并以图像返回（B 站评论图、网页里的图片都能看）。', {
  url: z.string().describe('图片 http(s) 地址')
}, async ({ url }) => {
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', referer: 'https://www.bilibili.com/' },
      signal: AbortSignal.timeout(25000)
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length) throw new Error('图片为空');
    fs.mkdirSync(SHOT_DIR, { recursive: true });
    const stamp = Date.now();
    const raw = path.join(SHOT_DIR, `img-${stamp}.bin`);
    fs.writeFileSync(raw, buf);
    let file = raw;
    const ffmpeg = ['D:\\ffmpeg\\bin\\ffmpeg.exe', 'C:\\ffmpeg\\bin\\ffmpeg.exe'].find((p) => fs.existsSync(p));
    if (ffmpeg) {
      const jpg = path.join(SHOT_DIR, `img-${stamp}.jpg`);
      try {
        execFileSync(ffmpeg, ['-y', '-v', 'error', '-i', raw, '-vf', 'scale=1280:-1', '-q:v', '5', jpg], {
          timeout: 20000,
          stdio: ['ignore', 'ignore', 'ignore']
        });
        if (fs.existsSync(jpg) && fs.statSync(jpg).size > 0) file = jpg;
      } catch {}
    }
    const out = fs.readFileSync(file);
    return {
      content: [
        { type: 'text', text: `图片：${url}（${Math.round(out.length / 1024)}KB）` },
        { type: 'image', mimeType: /\.jpe?g$/i.test(file) ? 'image/jpeg' : 'image/png', data: out.toString('base64') }
      ]
    };
  } catch (error) {
    return { content: [{ type: 'text', text: `看图失败：${error?.message ?? error}` }], isError: true };
  }
});

server.tool('web_close', '关闭浏览器。', {}, async () => {
  try {
    if (context) await context.close();
    context = null;
    page = null;
    return { content: [{ type: 'text', text: '浏览器已关闭' }] };
  } catch (error) {
    return { content: [{ type: 'text', text: `关闭失败：${error?.message ?? error}` }], isError: true };
  }
});

await server.connect(new StdioServerTransport());
