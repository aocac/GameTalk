/* eslint-disable */
// 消息编辑浏览器自验：双账号房间流程（注册→建房/加入→发送→编辑→双端「已编辑」）
// 用法：node dev/e2e-edit.mjs （需本地 server 8787 + vite 5199 已启动）
import puppeteer from 'puppeteer-core';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = 'http://127.0.0.1:5199';
const SHOT_DIR = 'C:/Users/Root/Desktop/AIGC/GameTalk/docs';
const stamp = Date.now();
const UA = `edit_a_${stamp}`;
const UB = `edit_b_${stamp}`;

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

async function createRoom(page, name) {
  await page.evaluate(() => {
    const btn = document.querySelector('.rooms-header .icon-btn');
    btn?.click();
  });
  await sleep(500);
  await page.type('.modal input', name);
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll('.modal button')].find((b) => b.textContent.trim() === '创建');
    btn?.click();
  });
  await sleep(1200);
}

async function joinRoom(page, code) {
  await page.evaluate(() => {
    const btn = document.querySelector('.rooms-header .icon-btn');
    btn?.click();
  });
  await sleep(500);
  // 邀请码是弹窗里第二个 input（第一个是创建房间名）；React 受控输入必须真实键入
  const inputs = await page.$$('.modal input');
  await inputs[1].type(code);
  await sleep(300);
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll('.modal button')].find((b) => b.textContent.trim() === '加入');
    btn?.click();
  });
  await sleep(1500);
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

  await register(A, UA);
  await register(B, UB);

  // A 建房 → 拿邀请码 → B 加入。邀请码从 A 的侧栏右键菜单或顶栏取（顶栏 me-tag「邀请码 XXXXXXXX」）
  await createRoom(A, '编辑测试小队');
  const invite = await A.$eval('.topbar-title', (el) => {
    const m = el.textContent.match(/邀请码\s*([A-Z0-9]{8})/);
    return m ? m[1] : '';
  });
  if (!invite) throw new Error('无法读取邀请码');
  await joinRoom(B, invite);
  console.log('room ready, invite', invite);

  // A 发消息
  await A.type('.composer-input', '今晚八点开黑 Messgae');
  await A.keyboard.press('Enter');
  await sleep(900);

  // A 右键自己的消息 → 编辑
  await A.evaluate(() => {
    const mine = [...document.querySelectorAll('.message.mine .message-body')].pop();
    mine.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  });
  await sleep(500);
  await A.screenshot({ path: `${SHOT_DIR}/ui-edit-menu.png` });
  await A.evaluate(() => {
    const item = [...document.querySelectorAll('.ctx-menu-item')].find((b) => b.textContent.trim() === '编辑');
    item?.click();
  });
  await sleep(500);

  // 编辑模式断言：composer 填入原文 + 按钮变「保存」
  const draftVal = await A.$eval('.composer-input', (el) => el.value);
  const btnText = await A.evaluate(() => [...document.querySelectorAll('.composer .btn.primary')].map((b) => b.textContent).join(','));
  console.log('[A edit-mode] draft =', JSON.stringify(draftVal), '| buttons =', btnText);

  // 修改并提交（el.select() 全选 input 文本后输入替换）
  await A.$eval('.composer-input', (el) => {
    el.focus();
    el.select();
  });
  await A.type('.composer-input', '今晚九点开黑 Message');
  await A.keyboard.press('Enter');
  await sleep(1000);

  // A 端：文本更新 + 已编辑标记
  const aState = await A.evaluate(() => {
    const mine = [...document.querySelectorAll('.message.mine')].pop();
    return { text: mine?.querySelector('.message-text')?.textContent ?? '', edited: !!mine?.querySelector('.message-edited') };
  });
  console.log('[A after-edit]', JSON.stringify(aState));

  // B 端：广播更新
  await sleep(800);
  const bState = await B.evaluate(() => {
    const any = [...document.querySelectorAll('.message')].pop();
    return { text: any?.querySelector('.message-text')?.textContent ?? '', edited: !!any?.querySelector('.message-edited') };
  });
  console.log('[B after-edit]', JSON.stringify(bState));
  await B.screenshot({ path: `${SHOT_DIR}/ui-edit-broadcast.png` });

  // Esc 取消路径：再编辑后 Esc 应还原草稿
  await A.evaluate(() => {
    const mine = [...document.querySelectorAll('.message.mine .message-body')].pop();
    mine.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  });
  await sleep(400);
  await A.evaluate(() => {
    const item = [...document.querySelectorAll('.ctx-menu-item')].find((b) => b.textContent.trim() === '编辑');
    item?.click();
  });
  await sleep(300);
  await A.keyboard.press('Escape');
  await sleep(300);
  const afterEsc = await A.evaluate(() => ({
    draft: document.querySelector('.composer-input').value,
    bar: !!document.querySelector('.edit-bar'),
  }));
  console.log('[A after-esc]', JSON.stringify(afterEsc));

  const asserts = [
    ['编辑模式：composer 填入原文', draftVal === '今晚八点开黑 Messgae'],
    ['编辑模式：按钮变「保存」', btnText.includes('保存')],
    ['A 端文本已更新', aState.text === '今晚九点开黑 Message'],
    ['A 端显示「已编辑」', aState.edited],
    ['B 端文本已更新', bState.text === '今晚九点开黑 Message'],
    ['B 端显示「已编辑」', bState.edited],
    ['Esc 取消编辑：草稿清空 + 编辑条消失', afterEsc.draft === '' && !afterEsc.bar],
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
