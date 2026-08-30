/* eslint-disable */
// v0.7.0 UI 修复自验：① 悬停白字 ③ 表情小尺寸不包气泡 ④ 去「离开」按钮 + 右键退出/删除二次确认
// 用法：node dev/e2e-ui-fixes-071.mjs （需本地 server 8787 + vite 5199 已启动）
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = 'http://127.0.0.1:5199';
const ROOT = 'C:/Users/Root/Desktop/AIGC/GameTalk';
const SHOT = path.join(ROOT, 'dev', 'shots');
const STICKER_PNG = path.join(ROOT, 'dev', 'test-sticker.png');
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
    const tab = [...document.querySelectorAll('.auth-card button')].find((b) => b.textContent.trim() === '注册');
    tab?.click();
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
  return page.evaluate(() => {
    try { return JSON.parse(localStorage.getItem('gametalk-auth'))?.state?.token ?? ''; } catch { return ''; }
  });
}

async function apiCall(page, method, p, body) {
  return page.evaluate(async (m, path, b) => {
    let token = '';
    let base = 'http://127.0.0.1:8787';
    try { token = JSON.parse(localStorage.getItem('gametalk-auth'))?.state?.token ?? ''; } catch {}
    const res = await fetch(`${base}${path}`, {
      method: m,
      headers: { ...(b ? { 'Content-Type': 'application/json' } : {}), authorization: `Bearer ${token}` },
      body: b ? JSON.stringify(b) : undefined,
    });
    const t = await res.text();
    try { return { status: res.status, body: JSON.parse(t) }; } catch { return { status: res.status, body: null }; }
  }, method, p, body ?? null);
}

async function openEmoji(page) {
  await page.evaluate(() => { [...document.querySelectorAll('.composer-icon')].pop()?.click(); });
  await sleep(700);
}
async function clickEmojiTab(page, label) {
  await page.evaluate((t) => {
    [...document.querySelectorAll('.emoji-tab')].find((x) => x.textContent.includes(t))?.click();
  }, label);
  await sleep(500);
}
async function uploadSticker(page) {
  const inputs = await page.$$('.composer input[type=file]');
  for (const input of inputs) {
    const accept = await input.evaluate((el) => el.accept);
    if (accept === 'image/gif,image/png,image/jpeg,image/webp') { await input.uploadFile(STICKER_PNG); break; }
  }
  await sleep(2400);
}

async function rightClickRoomItem(page, nameMatch) {
  const box = await page.evaluate((nm) => {
    const items = [...document.querySelectorAll('.room-item')];
    const el = items.find((i) => (i.querySelector('.room-name')?.textContent ?? '').includes(nm));
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  }, nameMatch);
  if (!box) return false;
  await page.mouse.click(box.x, box.y, { button: 'right' });
  await sleep(500);
  return true;
}
function menuTexts(page) {
  return page.evaluate(() => [...document.querySelectorAll('.ctx-menu-item')].map((b) => b.textContent.trim()));
}

