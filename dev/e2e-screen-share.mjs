/* eslint-disable */
// 屏幕共享 UI 自验：按钮移入 composer、按会话隔离、显式加入观看、连接中态、离开自动停看
// 用法：node dev/e2e-screen-share.mjs （需本地 server 8787 + vite 5199 已启动）
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = 'http://127.0.0.1:5199';
const ROOT = 'C:/Users/Root/Desktop/AIGC/GameTalk';
const SHOT = path.join(ROOT, 'dev', 'shots');
fs.mkdirSync(SHOT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function ok(name, cond, extra = '') {
  results.push({ name, pass: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  [' + extra + ']' : ''}`);
}

async function register(page, username) {
  await page.goto(BASE, { waitUntil: 'networkidle2' });
  await page.waitForSelector('.auth-card', { timeout: 15000 }).catch(() => {});
  await page.evaluate(() => {
    [...document.querySelectorAll('.auth-card button')].find((b) => b.textContent.trim() === '注册')?.click();
  });
  await sleep(400);
  await page.type('.auth-card input:not([type="password"])', username);
  await page.type('.auth-card input[type="password"]', 'password123');
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll('.auth-card button')].find((b) => b.textContent.includes('注册') && b.type === 'submit');
    (btn ?? document.querySelector('.auth-card .btn.primary'))?.click();
  });
  await sleep(1800);
}
async function getToken(page) {
  return page.evaluate(() => { try { return JSON.parse(localStorage.getItem('gametalk-auth'))?.state?.token ?? ''; } catch { return ''; } });
}
async function apiCall(page, method, p, body) {
  return page.evaluate(async (m, path, b) => {
    let token = '';
    try { token = JSON.parse(localStorage.getItem('gametalk-auth'))?.state?.token ?? ''; } catch {}
    const res = await fetch(`http://127.0.0.1:8787${path}`, {
      method: m, headers: { ...(b ? { 'Content-Type': 'application/json' } : {}), authorization: `Bearer ${token}` },
      body: b ? JSON.stringify(b) : undefined,
    });
    const t = await res.text();
    try { return { status: res.status, body: JSON.parse(t) }; } catch { return { status: res.status, body: null }; }
  }, method, p, body ?? null);
}
async function selectRoom(page, name) {
  await page.evaluate((nm) => {
    const el = [...document.querySelectorAll('.room-item')].find((i) => (i.querySelector('.room-name')?.textContent ?? '').includes(nm));
    el?.click();
  }, name);
  await sleep(900);
}
function bannerText(page) {
  return page.evaluate(() => {
    const b = document.querySelector('.screen-banner');
    return b ? b.textContent.trim() : null;
  });
}

