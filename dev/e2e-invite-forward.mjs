/* eslint-disable */
// 邀请链接 + 消息转发 浏览器自验：双账号全流程
// 用法：node dev/e2e-invite-forward.mjs （需本地 server 8787 + vite 5199 已启动）
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = 'http://127.0.0.1:5199';
const API = 'http://127.0.0.1:8787';
const SHOT_DIR = 'C:/Users/Root/Desktop/AIGC/GameTalk/dev/shots';
const stamp = Date.now();
const UA = `fwd_a_${stamp}`;
const UB = `fwd_b_${stamp}`;
fs.mkdirSync(SHOT_DIR, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function ok(name, cond) {
  results.push({ name, pass: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`);
}

async function register(page, username) {
  await page.goto(BASE, { waitUntil: 'networkidle2' });
  await page.waitForSelector('.auth-card', { timeout: 15000 }).catch(() => {});
  if (!(await page.$('.auth-card'))) return;
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
    try {
      const raw = localStorage.getItem('gametalk-auth');
      return raw ? (JSON.parse(raw)?.state?.token ?? '') : '';
    } catch {
      return '';
    }
  });
}

/** 在页面上下文里带 token 调 API（同源无 CORS 问题） */
async function apiCall(page, method, path, body) {
  return page.evaluate(
    async (m, p, b) => {
      let token = '';
      let base = 'http://127.0.0.1:8787';
      try {
        const raw = localStorage.getItem('gametalk-auth');
        token = raw ? (JSON.parse(raw)?.state?.token ?? '') : '';
      } catch {}
      try {
        const rawS = localStorage.getItem('gametalk-settings');
        if (rawS) base = JSON.parse(rawS)?.state?.serverUrl ?? base;
      } catch {}
      const res = await fetch(`${base.replace(/\/+$/, '')}${p}`, {
        method: m,
        headers: { ...(b ? { 'Content-Type': 'application/json' } : {}), authorization: `Bearer ${token}` },
        body: b ? JSON.stringify(b) : undefined,
      });
      const text = await res.text();
      try { return { status: res.status, body: JSON.parse(text) }; } catch { return { status: res.status, body: null }; }
    },
    method,
    path,
    body ?? null,
  );
}

async function switchTab(page, title) {
  await page.evaluate((t) => {
    const item = [...document.querySelectorAll('.rail-item')].find((b) => (b.title ?? '').includes(t));
    if (item) item.click();
  }, title);
  await sleep(600);
}

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: false,
  args: ['--window-size=1360,900', '--disable-features=Translate'],
  defaultViewport: { width: 1320, height: 860 },
});

try {
  // 双账号必须用隔离的浏览器上下文：同一 origin 的 localStorage 是共享的，
  // 否则后注册的账号会覆盖先登录者的 token（两端实际变成同一人）
  const ctxA = typeof browser.createBrowserContext === 'function'
    ? await browser.createBrowserContext()
    : await browser.createIncognitoBrowserContext();
  const ctxB = typeof browser.createBrowserContext === 'function'
    ? await browser.createBrowserContext()
    : await browser.createIncognitoBrowserContext();
  const pageA = await ctxA.newPage();
  const pageB = await ctxB.newPage();
  await register(pageA, UA);
  await register(pageB, UB);
  const tokenA = await getToken(pageA);
  const tokenB = await getToken(pageB);
  ok('A 注册并登录', !!tokenA);
  ok('B 注册并登录', !!tokenB);

  // API 准备：A 建 R1、R2；B 加入 R1；AB 互加好友
  const room1 = (await apiCall(pageA, 'POST', '/api/rooms', { name: '转发源房' })).body.room;
  const room2 = (await apiCall(pageA, 'POST', '/api/rooms', { name: '深链目标房' })).body.room;
  await apiCall(pageB, 'POST', '/api/rooms/join', { inviteCode: room1.inviteCode });
  // 注意：apiCall 用各页面自己的 token，/api/auth/me 返回的是该页面用户本人
  const userIdA = (await apiCall(pageA, 'GET', '/api/auth/me')).body.user.id;
  const userIdB = (await apiCall(pageB, 'GET', '/api/auth/me')).body.user.id;
  const reqA = await apiCall(pageA, 'POST', '/api/friends/requests', { userId: userIdB });
  const reqB = await apiCall(pageB, 'POST', '/api/friends/requests', { userId: userIdA });
  console.log('[friendA]', JSON.stringify(reqA).slice(0, 200));
  console.log('[friendB]', JSON.stringify(reqB).slice(0, 200));
  const listA = await apiCall(pageA, 'GET', '/api/friends');
  console.log('[friendsA]', JSON.stringify(listA.body?.friends ?? []).slice(0, 200));
  ok('API 准备（房间+好友）', !!room1?.id && !!room2?.id);

  // 两端刷新进入聊天界面并选中 R1
  for (const p of [pageA, pageB]) {
    await p.reload({ waitUntil: 'networkidle2' });
    await sleep(1500);
  }
  await switchTab(pageA, '聊天');
  await switchTab(pageB, '聊天');
  await pageA.evaluate((id) => {
    const item = [...document.querySelectorAll('.room-item')].find((r) => r.dataset?.id === id || r.getAttribute('data-id') === id);
    const fallback = [...document.querySelectorAll('.room-item')].find((r) => r.textContent.includes('转发源房'));
    (item ?? fallback)?.click();
  }, room1.id);
  await sleep(1200);

  // A 在 R1 发消息
  const composer = await pageA.$('input.composer-input');
  if (composer) {
    await composer.type('这条消息将被转发');
    await pageA.keyboard.press('Enter');
    await sleep(1200);
  }
  const sentText = await pageA.evaluate(() => document.body.innerText.includes('这条消息将被转发'));
  ok('A 发送消息', sentText);

  // A 右键消息 → 转发 → 选好友 B（先切好友 tab 触发好友列表加载，再回消息 tab）
  await switchTab(pageA, '好友');
  await sleep(900);
  await switchTab(pageA, '消息');
  await pageA.evaluate(() => {
    const bodies = [...document.querySelectorAll('.message-body')];
    const target = bodies.reverse().find((b) => b.textContent.includes('这条消息将被转发'));
    const rect = target.getBoundingClientRect();
    target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: rect.x + 20, clientY: rect.y + 10 }));
  });
  await sleep(500);
  const menuShown = await pageA.evaluate(() => [...document.querySelectorAll('.ctx-menu-item')].some((b) => b.textContent.trim() === '转发'));
  ok('右键菜单含「转发」', menuShown);
  await pageA.evaluate(() => {
    const btn = [...document.querySelectorAll('.ctx-menu-item')].find((b) => b.textContent.trim() === '转发');
    btn?.click();
  });
  await sleep(600);
  const pickerShown = await pageA.$('.forward-modal');
  ok('转发选择器弹出', !!pickerShown);
  if (!pickerShown) {
    console.log('[debug A]', await pageA.evaluate(() => document.body.innerText.slice(0, 200)));
  }
  await pageA.screenshot({ path: `${SHOT_DIR}/forward-picker.png` });
  const pickerText = await pageA.evaluate(() => document.querySelector('.forward-modal')?.innerText ?? 'NO_PICKER');
  console.log('[picker]', pickerText.split(String.fromCharCode(10)).join(' | ').slice(0, 160));
  // 选择转发给好友 B
  await pageA.evaluate((name) => {
    const items = [...document.querySelectorAll('.forward-item')];
    const t = items.find((i) => i.textContent.includes(name));
    t?.click();
  }, UB);
  await sleep(1200);

  // B 端：DM 会话出现在「消息」tab 侧栏（.dm-rooms），点击打开
  await switchTab(pageB, '消息');
  await pageB.evaluate(() => {
    const item = [...document.querySelectorAll('.dm-rooms .room-item')][0];
    item?.click();
  });
  await sleep(1200);
  const bDmDump = await pageB.evaluate(() => ({
    dmSidebar: document.querySelector('.dm-rooms')?.innerText ?? 'NO_DM_SIDEBAR',
    msgs: document.querySelector('.messages')?.innerText?.slice(0, 300) ?? 'NO_MESSAGES',
  }));
  console.log('[B dump]', JSON.stringify(bDmDump).slice(0, 300));
  const dmGot = await pageB.evaluate(() => {
    const bubbles = [...document.querySelectorAll('.message')];
    const m = bubbles.reverse().find((x) => x.textContent.includes('这条消息将被转发'));
    return !!m && !!m.querySelector('.message-forwarded');
  });
  ok('B 私聊收到带转发角标的消息', dmGot);
  await pageB.screenshot({ path: `${SHOT_DIR}/forward-dm-badge.png` });

  // B 在 DM 里右键该消息 → 转发回房间 R1
  await pageB.evaluate(() => {
    const bodies = [...document.querySelectorAll('.message-body')];
    const target = bodies.reverse().find((b) => b.textContent.includes('这条消息将被转发'));
    const rect = target.getBoundingClientRect();
    target.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: rect.x + 20, clientY: rect.y + 10 }));
  });
  await sleep(500);
  await pageB.evaluate(() => {
    const btn = [...document.querySelectorAll('.ctx-menu-item')].find((b) => b.textContent.trim() === '转发');
    btn?.click();
  });
  await sleep(600);
  await pageB.evaluate((roomName) => {
    const items = [...document.querySelectorAll('.forward-item')];
    const t = items.find((i) => i.textContent.includes(roomName));
    t?.click();
  }, '转发源房');
  await sleep(1200);

  // A 回到 R1 验证房间转发消息（来源标签=私聊）
  await switchTab(pageA, '聊天');
  await pageA.evaluate(() => {
    const item = [...document.querySelectorAll('.room-item')].find((r) => r.textContent.includes('转发源房'));
    item?.click();
  });
  await sleep(1200);
  const roomFwd = await pageA.evaluate(() => {
    const bubbles = [...document.querySelectorAll('.message')];
    const m = bubbles.reverse().find((x) => x.textContent.includes('这条消息将被转发') && x.querySelector('.message-forwarded'));
    return m ? m.querySelector('.message-forwarded').textContent : '';
  });
  ok('A 房间收到 B 的转发（含角标）', roomFwd === '转发');
  await pageA.screenshot({ path: `${SHOT_DIR}/forward-room.png` });

  // 邀请链接面板：A 右键 R2（深链目标房，B 未加入）→ 邀请链接 → 生成
  switchTab(pageA, '消息');
  await sleep(600);
  await pageA.evaluate(() => {
    const item = [...document.querySelectorAll('.room-item')].find((r) => r.textContent.includes('深链目标房'));
    const rect = item.getBoundingClientRect();
    item.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: rect.x + 30, clientY: rect.y + 8 }));
  });
  await sleep(500);
  await pageA.evaluate(() => {
    const btn = [...document.querySelectorAll('.ctx-menu-item')].find((b) => b.textContent.includes('邀请链接'));
    btn?.click();
  });
  await sleep(800);
  const panelShown = await pageA.$('.invite-modal');
  ok('邀请链接面板打开', !!panelShown);
  await pageA.evaluate(() => {
    const btn = [...document.querySelectorAll('.invite-modal .btn.primary')].find((b) => b.textContent.includes('生成链接'));
    btn?.click();
  });
  await sleep(1200);
  const linkCreated = await pageA.evaluate(() => !!document.querySelector('.invite-item .invite-code'));
  ok('邀请链接生成并出现在列表', linkCreated);
  await pageA.screenshot({ path: `${SHOT_DIR}/invite-panel.png` });
  // 复制出的 code 从面板 UI 抓取（供深链验证）
  const linkCode = await pageA.evaluate(() => document.querySelector('.invite-item .invite-code')?.textContent ?? '');
  ok('拿到链接 code', /^[A-Z0-9]{16}$/.test(linkCode));

  // 深链确认弹窗：B 侧模拟 gametalk://join?code=xxx 拉起（浏览器直接写中转键）
  await pageB.evaluate((code) => {
    localStorage.setItem('gametalk_pending_invite', code);
    window.dispatchEvent(new CustomEvent('gametalk-invite'));
  }, linkCode);
  await sleep(1500);
  const confirmShown = await pageB.$('.invite-confirm');
  ok('深链确认弹窗出现', !!confirmShown);
  const previewOk = await pageB.evaluate(() => document.body.innerText.includes('深链目标房'));
  ok('预览显示目标房间名', previewOk);
  await pageB.screenshot({ path: `${SHOT_DIR}/deeplink-confirm.png` });
  await pageB.evaluate(() => {
    const btn = [...document.querySelectorAll('.invite-confirm .btn.primary')].find((b) => b.textContent.includes('加入'));
    btn?.click();
  });
  await sleep(2500);
  const joined = await pageB.evaluate((name) => [...document.querySelectorAll('.room-item')].some((r) => r.textContent.includes(name)), '深链目标房');
  ok('B 经深链加入房间并出现在列表', joined);

  // 汇总
  const failed = results.filter((r) => !r.pass);
  console.log(`\n==== 结果：${results.length - failed.length}/${results.length} 通过 ====`);
  if (failed.length) {
    console.log('失败项:', failed.map((f) => f.name).join(' | '));
    process.exitCode = 1;
  }
} finally {
  await browser.close();
}
