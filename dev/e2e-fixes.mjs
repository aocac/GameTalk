// 一次性 E2E：引用气泡 / 空白右键不弹菜单 / 头像右键成员菜单 / 复制图片项 / 灯箱拖拽修复 / hover 灰底移除
import puppeteer from 'puppeteer-core'
import { writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const IMG_PATH = join(tmpdir(), 'gt-e2e-upload.png')
writeFileSync(
  IMG_PATH,
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAAWklEQVR4nO3PMQHAIBDAsPP4F/HMgKANJDvXzOwPnPl2wOsMjAyMDIwMjAyMDIwMjAyMDIwMjAyMDIwMjAyMDIwMjAyMDIwMjAyMDIwMjAyMf5YBO6wCF4SqPlYAAAAASUVORK5CYII=',
    'base64',
  ),
)

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const BASE = 'http://localhost:1420'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const assert = (cond, msg) => {
  if (!cond) throw new Error(`ASSERT FAIL: ${msg}`)
  console.log('OK:', msg)
}

async function register(page, username) {
  await page.goto(BASE, { waitUntil: 'networkidle2' })
  await sleep(600)
  const click = (text, sel) =>
    page.evaluate(
      (text, sel) => {
        const el = [...document.querySelectorAll(sel)].find((e) => e.textContent.trim() === text)
        el?.click()
      },
      text,
      sel,
    )
  const fill = (ph, v) =>
    page.evaluate(
      (ph, v) => {
        const el = [...document.querySelectorAll('input')].find((e) => (e.placeholder ?? '') === ph)
        const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
        set.call(el, v)
        el.dispatchEvent(new Event('input', { bubbles: true }))
      },
      ph,
      v,
    )
  await click('注册', 'button.tab')
  await fill('3-24 位字母/数字/中文', username)
  await fill('至少 8 位', 'gt-shot-2026')
  await click('创建账号', 'button.btn.primary')
  await sleep(1500)
  const need = await page.evaluate(() => document.body.innerText.includes('创建账号'))
  if (need) {
    await click('登录', 'button.tab')
    await fill('3-24 位字母/数字/中文', username)
    await fill('输入密码', 'gt-shot-2026')
    await click('登录', 'button.btn.primary')
    await sleep(1200)
  }
  assert(await page.evaluate(() => document.body.innerText.includes('房间')), `${username} 登录`)
}

