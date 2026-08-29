/* eslint-disable */
// v0.5.0 修复回归：编辑同步预览 / 房主代撤文案 / 撤回预览操作者 / 通知中心移除
// 用法：node dev/e2e-fixes-050.mjs （需本地 server 8787 + vite 5199 已启动）
import puppeteer from 'puppeteer-core';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = 'http://127.0.0.1:5199';
const SHOT_DIR = 'C:/Users/Root/Desktop/AIGC/GameTalk/docs';
const stamp = Date.now();
const UA = `v50_a_${stamp}`; // 房主
const UB = `v50_b_${stamp}`; // 成员

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function register(page, username) {
  await page.goto(BASE, { waitUntil: 'networkidle2' });
  await page.waitForSelector('.auth-card', { timeout: 15000 }).catch(() => {});
  if (!(await page.$('.auth-card'))) return;
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

const run = async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    defaultViewport: { width: 1380, height: 860 },
  });
  const ctxA = await browser.createBrowserContext();
  const ctxB = await browser.createBrowserContext();
  const A = await ctxA.newPage(); // 房主
  const B = await ctxB.newPage(); // 成员
  await register(A, UA);
  await register(B, UB);

  // A 建房 → 邀请码 → B 加入
  await A.evaluate(() => document.querySelector('.rooms-header .icon-btn')?.click());
  await sleep(400);
  await A.type('.modal input', '撤回文案测试');
  await A.evaluate(() => {
    [...document.querySelectorAll('.modal button')].find((b) => b.textContent.trim() === '创建')?.click();
  });
  await sleep(1200);
  const invite = await A.$eval('.topbar-title', (el) => (el.textContent.match(/邀请码\s*([A-Z0-9]{8})/) ?? [])[1] ?? '');
  if (!invite) throw new Error('no invite');
  await B.evaluate(() => document.querySelector('.rooms-header .icon-btn')?.click());
  await sleep(400);
  const inputs = await B.$$('.modal input');
  await inputs[1].type(invite);
  await B.evaluate(() => {
    [...document.querySelectorAll('.modal button')].find((b) => b.textContent.trim() === '加入')?.click();
  });
  await sleep(1500);

  // B 发一条 → A（房主）撤回 B 的消息
  await B.type('.composer-input', '群员的发言');
  await B.keyboard.press('Enter');
  await sleep(900);
  await A.evaluate(() => {
    const other = [...document.querySelectorAll('.message:not(.mine)')].pop();
    other.querySelector('.message-body').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  });
  await sleep(400);
  await A.evaluate(() => {
    [...document.querySelectorAll('.ctx-menu-item')].find((b) => b.textContent.includes('撤回'))?.click();
  });
  await sleep(900);

  // B 端撤回行文案：「v50_a_xxx撤回了 v50_b_xxx 的消息」
  const bRecallLine = await B.evaluate(() => document.querySelector('.recall-line')?.textContent ?? 'NO_LINE');
  // 房间预览（最后一条被撤）：作者应为房主 A
  const bPreview = await B.evaluate(() => {
    const p = [...document.querySelectorAll('.rooms:not(.dm-rooms) .room-preview')][0];
    return p?.textContent ?? 'NO_PREVIEW';
  });
  console.log('[B recall-line]', bRecallLine);
  console.log('[B preview]', bPreview);

  // 编辑同步预览：A 发一条 → 预览=原文 → A 编辑 → 预览变新文本
  await A.type('.composer-input', '预览原文ABC');
  await A.keyboard.press('Enter');
  await sleep(800);
  const aPreviewBefore = await A.evaluate(() => document.querySelector('.rooms:not(.dm-rooms) .room-preview')?.textContent ?? '');
  await A.evaluate(() => {
    [...document.querySelectorAll('.message.mine .message-body')].pop().dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  });
  await sleep(400);
  await A.evaluate(() => {
    [...document.querySelectorAll('.ctx-menu-item')].find((b) => b.textContent.trim() === '编辑')?.click();
  });
  await sleep(400);
  await A.$eval('.composer-input', (el) => {
    el.focus();
    el.select();
  });
  await A.type('.composer-input', '预览改后XYZ');
  await A.keyboard.press('Enter');
  await sleep(900);
  const aPreviewAfter = await A.evaluate(() => document.querySelector('.rooms:not(.dm-rooms) .room-preview')?.textContent ?? '');
  console.log('[A preview before]', aPreviewBefore, '| after:', aPreviewAfter);

  // B 端编辑预览同步
  const bPreviewAfter = await B.evaluate(() => document.querySelector('.rooms:not(.dm-rooms) .room-preview')?.textContent ?? '');
  console.log('[B preview after]', bPreviewAfter);

  // 通知中心移除：铃铛按钮不应存在
  const bellGone = await B.evaluate(() => !document.querySelector('.bell-btn') && !document.querySelector('.notif-panel'));

  const asserts = [
    ['房主代撤文案 =「房主撤回了 群员 的消息」', bRecallLine === `${UA}撤回了 ${UB} 的消息`],
    ['撤回后房间预览作者 = 房主', bPreview === `${UA}撤回了一条消息`],
    ['编辑前预览 = 原文', aPreviewBefore === `${UA}：预览原文ABC`],
    ['A 编辑后预览同步新文本', aPreviewAfter === `${UA}：预览改后XYZ`],
    ['B 编辑后预览同步新文本', bPreviewAfter === `${UA}：预览改后XYZ`],
    ['通知中心（铃铛）已移除', bellGone],
  ];
  let fail = 0;
  for (const [name, ok] of asserts) {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
    if (!ok) fail++;
  }
  await A.screenshot({ path: `${SHOT_DIR}/ui-fix-050.png` });
  await browser.close();
  process.exit(fail === 0 ? 0 : 1);
};

run().catch((e) => {
  console.error('E2E FAILED:', e);
  process.exit(1);
});
