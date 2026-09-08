/* eslint-disable */
// 屏幕共享「真实媒体链路」端到端验证（可进 CI，不需要原生选择器）：
// 用 canvas + WebAudio 合成一路带音频的 MediaStream 顶替 getDisplayMedia，
// 之后走的是应用真实的 ScreenShareManager：offer/answer/ICE → 真实 P2P 传输。
// 断言观看端：画面分辨率、帧在推进、音频 RMS > 0；停止共享后观看端清理。
// 用法：node dev/e2e-screen-share-media.mjs（需本地 server 8787 + vite 1420）
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
import path from 'node:path';

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const BASE = 'http://127.0.0.1:1420';
const ROOT = 'C:/Users/Root/Desktop/AIGC/GameTalk';
const SHOT = path.join(ROOT, 'dev', 'shots');
fs.mkdirSync(SHOT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
function ok(name, cond, extra = '') {
  results.push({ name, pass: !!cond });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  [' + extra + ']' : ''}`);
}

async function register(page, username) {
  await page.goto(BASE, { waitUntil: 'networkidle2' });
  await page.waitForSelector('.auth-card', { timeout: 15000 }).catch(() => {});
  await page.evaluate(() => { [...document.querySelectorAll('.auth-card button')].find((b) => b.textContent.trim() === '注册')?.click(); });
  await sleep(400);
  await page.type('.auth-card input:not([type="password"])', username);
  await page.type('.auth-card input[type="password"]', 'password123');
  await page.evaluate(() => {
    const btn = [...document.querySelectorAll('.auth-card button')].find((b) => b.textContent.includes('注册') && b.type === 'submit');
    (btn ?? document.querySelector('.auth-card .btn.primary'))?.click();
  });
  await sleep(1800);
}
async function getToken(page) {
  return page.evaluate(() => { try { return JSON.parse(localStorage.getItem('gametalk-auth'))?.state?.token ?? ''; } catch { return ''; } });
}
async function apiCall(page, method, p, body) {
  return page.evaluate(async (m, path, b) => {
    let token = '';
    try { token = JSON.parse(localStorage.getItem('gametalk-auth'))?.state?.token ?? ''; } catch {}
    const res = await fetch(`http://127.0.0.1:8787${path}`, {
      method: m,
      headers: { ...(b ? { 'Content-Type': 'application/json' } : {}), authorization: `Bearer ${token}` },
      body: b ? JSON.stringify(b) : undefined,
    });
    const t = await res.text();
    try { return { status: res.status, body: JSON.parse(t) }; } catch { return { status: res.status, body: null }; }
  }, method, p, body ?? null);
}
async function selectRoom(page, name) {
  await page.evaluate((nm) => { const el = [...document.querySelectorAll('.room-item')].find((i) => (i.querySelector('.room-name')?.textContent ?? '').includes(nm)); el?.click(); }, name);
  await sleep(900);
}

/** 顶替 getDisplayMedia：canvas 画面（带跳秒数字）+ 440Hz 音频 */
async function injectSyntheticCapture(page) {
  await page.evaluateOnNewDocument(() => {
    navigator.mediaDevices.getDisplayMedia = async () => {
      const canvas = document.createElement('canvas');
      canvas.width = 640;
      canvas.height = 360;
      const ctx = canvas.getContext('2d');
      let n = 0;
      setInterval(() => {
        n += 1;
        ctx.fillStyle = `hsl(${(n * 9) % 360} 70% 45%)`;
        ctx.fillRect(0, 0, 640, 360);
        ctx.fillStyle = '#fff';
        ctx.font = 'bold 72px sans-serif';
        ctx.fillText(String(n), 40, 220);
      }, 33);
      const videoTrack = canvas.captureStream(30).getVideoTracks()[0];
      const ac = new AudioContext();
      const osc = ac.createOscillator();
      const gain = ac.createGain();
      const dst = ac.createMediaStreamDestination();
      osc.frequency.value = 440;
      gain.gain.value = 0.12;
      osc.connect(gain);
      gain.connect(dst);
      osc.start();
      return new MediaStream([videoTrack, ...dst.stream.getAudioTracks()]);
    };
  });
}

const run = async () => {
  const stamp = Date.now();
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', defaultViewport: { width: 1380, height: 860 } });
  try {
    const ctxA = await browser.createBrowserContext();
    const ctxB = await browser.createBrowserContext();
    const A = await ctxA.newPage();
    const B = await ctxB.newPage();
    await injectSyntheticCapture(A);

    await register(A, `ssm_a_${stamp}`);
    await register(B, `ssm_b_${stamp}`);
    const tokenA = await getToken(A);
    ok('双账号注册登录', !!tokenA && !!(await getToken(B)));

    const room = (await apiCall(A, 'POST', '/api/rooms', { name: 'MediaRoom' })).body.room;
    await apiCall(B, 'POST', '/api/rooms/join', { inviteCode: room.inviteCode });
    await A.reload({ waitUntil: 'networkidle2' });
    await B.reload({ waitUntil: 'networkidle2' });
    await sleep(1500);
    await selectRoom(A, 'MediaRoom');
    await selectRoom(B, 'MediaRoom');

    // A 发起共享（浏览器环境回落主窗口内嵌共享）
    await A.evaluate(() => { [...document.querySelectorAll('.composer-icon')].find((b) => (b.title ?? '').includes('共享'))?.click(); });
    await sleep(2500);
    const aBanner = await A.evaluate(() => [...document.querySelectorAll('.screen-banner')].map((b) => b.textContent.trim()).join('|'));
    ok('A 发起共享后显示共享中横幅', aBanner.includes('正在') && aBanner.includes('共享屏幕'), aBanner);

    // B 点「观看」
    await B.evaluate(() => { [...document.querySelectorAll('.screen-banner button')].find((b) => b.textContent.trim() === '观看')?.click(); });
    await sleep(6000);

    const viewerState = await B.evaluate(async () => {
      const v = document.querySelector('.screen-video');
      if (!v) return { exists: false };
      const first = v.currentTime;
      await new Promise((r) => setTimeout(r, 1500));
      return {
        exists: true,
        width: v.videoWidth,
        height: v.videoHeight,
        advanced: v.currentTime > first,
        hasAudio: !!v.srcObject && v.srcObject.getAudioTracks().length > 0,
        ice: document.querySelector('.screen-viewer-head')?.textContent ?? '',
      };
    });
    ok('B 出现观看窗且拿到画面', viewerState.exists && viewerState.width > 0 && viewerState.height > 0, JSON.stringify(viewerState));
    ok('B 画面在推进（真实传输）', !!viewerState.advanced);
    ok('B 收到音频轨', !!viewerState.hasAudio);

    // 音频 RMS：把观看端的流接到 AnalyserNode 实测有没有声音
    const rms = await B.evaluate(async () => {
      const v = document.querySelector('.screen-video');
      if (!v?.srcObject) return -1;
      const ac = new AudioContext();
      await ac.resume().catch(() => {});
      const src = ac.createMediaStreamSource(v.srcObject);
      const an = ac.createAnalyser();
      an.fftSize = 2048;
      src.connect(an);
      const buf = new Float32Array(an.fftSize);
      let peak = 0;
      for (let i = 0; i < 6; i++) {
        await new Promise((r) => setTimeout(r, 200));
        an.getFloatTimeDomainData(buf);
        let sum = 0;
        for (const x of buf) sum += x * x;
        peak = Math.max(peak, Math.sqrt(sum / buf.length));
      }
      return peak;
    });
    ok('B 音频有实际信号（RMS > 0.01）', rms > 0.01, `rms=${rms}`);

    await B.screenshot({ path: path.join(SHOT, 'ss-media-viewer.png') });

    // A 停止共享 → B 观看窗清理
    await A.evaluate(() => { [...document.querySelectorAll('.screen-banner button')].find((b) => b.textContent.trim() === '停止共享')?.click(); });
    await sleep(2500);
    const afterStop = await B.evaluate(() => ({
      viewer: !!document.querySelector('.screen-viewer'),
      banners: [...document.querySelectorAll('.screen-banner')].map((b) => b.textContent.trim()),
    }));
    ok('A 停止后 B 观看窗消失', !afterStop.viewer, JSON.stringify(afterStop));
  } finally {
    await browser.close();
  }
  const failed = results.filter((r) => !r.pass);
  console.log(`\n==== ${results.length - failed.length}/${results.length} PASS ====`);
  process.exit(failed.length ? 1 : 0);
};
run().catch((e) => { console.error('SCRIPT ERROR', e); process.exit(2); });
