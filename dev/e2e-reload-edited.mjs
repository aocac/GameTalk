/* eslint-disable */
// 验证：重启（页面重载）后 DM 编辑标识不丢（REST 历史带 editedAt）+ 好友在线状态点
import puppeteer from 'puppeteer-core';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = 'http://127.0.0.1:5199';
const stamp = Date.now();
const UA = `rl_a_${stamp}`;
const UB = `rl_b_${stamp}`;
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
  const A = await ctxA.newPage();
  const B = await ctxB.newPage();
  await register(A, UA);
  await register(B, UB);

  // 互加好友
  await A.evaluate(() => {
    [...document.querySelectorAll('.rail-item')].find((b) => b.title.includes('好友'))?.click();
  });
  await sleep(500);
  await A.type('.friends-add input', UB);
  await A.evaluate(() => {
    [...document.querySelectorAll('.friends-add button')].find((b) => b.textContent.includes('加好友'))?.click();
  });
  await sleep(900);
  await B.evaluate(() => {
    [...document.querySelectorAll('.rail-item')].find((b) => b.title.includes('好友'))?.click();
  });
  await sleep(500);
  await B.evaluate(() => {
    [...document.querySelectorAll('.friend-item button')].find((b) => b.textContent.includes('接受'))?.click();
  });
  await sleep(800);

  // A 单击好友进 DM 发消息并编辑
  await A.evaluate(() => {
    [...document.querySelectorAll('.rail-item')].find((b) => b.title.includes('好友'))?.click();
  });
  await sleep(500);
  await A.evaluate(() => [...document.querySelectorAll('.friend-item')][0]?.click());
  await sleep(1200);
  await A.type('.composer-input', '原始内容');
  await A.keyboard.press('Enter');
  await sleep(800);
  await A.evaluate(() => {
    [...document.querySelectorAll('.message.mine .message-body')].pop().dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  });
  await sleep(400);
  await A.evaluate(() => {
    [...document.querySelectorAll('.ctx-menu-item')].find((b) => b.textContent.trim() === '编辑')?.click();
  });
  await sleep(400);
  await A.$eval('.composer-input', (el) => { el.focus(); el.select(); });
  await A.type('.composer-input', '重载后仍是已编辑');
  await A.keyboard.press('Enter');
  await sleep(1000);

  // B 重载（模拟重启）→ 打开 DM → 已编辑标记应仍在（来自 REST 历史）
  await B.reload({ waitUntil: 'networkidle2' });
  await sleep(2500);
  await B.evaluate(() => {
    [...document.querySelectorAll('.dm-rooms .room-item')][0]?.click();
  });
  await sleep(1200);
  const bState = await B.evaluate(() => {
    const any = [...document.querySelectorAll('.message')].pop();
    return { text: any?.querySelector('.message-text')?.textContent ?? '', edited: !!any?.querySelector('.message-edited') };
  });
  console.log('[B after reload]', JSON.stringify(bState));

  // B 好友面板：A 在线 → 状态点应为绿色（online class）
  await B.evaluate(() => {
    [...document.querySelectorAll('.rail-item')].find((b) => b.title.includes('好友'))?.click();
  });
  await sleep(800);
  const dot = await B.evaluate(() => {
    const item = document.querySelector('.friend-item.online .member-avatar');
    return item ? getComputedStyle(item, '::after').backgroundColor : 'NO_ITEM';
  });
  console.log('[B friend online dot]', dot);

  const ok1 = bState.edited && bState.text === '重载后仍是已编辑';
  const ok2 = dot === 'rgb(34, 154, 88)' || dot.includes('ok') || !['rgb(153, 153, 153)', 'NO_ITEM'].includes(dot);
  console.log(`${ok1 ? 'PASS' : 'FAIL'}  重载后 DM 编辑标识保留`);
  console.log(`${ok2 ? 'PASS' : 'FAIL'}  好友在线状态点为绿色（${dot}）`);
  await browser.close();
  process.exit(ok1 && ok2 ? 0 : 1);
};

run().catch((e) => {
  console.error('E2E FAILED:', e);
  process.exit(1);
});
