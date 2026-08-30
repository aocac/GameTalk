/* eslint-disable */
// 云表情包 E2E：我的表情包（云同步）/ 群共享表情 / 点选发送 / 权限删除
// 用法：node dev/e2e-stickers.mjs （需本地 server 8787 + vite 1420 已启动）
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = 'http://localhost:1420';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHOT = path.join(ROOT, 'docs', 'ui-stickers.png');
const STICKER_PNG = path.join(ROOT, 'dev', 'test-sticker.png');

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

async function openEmoji(page) {
  await page.evaluate(() => {
    [...document.querySelectorAll('.composer-icon')].pop()?.click();
  });
  await sleep(700);
}

async function uploadSticker(page) {
  // 表情包 file input 的 accept 以 gif 开头且不含 webp+gif 组合顺序差异——按 accept 精确匹配
  const inputs = await page.$$('.composer input[type=file]');
  for (const input of inputs) {
    const accept = await input.evaluate((el) => el.accept);
    if (accept === 'image/gif,image/png,image/jpeg,image/webp') {
      await input.uploadFile(STICKER_PNG);
      break;
    }
  }
  await sleep(2200);
}

const run = async () => {
  fs.writeFileSync(STICKER_PNG, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64'));
  const stamp = Date.now();
  const UA = `stk_a_${stamp}`;
  const UB = `stk_b_${stamp}`;

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

  // A 建房 + B 邀请码加入
  await A.evaluate(() => document.querySelector('.rooms-header .icon-btn')?.click());
  await sleep(400);
  await A.type('.modal input', '表情包测试房');
  await A.evaluate(() => {
    [...document.querySelectorAll('.modal button')].find((x) => x.textContent.trim() === '创建')?.click();
  });
  await sleep(1200);
  const invite = await A.$eval('.topbar-title', (el) => (el.textContent.match(/邀请码\s*([A-Z0-9]{8})/) ?? [])[1] ?? '');
  if (!invite) throw new Error('no invite');
  await B.evaluate(() => document.querySelector('.rooms-header .icon-btn')?.click());
  await sleep(400);
  const inputs = await B.$$('.modal input');
  await inputs[1].type(invite);
  await B.evaluate(() => {
    [...document.querySelectorAll('.modal button')].find((x) => x.textContent.trim() === '加入')?.click();
  });
  await sleep(1500);

  // A：我的表情包页签上传
  await openEmoji(A);
  await A.evaluate(() => {
    [...document.querySelectorAll('.emoji-tab')].find((x) => x.textContent.includes('我的表情包'))?.click();
  });
  await sleep(500);
  await uploadSticker(A);
  const mine = await A.evaluate(() => document.querySelectorAll('.emoji-pop .sticker-cell').length);
  console.log('[A mine after add]', mine);

  // A：群表情页签上传
  await A.evaluate(() => {
    [...document.querySelectorAll('.emoji-tab')].find((x) => x.textContent.includes('群表情'))?.click();
  });
  await sleep(400);
  await uploadSticker(A);
  const roomA = await A.evaluate(() => document.querySelectorAll('.emoji-pop .sticker-cell').length);
  console.log('[A room after add]', roomA);

  // B 打开群表情页签（REST 拉取全群共享）
  await openEmoji(B);
  await B.evaluate(() => {
    [...document.querySelectorAll('.emoji-tab')].find((x) => x.textContent.includes('群表情'))?.click();
  });
  await sleep(900);
  const roomB = await B.evaluate(() => document.querySelectorAll('.emoji-pop .sticker-cell').length);
  console.log('[B room sees]', roomB);

  // B 点击群表情发送 → 双端可见图片消息（确保 B 有活跃会话，B 刚加入可能未自动选中）
  const bHasConv = await B.evaluate(() => !!document.querySelector('.composer-input:not([disabled])'));
  console.log('[B composer enabled]', bHasConv);
  if (!bHasConv) {
    await B.evaluate(() => {
      [...document.querySelectorAll('.rooms .room-item')][0]?.click();
    });
    await sleep(1500);
  }
  await openEmoji(B);
  await B.evaluate(() => {
    [...document.querySelectorAll('.emoji-tab')].find((x) => x.textContent.includes('群表情'))?.click();
  });
  await sleep(900);
  // 面板若被之前的交互关掉，重新打开
  if (!(await B.$('.emoji-pop'))) await openEmoji(B);
  // 真实鼠标点击（合成 dispatchEvent 会被 React 元素树上的覆盖层吞掉，不可靠）
  {
    const btn = await B.$('.emoji-pop .sticker-img-btn');
    if (!btn) throw new Error('sticker button not found — B 面板状态异常');
    const box = await btn.boundingBox();
    await B.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  }
  await sleep(1800);
  await sleep(1300);
  const bState = await B.evaluate(() => ({
    msgs: [...document.querySelectorAll('.message.mine')].map((m) => ({
      img: !!m.querySelector('.msg-image'),
      pending: m.className.includes('pending'),
    })),
    topbar: document.querySelector('.topbar-title')?.textContent?.slice(0, 30) ?? 'NO',
    banner: document.querySelector('.banner-error')?.textContent?.slice(0, 60) ?? 'NO',
    popOpen: !!document.querySelector('.emoji-pop'),
  }));
  console.log('[B state]', JSON.stringify(bState));
  const bMsgHasImg = await B.evaluate(() => !!document.querySelector('.message.mine .msg-image'));
  const aSeesImg = await A.evaluate(() => !!document.querySelector('.message:not(.mine) .msg-image'));
  console.log('[B sent img]', bMsgHasImg, '| [A sees img]', aSeesImg);

  // A（房主）删除群表情
  await openEmoji(A);
  await A.evaluate(() => {
    [...document.querySelectorAll('.emoji-tab')].find((x) => x.textContent.includes('群表情'))?.click();
  });
  await sleep(500);
  await A.evaluate(() => document.querySelector('.emoji-pop .sticker-remove')?.click());
  await sleep(900);
  const roomAfterDel = await A.evaluate(() => document.querySelectorAll('.emoji-pop .sticker-cell').length);
  console.log('[A room after del]', roomAfterDel);

  // A reload（模拟换设备/重启）→ 我的表情包仍在（云同步）
  await A.reload({ waitUntil: 'networkidle2' });
  await sleep(2200);
  await openEmoji(A);
  await A.evaluate(() => {
    [...document.querySelectorAll('.emoji-tab')].find((x) => x.textContent.includes('我的表情包'))?.click();
  });
  await sleep(900);
  const mineAfterReload = await A.evaluate(() => document.querySelectorAll('.emoji-pop .sticker-cell').length);
  console.log('[A mine after reload]', mineAfterReload);

  const asserts = [
    ['我的表情包：上传后云端可见', mine === 1],
    ['群表情：A 添加成功', roomA >= 1],
    ['群表情：B 打开面板可见', roomB >= 1],
    ['点击群表情 → 图片消息双端可见', bMsgHasImg && aSeesImg],
    ['房主删除群表情生效', roomAfterDel === roomA - 1],
    ['我的表情包重载后仍在（云同步）', mineAfterReload === 1],
  ];
  let fail = 0;
  for (const [name, ok] of asserts) {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
    if (!ok) fail++;
  }
  await A.screenshot({ path: SHOT });
  await browser.close();
  process.exit(fail === 0 ? 0 : 1);
};

run().catch((e) => {
  console.error('E2E FAILED:', e);
  process.exit(1);
});
