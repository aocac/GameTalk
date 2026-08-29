// 拍摄 docs/ 界面截图：双账号全流程（v0.4.0）
// 产出：ui-login / ui-chat-owner / ui-friends / ui-member-menu / ui-room-context-menu /
//       ui-member-card / ui-profile / ui-mention
// 前置：本地服务端 127.0.0.1:8787 + vite dev（1420）；运行：node dev/capture-docs-screenshots.mjs
import puppeteer from 'puppeteer-core'

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const BASE = 'http://localhost:1420'
const OUT = new URL('../docs/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')

const USER_A = process.env.GT_USER_A ?? '夜行者'
const USER_B = process.env.GT_USER_B ?? '白熊队长'
const ROOM_MAIN = '周末开黑小队'
const ROOM_SECOND = '吃鸡小分队'
const PASSWORD = 'gt-shot-2026'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function dumpControls(page, label) {
  const s = await page.evaluate((lbl) => {
    const lines = [`--- dump ${lbl} ---`]
    document.querySelectorAll('input, textarea').forEach((el) => lines.push(`INPUT ph="${el.placeholder ?? ''}" class="${el.className}"`))
    document.querySelectorAll('button, [role=button], .tab').forEach((el) =>
      lines.push(`EL <${el.tagName.toLowerCase()}> text="${(el.textContent ?? '').trim().slice(0, 20)}" class="${String(el.className).slice(0, 60)}"`),
    )
    return lines.join('\n')
  }, label)
  console.log(s)
}

async function clickByText(page, text, { contains = false, sel = 'button, [role=button], .tab, [class*=btn]' } = {}) {
  const ok = await page.evaluate(
    (t, contains, sel) => {
      const el = [...document.querySelectorAll(sel)].find((e) => {
        const s = (e.textContent ?? '').trim()
        return contains ? s.includes(t) : s === t
      })
      if (el) {
        el.click()
        return true
      }
      return false
    },
    text,
    contains,
    sel,
  )
  if (!ok) {
    await dumpControls(page, `clickByText miss: ${text}`)
    throw new Error(`找不到可点击元素: ${text}`)
  }
}

async function clickBtn(page, text) {
  const ok = await page.evaluate((t) => {
    const el = [...document.querySelectorAll('button.btn.primary')].find((e) => (e.textContent ?? '').trim() === t)
    if (el) {
      el.click()
      return true
    }
    return false
  }, text)
  if (!ok) {
    await dumpControls(page, `clickBtn miss: ${text}`)
    throw new Error(`找不到主按钮: ${text}`)
  }
}