const run = async () => {
  const stamp = Date.now();
  const UA = `ss_a_${stamp}`;
  const UB = `ss_b_${stamp}`;
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', defaultViewport: { width: 1380, height: 860 } });
  try {
    const ctxA = await browser.createBrowserContext();
    const ctxB = await browser.createBrowserContext();
    const A = await ctxA.newPage();
    const B = await ctxB.newPage();
    await register(A, UA);
    await register(B, UB);
    ok('A/B 注册登录', !!(await getToken(A)) && !!(await getToken(B)));

    const r1 = (await apiCall(A, 'POST', '/api/rooms', { name: 'ShareRoom' })).body.room;
    const r2 = (await apiCall(A, 'POST', '/api/rooms', { name: 'OtherRoom' })).body.room;
    await apiCall(B, 'POST', '/api/rooms/join', { inviteCode: r1.inviteCode });
    await A.reload({ waitUntil: 'networkidle2' }); await sleep(1500);
    await B.reload({ waitUntil: 'networkidle2' }); await sleep(1500);

    await selectRoom(A, 'ShareRoom');

    // ---- ⑤ 按钮在 composer，顶栏无旧按钮 ----
    const composerBtn = await A.evaluate(() =>
      !![...document.querySelectorAll('.composer-icon')].find((b) => (b.title ?? '').includes('共享')));
    ok('⑤ composer 内出现屏幕共享按钮', composerBtn);
    const topbarOld = await A.evaluate(() =>
      [...document.querySelectorAll('header button')].some((b) => ['屏幕共享', '停止共享', '共享中…'].includes(b.textContent.trim())));
    ok('⑤ 顶栏不再有屏幕共享按钮', !topbarOld);

    // ---- 初始无 banner ----
    ok('无共享时无横幅', (await bannerText(A)) === null);

    // ---- 模拟 B 发起共享（raw WS，不依赖 getDisplayMedia）----
    await B.evaluate(async (roomId, token) => {
      const ws = new WebSocket('ws://127.0.0.1:8787/ws');
      window.__ssws = ws;
      await new Promise((res) => { ws.onopen = res; });
      ws.send(JSON.stringify({ type: 'hello', payload: { token } }));
      await new Promise((res) => { ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.type === 'hello:ok') res(); }; });
      ws.send(JSON.stringify({ type: 'room:join', payload: { roomId } }));
      await new Promise((res) => setTimeout(res, 500));
      ws.send(JSON.stringify({ type: 'screen:start', payload: { roomId } }));
    }, r1.id, await getToken(B));
    await sleep(1200);

    // ---- ③ 显式加入：A 看到「B 正在共享屏幕 [观看]」，非强制观看 ----
    const b1 = await bannerText(A);
    ok('③ A 看到共享提示横幅（含「观看」按钮）', !!b1 && b1.includes('正在共享屏幕') && b1.includes('观看'), b1 ?? '');
    ok('③ 未自动建立观看（无 viewer）', !(await A.evaluate(() => !!document.querySelector('.screen-viewer'))));
    await A.screenshot({ path: path.join(SHOT, 'ss-prompt.png') });

    // ---- ① 按会话隔离：切到 OtherRoom 横幅消失，切回再现 ----
    await selectRoom(A, 'OtherRoom');
    ok('① 切到别的房间横幅隐藏', (await bannerText(A)) === null);
    await selectRoom(A, 'ShareRoom');
    ok('① 切回共享房间横幅恢复', !!(await bannerText(A)) && (await bannerText(A)).includes('观看'));

    // ---- 点观看 → 连接中态（B 非真实共享者，流不会来）----
    await A.evaluate(() => {
      [...document.querySelectorAll('.screen-banner button')].find((b) => b.textContent.trim() === '观看')?.click();
    });
    await sleep(800);
    const b2 = await bannerText(A);
    ok('点观看后进入「正在连接…」态', !!b2 && b2.includes('正在连接'), b2 ?? '');
    await A.screenshot({ path: path.join(SHOT, 'ss-connecting.png') });

    // 取消 → 回到观看提示
    await A.evaluate(() => {
      [...document.querySelectorAll('.screen-banner button')].find((b) => b.textContent.trim() === '取消')?.click();
    });
    await sleep(600);
    const b3 = await bannerText(A);
    ok('取消观看回到提示态', !!b3 && b3.includes('观看'), b3 ?? '');

    // ---- ② 离开共享房间自动停止观看：点观看后切房，回来应是提示态而非连接/观看窗 ----
    await A.evaluate(() => {
      [...document.querySelectorAll('.screen-banner button')].find((b) => b.textContent.trim() === '观看')?.click();
    });
    await sleep(500);
    await selectRoom(A, 'OtherRoom');
    await sleep(500);
    await selectRoom(A, 'ShareRoom');
    const b4 = await bannerText(A);
    ok('② 离开共享房间后自动停止观看（回来是提示态）', !!b4 && b4.includes('观看') && !b4.includes('正在连接'), b4 ?? '');

    // 收尾：B 停止共享 → A 横幅消失
    await B.evaluate(() => { try { window.__ssws?.send(JSON.stringify({ type: 'screen:stop', payload: { roomId: window.__ssrid } })); } catch {} });
  } finally {
    await browser.close();
  }
  const failed = results.filter((r) => !r.pass);
  console.log(`\n==== ${results.length - failed.length}/${results.length} PASS ====`);
  process.exit(failed.length ? 1 : 0);
};
run().catch((e) => { console.error('SCRIPT ERROR', e); process.exit(2); });