const run = async () => {
  fs.writeFileSync(STICKER_PNG, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64'));
  const stamp = Date.now();
  const UA = `fix_a_${stamp}`;
  const UB = `fix_b_${stamp}`;

  const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', defaultViewport: { width: 1380, height: 860 } });
  try {
    const ctxA = await browser.createBrowserContext();
    const ctxB = await browser.createBrowserContext();
    const A = await ctxA.newPage();
    const B = await ctxB.newPage();
    await register(A, UA);
    await register(B, UB);
    ok('A/B 注册登录', !!(await getToken(A)) && !!(await getToken(B)));

    // A 建两个房间（便于 hover 非活跃项）；B 加入 UIFixRoom
    const r1 = (await apiCall(A, 'POST', '/api/rooms', { name: 'UIFixRoom' })).body.room;
    const r2 = (await apiCall(A, 'POST', '/api/rooms', { name: 'SecondRoom' })).body.room;
    await apiCall(B, 'POST', '/api/rooms/join', { inviteCode: r1.inviteCode });
    await A.reload({ waitUntil: 'networkidle2' }); await sleep(1500);
    await B.reload({ waitUntil: 'networkidle2' }); await sleep(1500);

    // 选中 UIFixRoom（A）
    await A.evaluate(() => {
      const el = [...document.querySelectorAll('.room-item')].find((i) => (i.querySelector('.room-name')?.textContent ?? '').includes('UIFixRoom'));
      el?.click();
    });
    await sleep(1200);

    // ---- ④ 无「离开」按钮 ----
    const leaveBtn = await A.evaluate(() =>
      [...document.querySelectorAll('.composer button')].some((b) => b.textContent.trim() === '离开'));
    ok('④ composer 无「离开」按钮', !leaveBtn);

    // ---- ③ 发送表情并验证渲染（小尺寸 + 不包气泡）----
    await openEmoji(A);
    await clickEmojiTab(A, '我的表情包');
    await uploadSticker(A);
    await clickEmojiTab(A, '我的表情包');
    const sent = await A.evaluate(() => {
      const btn = document.querySelector('.emoji-pop .sticker-img-btn');
      if (!btn) return false;
      const r = btn.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    if (sent && sent.x) { await A.mouse.click(sent.x, sent.y); }
    await sleep(1600);
    const sticker = await A.evaluate(() => {
      const img = document.querySelector('.msg-sticker');
      if (!img) return { found: false };
      const body = img.closest('.message-body');
      const cs = getComputedStyle(img);
      const bcs = body ? getComputedStyle(body) : null;
      return {
        found: true,
        isStickerBody: !!body?.classList.contains('is-sticker'),
        width: Math.round(img.getBoundingClientRect().width),
        bg: bcs?.backgroundColor,
      };
    });
    ok('③ 表情渲染为 .msg-sticker', sticker.found);
    ok('③ 表情气泡透明（is-sticker 无背景）', sticker.isStickerBody && (sticker.bg === 'rgba(0, 0, 0, 0)' || sticker.bg === 'transparent'), `bg=${sticker.bg}`);
    ok('③ 表情尺寸小于照片（≈112px）', sticker.width > 0 && sticker.width <= 130, `w=${sticker.width}`);
    await A.screenshot({ path: path.join(SHOT, 'ui-fix-sticker.png') });

    // ---- ① hover 文字非白 ----
    await A.evaluate(() => document.querySelector('.menu-mask')?.click());
    await sleep(300);
    // 用真实鼠标移动到 SecondRoom（非活跃）条目再读色
    const hb = await A.evaluate(() => {
      const el = [...document.querySelectorAll('.room-item')].find((i) => (i.querySelector('.room-name')?.textContent ?? '').includes('SecondRoom'));
      const r = el.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    await A.mouse.move(hb.x, hb.y);
    await sleep(400);
    const nameColor = await A.evaluate(() => {
      const el = [...document.querySelectorAll('.room-item')].find((i) => (i.querySelector('.room-name')?.textContent ?? '').includes('SecondRoom'));
      const nm = el?.querySelector('.room-name');
      return nm ? getComputedStyle(nm).color : null;
    });
    // 白字 = rgb(232,234,242)；深色 = rgb(35,38,47)
    const isWhite = nameColor && /2[0-9][0-9],\s*2[0-9][0-9],\s*2[0-9][0-9]/.test(nameColor) && nameColor !== 'rgb(35, 38, 47)';
    ok('① hover 房间名文字为深色（非白）', !!nameColor && !isWhite, `color=${nameColor}`);
    await A.screenshot({ path: path.join(SHOT, 'ui-fix-hover.png') });

    // ---- ④ 房主右键：删除房间 + 二次确认 ----
    await A.evaluate(() => {
      const el = [...document.querySelectorAll('.room-item')].find((i) => (i.querySelector('.room-name')?.textContent ?? '').includes('UIFixRoom'));
      el?.click();
    });
    await sleep(600);
    await rightClickRoomItem(A, 'UIFixRoom');
    const ownerMenu = await menuTexts(A);
    ok('④ 房主右键菜单含「删除房间」', ownerMenu.some((t) => t.includes('删除房间')), ownerMenu.join('|'));
    // 点删除 → 变二次确认（不真删）
    await A.evaluate(() => {
      [...document.querySelectorAll('.ctx-menu-item')].find((b) => b.textContent.includes('删除房间'))?.click();
    });
    await sleep(400);
    const ownerConfirm = await menuTexts(A);
    ok('④ 删除需二次确认', ownerConfirm.some((t) => t.includes('确认删除')), ownerConfirm.join('|'));
    await A.screenshot({ path: path.join(SHOT, 'ui-fix-owner-menu.png') });
    await A.evaluate(() => document.querySelector('.menu-mask')?.click());

    // ---- ④ 成员右键：退出房间 + 二次确认 ----
    await B.evaluate(() => {
      const el = [...document.querySelectorAll('.room-item')].find((i) => (i.querySelector('.room-name')?.textContent ?? '').includes('UIFixRoom'));
      el?.click();
    });
    await sleep(600);
    await rightClickRoomItem(B, 'UIFixRoom');
    const memberMenu = await menuTexts(B);
    ok('④ 成员右键菜单含「退出房间」且无「删除房间」', memberMenu.some((t) => t.includes('退出房间')) && !memberMenu.some((t) => t.includes('删除房间')), memberMenu.join('|'));
    await B.evaluate(() => {
      [...document.querySelectorAll('.ctx-menu-item')].find((b) => b.textContent.includes('退出房间'))?.click();
    });
    await sleep(400);
    const memberConfirm = await menuTexts(B);
    ok('④ 退出需二次确认', memberConfirm.some((t) => t.includes('确认退出')), memberConfirm.join('|'));
    await B.screenshot({ path: path.join(SHOT, 'ui-fix-member-menu.png') });
  } finally {
    await browser.close();
  }
  const failed = results.filter((r) => !r.pass);
  console.log(`\n==== ${results.length - failed.length}/${results.length} PASS ====`);
  process.exit(failed.length ? 1 : 0);
};

run().catch((e) => { console.error('SCRIPT ERROR', e); process.exit(2); });