async function fillByPlaceholder(page, phList, value) {
  const list = Array.isArray(phList) ? phList : [phList]
  for (const ph of list) {
    const ok = await page.evaluate(
      (ph, value) => {
        const el = [...document.querySelectorAll('input, textarea')].find((e) => (e.placeholder ?? '') === ph)
        if (!el) return false
        const setter = Object.getOwnPropertyDescriptor(el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value').set
        setter.call(el, value)
        el.dispatchEvent(new Event('input', { bubbles: true }))
        return true
      },
      ph,
      value,
    )
    if (ok) return
  }
  await dumpControls(page, `fillByPlaceholder miss: ${list.join('|')}`)
  throw new Error(`找不到输入框: ${list.join('|')}`)
}

async function waitText(page, text, timeout = 8000) {
  await page.waitForFunction((t) => document.body.innerText.includes(t), { timeout }, text)
}

async function register(page, username, shotLogin = false) {
  await page.goto(BASE, { waitUntil: 'networkidle2' })
  await sleep(600)
  if (shotLogin) await page.screenshot({ path: `${OUT}ui-login.png` })
  await clickByText(page, '注册')
  await fillByPlaceholder(page, ['3-24 位字母/数字/中文'], username)
  await fillByPlaceholder(page, ['至少 8 位', '输入密码'], PASSWORD)
  await clickBtn(page, '创建账号')
  await sleep(1200)
  const registered = await page.evaluate(() => !document.body.innerText.includes('创建账号'))
  if (!registered) {
    // 账号已存在（重跑）→ 转登录
    await clickByText(page, '登录')
    await fillByPlaceholder(page, ['3-24 位字母/数字/中文'], username)
    await fillByPlaceholder(page, ['输入密码', '至少 8 位'], PASSWORD)
    await clickBtn(page, '登录')
  }
  await waitText(page, '房间')
  await sleep(600)
}

async function openSideTab(page, name) {
  await page.evaluate((name) => {
    const el = [...document.querySelectorAll('.side-tab')].find((e) => e.textContent.includes(name))
    el?.click()
  }, name)
  await sleep(500)
}

async function createRoom(page, name) {
  await page.evaluate(() => document.querySelector('.icon-btn')?.click())
  await sleep(400)
  await fillByPlaceholder(page, ['例如：开黑小队'], name)
  await clickBtn(page, '创建')
  await waitText(page, '邀请码')
  await sleep(400)
}

async function joinRoom(page, code) {
  await page.evaluate(() => document.querySelector('.icon-btn')?.click())
  await sleep(400)
  await page.evaluate((code) => {
    const el = [...document.querySelectorAll('input')].find((e) => /AB12CD34|邀请码/.test(e.placeholder ?? ''))
    if (el) {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
      setter.call(el, code)
      el.dispatchEvent(new Event('input', { bubbles: true }))
    }
  }, code)
  await clickBtn(page, '加入')
  await waitText(page, '成员')
  await sleep(500)
}

async function sendMessage(page, text) {
  await page.type('.composer-input', text, { delay: 15 })
  await page.keyboard.press('Enter')
  await sleep(500)
}

async function openProfileModal(page, bio) {
  await page.evaluate(() => document.querySelector('.user-trigger')?.click())
  await waitText(page, '退出登录')
  await sleep(200)
  await clickByText(page, '个人资料')
  await waitText(page, '个性签名')
  await fillByPlaceholder(page, ['写一句话介绍自己…'], bio)
  await clickByText(page, '保存')
  await sleep(500)
}

async function closeModal(page) {
  await page.evaluate(() => document.querySelector('.modal-mask')?.click())
  await sleep(400)
}

async function main(browser) {
  // 1) 登录页截图（A 首次进登录页时拍）
  const ctxA = await browser.createBrowserContext()
  const pageA = await ctxA.newPage()
  console.log('== A 注册 ==')
  await register(pageA, USER_A, true)

  // 2) 建主房 + 邀请码
  console.log('== A 建主房 ==')
  await createRoom(pageA, ROOM_MAIN)
  const code = await pageA.evaluate(() => (document.body.innerText.match(/邀请码\s*([A-Z0-9]{8})/) ?? [])[1] ?? '')
  console.log('邀请码:', code)
  if (!code) throw new Error('未取到邀请码')
  await sendMessage(pageA, '今晚 8 点老位置集合，别迟到 🎮')
  await sendMessage(pageA, '地图票都买好了')

  // 3) B 注册 + 加入 + 聊天 + 签名
  console.log('== B 注册 + 加入 ==')
  const ctxB = await browser.createBrowserContext()
  const pageB = await ctxB.newPage()
  await register(pageB, USER_B)
  await joinRoom(pageB, code)
  await sendMessage(pageB, '收到收到，柜分选手前来报到')
  await sendMessage(pageB, '装备都修好了，就等你了')
  console.log('== B 设置签名 ==')
  await openProfileModal(pageB, '汇合点：P城，物资管够')
  await closeModal(pageB)

  // 4) B 发图片（用刚拍的登录页截图当素材，画面更真实）
  console.log('== B 发图片 ==')
  const imgInput = await pageB.$('input[type=file][accept*=image]')
  await imgInput.uploadFile(new URL('../docs/ui-login.png', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
  await sleep(1500)

  // 5) B 发一条提及（真实键入 @ + 补全采纳）
  console.log('== B @提及 ==')
  await pageB.type('.composer-input', '别迟到，@', { delay: 15 })
  await sleep(400)
  await pageB.keyboard.press('Enter') // 采纳第一候选（夜行者）
  await sleep(200)
  await pageB.type('.composer-input', '集合点开地图', { delay: 15 })
  await pageB.keyboard.press('Enter')
  await sleep(900)

  // 6) 好友：A 申请 → B 同意 → A 好友页截图
  console.log('== 好友流程 ==')
  await openSideTab(pageA, '好友')
  await fillByPlaceholder(pageA, ['输入用户名或 #ID 加好友'], USER_B)
  await clickByText(pageA, '加好友')
  await sleep(700)
  await openSideTab(pageB, '好友')
  await clickByText(pageB, '接受')
  await sleep(700)
  await openSideTab(pageA, '好友')
  await sleep(600)
  await pageA.screenshot({ path: `${OUT}ui-friends.png` })

  // 7) 回消息页：第二房间（右键菜单素材）+ 主房截图
  console.log('== A 建第二房 + 切回 ==')
  await openSideTab(pageA, '消息')
  await createRoom(pageA, ROOM_SECOND)
  await sendMessage(pageA, '这个房先占个名')
  await pageA.evaluate((room) => {
    const el = [...document.querySelectorAll('[class*=room], li, div')].find(
      (e) => (e.textContent ?? '').trim().startsWith(room) && e.children.length > 0 && e.closest('[class*=sidebar]'),
    )
    el?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  }, ROOM_MAIN)
  await sleep(1200)
  console.log('== 截图：聊天主界面 ==')
  await pageA.screenshot({ path: `${OUT}ui-chat-owner.png` })

  // 8) 房间右键菜单
  console.log('== 截图：房间右键菜单 ==')
  await pageA.evaluate((room) => {
    const el = [...document.querySelectorAll('[class*=room], li, div')].find(
      (e) => (e.textContent ?? '').trim().startsWith(room) && e.closest('[class*=sidebar]'),
    )
    el?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
  }, ROOM_MAIN)
  await sleep(500)
  await pageA.screenshot({ path: `${OUT}ui-room-context-menu.png` })
  await pageA.mouse.click(700, 400)
  await sleep(500)

  // 9) 成员右键菜单（房主视角：禁言/移出）
  console.log('== 截图：成员右键菜单 ==')
  await pageA.evaluate((name) => {
    const el = [...document.querySelectorAll('.member-item')].find((e) => (e.textContent ?? '').includes(name))
    el?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }))
  }, USER_B)
  await waitText(pageA, '禁言')
  await sleep(400)
  await pageA.screenshot({ path: `${OUT}ui-member-menu.png` })
  await pageA.mouse.click(700, 400)
  await sleep(500)

  // 10) 成员卡片
  console.log('== 截图：成员卡片 ==')
  await pageA.evaluate((name) => {
    const el = [...document.querySelectorAll('.member-item')].find((e) => (e.textContent ?? '').includes(name))
    el?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  }, USER_B)
  await waitText(pageA, '注册于')
  await sleep(400)
  await pageA.screenshot({ path: `${OUT}ui-member-card.png` })
  await closeModal(pageA)

  // 11) 个人资料
  console.log('== 截图：个人资料 ==')
  await openProfileModal(pageA, '主打一个随缘')
  await sleep(300)
  await pageA.screenshot({ path: `${OUT}ui-profile.png` })
  await closeModal(pageA)

  // 12) 通知中心（提及未读 → 打开面板）
  console.log('== 截图：通知中心 ==')
  await pageA.evaluate(() => document.querySelector('.bell-btn')?.click())
  await waitText(pageA, '通知中心')
  await sleep(400)
  await pageA.screenshot({ path: `${OUT}ui-mention.png` })
  await pageA.evaluate(() => document.querySelector('.menu-mask')?.click())
}

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--window-size=1280,860'],
  defaultViewport: { width: 1200, height: 800 },
})

try {
  await main(browser)
} catch (err) {
  console.error('FAILED:', err.message)
  try {
    const pages = await browser.pages()
    const p = pages[pages.length - 1]
    console.log('页面文本:', (await p.evaluate(() => document.body.innerText)).replace(/\n+/g, ' | ').slice(0, 400))
    await p.screenshot({ path: `${OUT}debug-fail.png` })
  } catch {}
  await browser.close()
  process.exit(1)
}
await browser.close()
console.log('DONE')
