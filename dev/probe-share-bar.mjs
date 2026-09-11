/* eslint-disable */
// 屏幕共享控制条「布局体检」脚本。
//
// 背景：控制条在 150% 缩放的屏幕上曾严重拥挤——窗口按物理像素设成 384×138，
// 实际只有 256 CSS 宽，「正在共享」被拆成两行、按钮被压缩裁切。
// 本脚本用真实 App.css 在指定 CSS 视口下渲染控制条 DOM，逐个元素量 scrollWidth/clientWidth，
// 找出「溢出（内容被裁切）」与「换行」，并输出截图；--scan 模式会扫出不再溢出的最小宽度，
// 用来确认当前图标尺寸留有多少安全余量。
//
// 用法：
//   node dev/probe-share-bar.mjs                  # 按 share.tsx 里的 CONTROL_W/H 体检 + 截图，失败退出码 1
//   node dev/probe-share-bar.mjs --scan           # 扫描最小安全宽度（最坏场景）
//   GT_BASE=http://127.0.0.1:4173 node ... 399  # 指向 vite preview 的产物
// 需要 vite dev（127.0.0.1:1420）或 GT_BASE 指向的静态服务在跑。
//
// 未接入 CI 的原因：本机与 GitHub runner 的中文字体不同，文字宽度会变，检查会变成 flaky 噪声。
// 它是「改控制条 / 改 UI 尺寸后本地必跑」的自检项，不是 CI 门禁。
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';

const CHROME = process.env.GT_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = process.env.GT_BASE || 'http://127.0.0.1:1420';
const ROOT = 'C:/Users/Root/Desktop/AIGC/GameTalk';
const SHOT = path.join(ROOT, 'dev', 'shots');
fs.mkdirSync(SHOT, { recursive: true });

/** 控制条尺寸的唯一事实来源就是 share.tsx：直接从源码读，避免探针与实现漂移 */
function readControlSize() {
  const src = fs.readFileSync(path.join(ROOT, 'client', 'src', 'share.tsx'), 'utf8');
  const w = /const CONTROL_W = (\d+);/.exec(src);
  const h = /const CONTROL_H = (\d+);/.exec(src);
  if (!w || !h) throw new Error('未能从 client/src/share.tsx 解析出 CONTROL_W / CONTROL_H');
  return { W: Number(w[1]), H: Number(h[1]) };
}
const CONTROL = readControlSize();

/**
 * 与 share.tsx 的共享态 DOM 保持一致（class 名、层级、按钮顺序）。
 * 默认取「最坏情况」：带音频（多一个「静音提示音」chip）+ 服务器中转告警（状态行最长）。
 */
const SCENARIOS = {
  worst: {
    viewers: '2 人观看',
    metrics: '1296×688 · 4.4 Mbps · 29 fps',
    warns: ['⚠ 服务器中转', '含音频'],
  },
  plain: {
    viewers: '等待观看',
    metrics: '— · — · —',
    warns: [],
  },
};

function markup(s) {
  return `
<div class="share-bar">
  <video class="share-bar-preview" muted playsinline></video>
  <div class="share-bar-main">
    <div class="share-bar-top">
      <span class="share-bar-dot">●</span>
      <span class="share-bar-live">正在共享</span>
      <span class="share-bar-viewers">${s.viewers}</span>
      <button class="share-bar-close" title="停止共享">■</button>
    </div>
    <div class="share-bar-stats">
      <span class="share-bar-metrics">${s.metrics}</span>
      ${s.warns.map((w) => `<span class="share-stat-warn">${w}</span>`).join('\n      ')}
    </div>
  </div>
</div>`;
}

/** 量出所有可能溢出/换行的元素（注意：该函数会被序列化到页面里执行，不能引用外部变量） */
function measure() {
  /** 允许被省略号截断的元素（弹性段）；其余元素出现溢出即视为缺陷 */
  const ELLIPSIS_OK = ['.share-bar-metrics', '.share-bar-viewers'];
  const out = [];
  const push = (name, el) => {
    if (!el) return;
    const r = el.getBoundingClientRect();
    out.push({
      name,
      w: +r.width.toFixed(1),
      overflowX: el.scrollWidth - el.clientWidth,
      overflowY: el.scrollHeight - el.clientHeight,
      ellipsisOk: ELLIPSIS_OK.indexOf(name) >= 0 && getComputedStyle(el).textOverflow === 'ellipsis',
      text: (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 44),
    });
  };
  [
    '.share-bar',
    '.share-bar-main',
    '.share-bar-top',
    '.share-bar-live',
    '.share-bar-viewers',
    '.share-bar-close',
    '.share-bar-stats',
    '.share-bar-metrics',
    '.share-stat-warn',
    '.share-stat-tag',
    '.share-bar-actions',
  ].forEach((s) => push(s, document.querySelector(s)));
  document.querySelectorAll('.share-chip').forEach((el, i) => push(`chip[${i}]`, el));
  return out;
}

