/* eslint-disable */
// v0.5.2 好友面板重构回归：管理器结构 / 单击出资料页 / 双击私聊 / 私聊在线角标 / DM 头像右键菜单
// 用法：node dev/e2e-friends-052.mjs （需本地 server 8787 + vite 5199 已启动）
import puppeteer from 'puppeteer-core';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = 'http://127.0.0.1:5199';
const SHOT_DIR = 'C:/Users/Root/Desktop/AIGC/GameTalk/docs';
const stamp = Date.now();
const UA = `fp_a_${stamp}`;
const UB = `fp_b_${stamp}`;
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

  // A 建房（验证好友 Tab 主区域替换不影响房间功能）
  await A.evaluate(() => document.querySelector('.rooms-header .icon-btn')?.click());
  await sleep(400);
  await A.type('.modal input', '好友面板测试');
  await A.evaluate(() => {
    [...document.querySelectorAll('.modal button')].find((b) => b.textContent.trim() === '创建')?.click();
  });
  await sleep(1200);

  // 互加好友
  await A.evaluate(() => {
    [...document.querySelectorAll('.side-tab')].find((b) => b.textContent.includes('好友'))?.click();
  });
  await sleep(500);
  // 展开前的折叠态检查
  var panelEarly = await A.evaluate(() => ({
    addCollapsed: !document.querySelector('.friends-add'),
    toggleText: document.querySelector('.friends-add-toggle')?.textContent ?? '',
    header: document.querySelector('.friends-header')?.textContent ?? 'NO',
  }));
  console.log('[A panel-early]', JSON.stringify(panelEarly));
  // 添加好友默认折叠，先展开
  await A.evaluate(() => document.querySelector('.friends-add-toggle')?.click());
  await sleep(400);
  await A.type('.friends-add input', UB);
  await A.evaluate(() => {
    [...document.querySelectorAll('.friends-add button')].find((b) => b.textContent.includes('加好友'))?.click();
  });
  await sleep(900);
  await B.evaluate(() => {
    [...document.querySelectorAll('.side-tab')].find((b) => b.textContent.includes('好友'))?.click();
  });
  await sleep(500);
  await B.evaluate(() => {
    [...document.querySelectorAll('.friend-item button')].find((b) => b.textContent.includes('接受'))?.click();
  });
  await sleep(800);
  await B.evaluate(() => {
    [...document.querySelectorAll('.side-tab')].find((b) => b.textContent.includes('消息'))?.click();
  });
  await sleep(500);

  // A 回好友 Tab：结构断言（管理器标题 / 折叠添加钮 / 默认收起）
  await A.evaluate(() => {
    [...document.querySelectorAll('.side-tab')].find((b) => b.textContent.includes('好友'))?.click();
  });
  await sleep(700);
  const panel = panelEarly;

  // 收起添加框（加好友流程后仍展开），为后续展开测试复位
  await A.evaluate(() => {
    if (document.querySelector('.friends-add')) document.querySelector('.friends-add-toggle')?.click();
  });
  await sleep(300);

  // 单击好友 → 主区域资料页（不跳对话）
  await A.evaluate(() => document.querySelector('.friend-item')?.click());
  await sleep(900);
  const pane = await A.evaluate(() => ({
    visible: !!document.querySelector('.friend-profile-pane'),
    name: document.querySelector('.fpp-name')?.textContent ?? '',
    hasMsg: [...document.querySelectorAll('.fpp-actions .btn')].some((b) => b.textContent.includes('发消息')),
    composerHidden: !document.querySelector('.composer'),
    onlineTag: document.querySelector('.fpp-name .dm-online-tag')?.textContent ?? '',
  }));
  console.log('[A pane]', JSON.stringify(pane));
  await A.screenshot({ path: `${SHOT_DIR}/ui-friends-pane.png` });

  // 展开添加好友
  await A.evaluate(() => document.querySelector('.friends-add-toggle')?.click());
  await sleep(400);
  const addShown = await A.evaluate(() => !!document.querySelector('.friends-add input'));

  // 私聊在线角标 + DM 头像右键菜单：A 双击好友进私聊，发一条；重进看角标；B 端检查
  await A.evaluate(() => {
    const item = document.querySelector('.friend-item');
    item?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
  });
  await sleep(1400);
  const dmState = await A.evaluate(() => ({
    backToChat: !!document.querySelector('.composer'),
    topbar: document.querySelector('.topbar-title')?.textContent ?? '',
    dotOnline: getComputedStyle(document.querySelector('.dm-avatar-wrap.online') ?? document.body, '::after').backgroundColor,
  }));
  console.log('[A dm]', JSON.stringify(dmState));
  await A.type('.composer-input', '头像右键测试');
  await A.keyboard.press('Enter');
  await sleep(900);

  // B 打开私聊回一条（A 端才有对方消息头像可右键）
  await B.evaluate(() => {
    [...document.querySelectorAll('.dm-rooms .room-item')][0]?.click();
  });
  await sleep(900);
  await B.type('.composer-input', '对方的消息');
  await B.keyboard.press('Enter');
  await sleep(900);

  // A 在私聊里右键 B 的消息头像 → 二级菜单（查看资料/删除好友）
  await A.evaluate(() => {
    const other = [...document.querySelectorAll('.message:not(.mine) .message-avatar')][0]
      ?? [...document.querySelectorAll('.message-avatar')][0];
    other?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  });
  await sleep(500);
  const menu = await A.evaluate(() => [...document.querySelectorAll('.ctx-menu-item')].map((b) => b.textContent.trim()).join('|'));
  console.log('[A dm-avatar-menu]', menu);
  await A.screenshot({ path: `${SHOT_DIR}/ui-dm-avatar-menu.png` });

  // B 端私聊会话角标（A 在线 → 绿点）
  const bDot = await B.evaluate(() => {
    const el = document.querySelector('.dm-avatar-wrap.online');
    return el ? getComputedStyle(el, '::after').backgroundColor : 'NO_DOT';
  });
  console.log('[B dm dot]', bDot);

  const asserts = [
    ['好友面板：管理器标题 + 计数 + 默认折叠', panel.header.includes('好友管理') && /\d 位好友/.test(panel.header) && panel.addCollapsed && panel.toggleText.includes('添加好友')],
    ['添加好友默认折叠，可展开', panel.addCollapsed && addShown],
    ['单击好友 → 主区域显示资料页（不跳对话）', pane.visible && pane.composerHidden && pane.name.includes(UB)],
    ['资料页含「发消息」与在线标签', pane.hasMsg && pane.onlineTag.includes('在线')],
    ['双击好友 → 进入私聊', dmState.backToChat && dmState.topbar.includes(UB)],
    ['私聊会话头像在线角标（绿点）', dmState.dotOnline.includes('52, 199, 123') || dmState.dotOnline.includes('rgb(52')],
    ['私聊头像右键菜单（查看资料/删除好友）', menu.includes('查看资料') && menu.includes('删除好友')],
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
