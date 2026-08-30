/* eslint-disable */
// DM 功能浏览器自验：双账号全流程（注册→互加好友→发起私聊→互发→撤回→未读预览）
// 用法：node dev/e2e-dm.mjs （需本地 server 8787 + vite 5199 已启动）
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = 'http://127.0.0.1:5199';
const API = 'http://127.0.0.1:8787';
const SHOT_DIR = 'C:/Users/Root/Desktop/AIGC/GameTalk/docs';
const stamp = Date.now();
const UA = `dm_a_${stamp}`;
const UB = `dm_b_${stamp}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function register(page, username) {
  await page.goto(BASE, { waitUntil: 'networkidle2' });
  await page.waitForSelector('.auth-card', { timeout: 15000 }).catch(() => {});
  // 若已登录（localStorage 残留）则直接返回
  if (!(await page.$('.auth-card'))) return;
  // 默认是登录 tab，切到注册
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

async function switchTab(page, label) {
  await page.evaluate((text) => {
    const t = [...document.querySelectorAll('.rail-item')].find((b) => b.title.includes(text));
    if (t) t.click();
  }, label);
  await sleep(600);
}

async function addFriend(page, targetName) {
  await switchTab(page, '好友');
  // 添加好友默认折叠（QQ 式管理面板），先展开
  await page.evaluate(() => document.querySelector('.friends-add-toggle')?.click());
  await sleep(400);
  await page.type('.friends-add input', targetName);
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll('.friends-add button')].find((b) => b.textContent.includes('加好友'));
    btn?.click();
  });
  await sleep(1000);
}

async function acceptIncoming(page) {
  await switchTab(page, '好友');
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll('.friend-item button')].find((b) => b.textContent.includes('接受'));
    btn?.click();
  });
  await sleep(1000);
  // 接受后切回「消息」tab：私聊会话列表在消息 tab 下
  await switchTab(page, '消息');
}

const run = async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--window-size=1440,900'],
    defaultViewport: { width: 1380, height: 860 },
  });

  const ctxA = await browser.createBrowserContext();
  const ctxB = await browser.createBrowserContext();
  const A = await ctxA.newPage();
  const B = await ctxB.newPage();
  A.on('pageerror', (e) => console.log('[A pageerror]', e.message));
  B.on('pageerror', (e) => console.log('[B pageerror]', e.message));

  // 1. 双账号注册
  await register(A, UA);
  await register(B, UB);
  console.log('registered', UA, UB);

  // 2. A 加 B 好友；B 接受
  await A.screenshot({ path: `${SHOT_DIR}/ui-dm-debug-a.png` });
  await addFriend(A, UB);
  await acceptIncoming(B);

  // 3. A 好友面板双击好友 → 打开 DM（单击 = 资料页）
  await A.evaluate((ub) => {
    const item = [...document.querySelectorAll('.friend-item')].find((el) => el.textContent.includes(ub));
    item?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
  }, UB);
  await sleep(1200);
  await A.screenshot({ path: `${SHOT_DIR}/ui-dm-open.png` });
  console.log('shot: ui-dm-open.png');

  // 4. A 发两条消息
  await A.type('.composer-input', '在吗，双排吗？');
  await A.keyboard.press('Enter');
  await sleep(600);
  await A.type('.composer-input', '发个图给你看');
  await A.keyboard.press('Enter');
  await sleep(900);

  // 5. B 端：侧栏私聊预览 + 未读 + 打开会话
  const bSidebar = await B.evaluate(() => document.querySelector('.dm-rooms')?.textContent ?? 'NO_DM_SIDEBAR');
  console.log('[B sidebar]', bSidebar.slice(0, 120));
  await B.screenshot({ path: `${SHOT_DIR}/ui-dm-unread.png` });
  await B.evaluate(() => {
    const item = [...document.querySelectorAll('.dm-rooms .room-item')][0];
    item?.click();
  });
  await sleep(1200);
  await B.screenshot({ path: `${SHOT_DIR}/ui-dm-chat-b.png` });
  console.log('shot: ui-dm-chat-b.png');

  // 6. B 回复 → A 先确认收到回复
  await B.type('.composer-input', '来了，等我一把结束');
  await B.keyboard.press('Enter');
  await sleep(1200);
  const aMid = await A.evaluate(() => document.querySelector('.messages')?.innerText ?? '');
  console.log('[A mid]', aMid.replace(/\n/g, ' | ').slice(0, 260));

  // 7. B 撤回自己的消息 → A 端变撤回占位
  await B.evaluate(() => {
    const mine = [...document.querySelectorAll('.message.mine .message-body')].pop();
    const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    mine.dispatchEvent(ev);
  });
  await sleep(600);
  await B.evaluate(() => {
    const item = [...document.querySelectorAll('.ctx-menu-item')].find((b) => b.textContent.includes('撤回'));
    item?.click();
  });
  await sleep(1000);
  await B.screenshot({ path: `${SHOT_DIR}/ui-dm-recalled.png` });
  console.log('shot: ui-dm-recalled.png');

  // 8. A 端最终态
  await sleep(800);
  const aTexts = await A.evaluate(() => document.querySelector('.messages')?.innerText ?? '');
  console.log('[A messages]', aTexts.replace(/\n/g, ' | ').slice(0, 260));
  await A.screenshot({ path: `${SHOT_DIR}/ui-dm-chat-a.png` });
  console.log('shot: ui-dm-chat-a.png');

  // 断言汇总
  const asserts = [
    ['A 侧栏打开 DM（顶栏显示好友名）', (await A.$eval('.topbar-title', (el) => el.textContent)).includes(UB)],
    ['B 侧栏私聊预览（最新一条）', bSidebar.includes('发个图给你看')],
    ['A 收到 B 的回复', aMid.includes('来了，等我一把结束')],
    ['A 看到撤回提示', aTexts.includes('撤回了一条消息')],
  ];
  let fail = 0;
  for (const [name, ok] of asserts) {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
    if (!ok) fail++;
  }
  await browser.close();
  process.exit(fail === 0 ? 0 : 1);
};

run().catch((e) => {
  console.error('E2E FAILED:', e);
  process.exit(1);
});
