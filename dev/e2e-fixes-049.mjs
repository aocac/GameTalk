/* eslint-disable */
// v0.4.9 修复回归验证：编辑标识(分组消息)/撤回预览文案/DM 高亮互斥/DM 空态/草稿独立
// 用法：node dev/e2e-fixes-049.mjs （需本地 server 8787 + vite 5199 已启动）
import puppeteer from 'puppeteer-core';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = 'http://127.0.0.1:5199';
const SHOT_DIR = 'C:/Users/Root/Desktop/AIGC/GameTalk/docs';
const stamp = Date.now();
const UA = `fx_a_${stamp}`;
const UB = `fx_b_${stamp}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

async function addFriendAndAccept(pa, pb, ub) {
  await pa.evaluate(() => {
    const t = [...document.querySelectorAll('.rail-item')].find((b) => b.title.includes('好友'));
    t?.click();
  });
  await sleep(500);
  // 添加好友默认折叠，先展开
  await pa.evaluate(() => document.querySelector('.friends-add-toggle')?.click());
  await sleep(400);
  await pa.type('.friends-add input', ub);
  await pa.evaluate(() => {
    [...document.querySelectorAll('.friends-add button')].find((b) => b.textContent.includes('加好友'))?.click();
  });
  await sleep(900);
  await pb.evaluate(() => {
    const t = [...document.querySelectorAll('.rail-item')].find((b) => b.title.includes('好友'));
    t?.click();
  });
  await sleep(500);
  await pb.evaluate(() => {
    [...document.querySelectorAll('.friend-item button')].find((b) => b.textContent.includes('接受'))?.click();
  });
  await sleep(800);
  // 双方切回消息 tab
  for (const p of [pa, pb]) {
    await p.evaluate(() => {
      const t = [...document.querySelectorAll('.rail-item')].find((b) => b.title.includes('消息'));
      t?.click();
    });
  }
  await sleep(400);
}

async function openDmByFriendClick(page) {
  // 切好友 tab 单击好友（QQ 式直接进入私聊）→ 再切回消息 tab 验证会话区
  await page.evaluate(() => {
    const t = [...document.querySelectorAll('.rail-item')].find((b) => b.title.includes('好友'));
    t?.click();
  });
  await sleep(500);
  await page.evaluate(() => {
    [...document.querySelectorAll('.friend-item')][0]?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
  });
  await sleep(1200);
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

  await register(A, UA);
  await register(B, UB);

  // A 建房（后续验证「进入 DM 后房间不高亮」需要至少一个房间）
  await A.evaluate(() => document.querySelector('.rooms-header .icon-btn')?.click());
  await sleep(400);
  await A.type('.modal input', '修复验证小队');
  await A.evaluate(() => {
    [...document.querySelectorAll('.modal button')].find((b) => b.textContent.trim() === '创建')?.click();
  });
  await sleep(1200);

  await addFriendAndAccept(A, B, UB);
  await openDmByFriendClick(A);
  const topbarDm = await A.$eval('.topbar-title', (el) => el.textContent);

  // A 连发两条（同人连发 → 第二条 grouped）
  await A.type('.composer-input', '第一条消息');
  await A.keyboard.press('Enter');
  await sleep(500);
  await A.type('.composer-input', '第二条消息');
  await A.keyboard.press('Enter');
  await sleep(800);

  // 编辑第二条（grouped 消息）→ 已编辑标记必须可见
  await A.evaluate(() => {
    const mine = [...document.querySelectorAll('.message.mine')];
    const second = mine[mine.length - 1];
    second.querySelector('.message-body').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
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
  await A.type('.composer-input', '第二条改好了');
  await A.keyboard.press('Enter');
  await sleep(900);
  const aEdited = await A.evaluate(() => {
    const mine = [...document.querySelectorAll('.message.mine')];
    const second = mine[mine.length - 1];
    return { text: second.querySelector('.message-text')?.textContent ?? '', edited: !!second.querySelector('.message-edited') };
  });
  await A.screenshot({ path: `${SHOT_DIR}/ui-fix-grouped-edited.png` });

  // A 撤回最新一条（预览只反映最新消息）→ 侧栏 DM 预览应显示「你撤回了一条消息」（无冒号）
  await A.evaluate(() => {
    const last = [...document.querySelectorAll('.message.mine')].pop();
    last.querySelector('.message-body').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  });
  await sleep(400);
  await A.evaluate(() => {
    [...document.querySelectorAll('.ctx-menu-item')].find((b) => b.textContent.includes('撤回'))?.click();
  });
  await sleep(900);
  const aDmPreview = await A.evaluate(() => document.querySelector('.dm-rooms .room-preview')?.textContent ?? '');
  const aRecallLine = await A.evaluate(() => [...document.querySelectorAll('.recall-line')].map((el) => el.textContent).join('|'));

  // B 端撤回预览（对方视角「fx_a_xxx撤回了一条消息」）
  const bDmPreview = await B.evaluate(() => document.querySelector('.dm-rooms .room-preview')?.textContent ?? 'NO_PREVIEW');

  // 房间不高亮：A 在 DM 会话时房间项无 active
  const roomActive = await A.evaluate(() => document.querySelector('.rooms:not(.dm-rooms) .room-item.active')?.textContent ?? 'NONE');
  await A.screenshot({ path: `${SHOT_DIR}/ui-fix-dm-state.png` });

  // DM 空态叠加检查：B 尚未与 A 互发（B 打开空会话）→ 不应出现「欢迎来到 #」
  await B.evaluate(() => {
    [...document.querySelectorAll('.dm-rooms .room-item')][0]?.click();
  });
  await sleep(900);
  const bEmptyText = await B.evaluate(() => document.querySelector('.messages')?.innerText ?? '');

  // 草稿独立：A 在 DM 输入草稿 → 切房间 → 草稿应为空 → 切回 DM → 草稿恢复
  await A.type('.composer-input', '私聊草稿ABC');
  await A.evaluate(() => {
    [...document.querySelectorAll('.rooms:not(.dm-rooms) .room-item')][0]?.click();
  });
  await sleep(700);
  const draftInRoom = await A.$eval('.composer-input', (el) => el.value);
  await A.evaluate(() => {
    [...document.querySelectorAll('.dm-rooms .room-item')][0]?.click();
  });
  await sleep(700);
  const draftBackInDm = await A.$eval('.composer-input', (el) => el.value);

  console.log('[A topbar]', topbarDm.slice(0, 40));
  console.log('[A second-msg]', JSON.stringify(aEdited));
  console.log('[A dm-preview]', aDmPreview, '| recall-line:', aRecallLine);
  console.log('[B dm-preview]', bDmPreview);
  console.log('[room-active]', roomActive.slice(0, 40));
  console.log('[B empty]', bEmptyText.replace(/\n/g, '|').slice(0, 120));
  console.log('[draft] room =', JSON.stringify(draftInRoom), '| back-in-dm =', JSON.stringify(draftBackInDm));

  const asserts = [
    ['A 单击好友直接进入私聊（顶栏显示好友名）', topbarDm.includes(UB)],
    ['分组（第二条）消息编辑后「已编辑」可见', aEdited.edited && aEdited.text === '第二条改好了'],
    ['A 撤回后 DM 预览 =「你撤回了一条消息」', aDmPreview === '你撤回了一条消息'],
    ['B 撤回预览 =「xx撤回了一条消息」（无冒号）', new RegExp(`^${UA}撤回了一条消息$`).test(bDmPreview)],
    ['进入 DM 后房间不高亮', roomActive === 'NONE'],
    ['DM 空会话不显示「欢迎来到 #房间」', !bEmptyText.includes('欢迎来到')],
    ['切换会话后房间草稿为空（不串扰）', draftInRoom === ''],
    ['切回 DM 草稿恢复', draftBackInDm === '私聊草稿ABC'],
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