/** 判定行的内容是否真被压缩（chip 实际宽 < 内容需要的宽） */
function squashed() {
  return [...document.querySelectorAll('.share-chip')]
    .map((el) => {
      const probe = el.cloneNode(true);
      probe.style.cssText = 'position:absolute;visibility:hidden;width:auto;max-width:none;flex:none;white-space:nowrap';
      document.body.appendChild(probe);
      const need = probe.getBoundingClientRect().width;
      probe.remove();
      return { text: el.textContent.trim(), actual: el.getBoundingClientRect().width, need };
    })
    .filter((r) => r.actual + 0.5 < r.need);
}

const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new' });

async function renderAt(w, h, scenario, shotName) {
  const page = await browser.newPage();
  await page.setViewport({ width: w, height: h, deviceScaleFactor: 1 });
  await page.goto(`${BASE}/share.html`, { waitUntil: 'networkidle2' });
  await page.waitForSelector('#root', { timeout: 15000 });
  await page.evaluate((html) => {
    document.getElementById('root').innerHTML = html;
  }, markup(SCENARIOS[scenario]));
  await new Promise((r) => setTimeout(r, 250));
  const rows = await page.evaluate(measure);
  const sq = await page.evaluate(squashed);
  if (shotName) await page.screenshot({ path: path.join(SHOT, `share-bar-${shotName}.png`) });
  await page.close();
  const bad = rows.filter((r) => (r.overflowX > 0 || r.overflowY > 0) && !r.ellipsisOk);
  return { rows, sq, bad };
}

try {
  if (process.argv.includes('--scan')) {
    console.log('扫描最小安全宽度（场景：worst = 含音频+服务器中转）');
    let minClean = null;
    for (let w = 340; w <= 620; w += 10) {
      const { bad, sq } = await renderAt(w, 160, 'worst');
      const clean = bad.length === 0 && sq.length === 0;
      if (clean && minClean === null) minClean = w;
      console.log(`${String(w).padStart(4)}px  ${clean ? '✅ 无溢出无压缩' : '❌ ' + bad.length + ' 处溢出 / ' + sq.length + ' 个按钮被压'}`);
      if (clean && w - (minClean ?? w) >= 60) break;
    }
    console.log(`\n最小安全宽度 = ${minClean}px（当前设定 ${CONTROL.W}px，余量 ${minClean != null ? CONTROL.W - minClean : '?'}px）`);
  } else {
    const w = Number(process.argv[2] ?? CONTROL.W);
    const h = Number(process.argv[3] ?? CONTROL.H);
    const name = process.argv[4] ?? 'probe';
    const scenario = process.argv[5] ?? 'worst';
    const { rows, sq, bad } = await renderAt(w, h, scenario, `${name}-${w}x${h}-${scenario}`);
    console.log(`viewport ${w}x${h} · 场景 ${scenario}（share.tsx 设定 ${CONTROL.W}x${CONTROL.H}）`);
    console.log('element'.padEnd(22) + 'width'.padStart(9) + 'overflowX'.padStart(11) + 'overflowY'.padStart(11) + '  text');
    for (const r of rows) {
      const flag = (r.overflowX > 0 || r.overflowY > 0) && !r.ellipsisOk;
      const note = flag ? '⚠ ' : r.overflowX > 0 && r.ellipsisOk ? '… ' : '  ';
      console.log(
        r.name.padEnd(22) +
          String(r.w).padStart(9) +
          String(r.overflowX).padStart(11) +
          String(r.overflowY).padStart(11) +
          '  ' +
          note +
          r.text,
      );
    }
    if (sq.length) {
      console.log('\n被压缩的按钮：');
      for (const s of sq) console.log(`  ${s.text}  实际 ${s.actual.toFixed(1)} / 需要 ${s.need.toFixed(1)}`);
    }
    const pass = bad.length === 0 && sq.length === 0;
    console.log(pass ? '\n✅ 无溢出、无换行、无压缩' : `\n❌ ${bad.length} 处溢出、${sq.length} 个按钮被压缩`);
    if (!pass) process.exitCode = 1;
  }
} finally {
  await browser.close();
}