async function createRoom(page, name) {
  await page.evaluate(() => document.querySelector('.icon-btn')?.click())
  await sleep(400)
  await page.evaluate(
    (name) => {
      const el = [...document.querySelectorAll('input')].find((e) => (e.placeholder ?? '') === '例如：开黑小队')
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
      set.call(el, name)
      el.dispatchEvent(new Event('input', { bubbles: true }))
    },
    name,
  )
  await page.evaluate(() => {
    const el = [...document.querySelectorAll('button.btn.primary')].find((e) => e.textContent.trim() === '创建')
    el?.click()
  })
  await sleep(900)
}

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--window-size=1280,860'],
  defaultViewport: { width: 1200, height: 800 },
})
try {
  const ctxA = await browser.createBrowserContext()
  const ctxB = await browser.createBrowserContext()
  const pa = await ctxA.newPage()
  pa.on('console', (m) => { if (m.text().startsWith('[lb]')) console.log('PAGE:', m.text()) })
  const pb = await ctxB.newPage()
  await register(pa, '夜行者')
  await register(pb, '白熊队长')
  await createRoom(pa, '七项验证房')
  const code = await pa.evaluate(() => (document.body.innerText.match(/邀请码\s*([A-Z0-9]{8})/) ?? [])[1] ?? '')
  await pb.evaluate(() => document.querySelector('.icon-btn')?.click())
  await sleep(400)
  await pb.evaluate(
    (code) => {
      const el = [...document.querySelectorAll('input')].find((e) => (e.placeholder ?? '') === '例如：AB12CD34')
      const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
      set.call(el, code)
      el.dispatchEvent(new Event('input', { bubbles: true }))
    },
    code,
  )
  await pb.evaluate(() => {
    const el = [...document.querySelectorAll('button.btn.primary')].find((e) => e.textContent.trim() === '加入')
    el?.click()
  })
  await sleep(1000)

  // R5: hover 消息行不再有灰底
  await pb.click('.composer-input')
  await pb.type('.composer-input', '被引用的消息', { delay: 10 })
  await pb.keyboard.press('Enter')
  await sleep(800)
  await pa.hover('.message')
  await sleep(200)
  const hoverBg = await pa.evaluate(() => getComputedStyle(document.querySelector('.message')).backgroundColor)
  assert(hoverBg === 'rgba(0, 0, 0, 0)', `hover 无灰底（${hoverBg}）`)

  // R4: 气泡右侧空白区右键不弹菜单
  await pa.evaluate(() => {
    const msg = [...document.querySelectorAll('.message')].find((e) => e.textContent.includes('被引用的消息'))
    const rect = msg.getBoundingClientRect()
    const ev = new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: rect.right + 80, clientY: rect.top + 10 })
    document.elementFromPoint(rect.right + 80, rect.top + 10)?.dispatchEvent(ev)
  })
  await sleep(300)
  assert(await pa.evaluate(() => !document.querySelector('.ctx-menu')), '空白区域右键不弹菜单')

  // R1: 气泡本体右键 → 引用 → 回复条 → 发送 → 气泡内引用块
  await pa.evaluate(() => {
    const msg = [...document.querySelectorAll('.message')].find((e) => e.textContent.includes('被引用的消息'))
    msg.querySelector('.message-body')?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
  })
  await sleep(300)
  await pa.evaluate(() => {
    const el = [...document.querySelectorAll('.ctx-menu-item')].find((e) => e.textContent.trim() === '引用')
    el?.click()
  })
  await sleep(300)
  assert(await pa.evaluate(() => !!document.querySelector('.reply-bar')), '回复条出现')
  await pa.click('.composer-input')
  await pa.type('.composer-input', '收到！', { delay: 10 })
  await pa.keyboard.press('Enter')
  await sleep(900)
  assert(await pa.evaluate(() => !!document.querySelector('.message-quote')), '气泡内引用块渲染')
  const quoteText = await pa.evaluate(() => document.querySelector('.message-quote')?.textContent ?? '')
  assert(quoteText.includes('白熊队长') && quoteText.includes('被引用的消息'), '引用块含原作者与原文')

  // R6: 消息头像右键 → 成员菜单（用「别人的消息」：对自己的头像不显示 @/加好友属正确设计）
  await pa.evaluate(() => {
    const msg = [...document.querySelectorAll('.message')].find((e) => e.textContent.includes('被引用的消息'))
    msg.querySelector('.message-avatar')?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
  })
  await sleep(300)
  const avatarMenu = await pa.evaluate(() => document.querySelector('.ctx-menu')?.textContent ?? '')
  assert(avatarMenu.includes('白熊队长') && avatarMenu.includes('@ 提及') && avatarMenu.includes('查看资料'), '头像右键弹成员菜单')
  await pa.mouse.click(700, 300)
  await sleep(300)

  // R3: 图片消息右键含「复制图片」
  const imgInput = await pb.$('input[type=file][accept*=image]')
  await imgInput.uploadFile(IMG_PATH)
  await sleep(800)
  await pb.evaluate(() => {
    const el = [...document.querySelectorAll('button.btn.primary')].find((e) => e.textContent.trim() === '发送')
    el?.click()
  })
  await sleep(1000)
  await pa.evaluate(() => {
    const msg = [...document.querySelectorAll('.message')].find((e) => e.querySelector('.msg-image'))
    msg.querySelector('.message-body')?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
  })
  await sleep(300)
  assert(await pa.evaluate(() => [...document.querySelectorAll('.ctx-menu-item')].some((e) => e.textContent.trim() === '复制图片')), '图片菜单含复制图片')
  await pa.mouse.click(700, 300)
  await sleep(300)

  // R2: 灯箱拖拽：松手后不再跟随，拖后点击不关闭
  await pa.evaluate(() => document.querySelector('.msg-image')?.click())
  await sleep(400)
  await pa.evaluate(() => {
    document.querySelector('.modal-mask.lightbox')?.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, bubbles: true }))
  })
  await sleep(200)
  await pa.mouse.move(600, 400)
  await pa.mouse.down()
  await pa.mouse.move(720, 460, { steps: 5 })
  await pa.mouse.up()
  // 松手判定在该环境走 move 的 buttons 位（mouseup 可能丢），用两次移动后位置稳定来验证
  await pa.mouse.move(950, 250, { steps: 2 })
  const off1 = await pa.evaluate(() => document.querySelector('.lightbox img')?.style.transform ?? '')
  await pa.mouse.move(1000, 200, { steps: 2 })
  const off2 = await pa.evaluate(() => document.querySelector('.lightbox img')?.style.transform ?? '')
  assert(off1 === off2 && off1 !== '', `松手后不再跟随（${off1} / ${off2}）`)
  assert(!off1.includes('translate(0px'), `平移已生效（${off1}）`)
  // 拖拽松手自带的那次 click 不应关闭灯箱（此时未做过新点击）
  assert(await pa.evaluate(() => !!document.querySelector('.lightbox')), '拖拽松手不误关灯箱')
  // 之后的全新空白点击 = 正常关闭
  await pa.mouse.click(600, 400)
  await sleep(300)
  assert(await pa.evaluate(() => !document.querySelector('.lightbox')), '新点击正常关闭灯箱')
  console.log('DONE')
} finally {
  await browser.close()
}
