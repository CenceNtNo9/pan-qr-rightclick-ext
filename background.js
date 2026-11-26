/* global jsQR */
importScripts('lib/jsQR.min.js');

const MENU_OPEN = 'pan-qr-open';
const MENU_COPY = 'pan-qr-copy';

const PAN_RULES = [
  { name: '百度网盘', re: /^https?:\/\/(?:pan|yun)\.baidu\.com\//i },
  { name: '夸克网盘', re: /^https?:\/\/pan\.quark\.cn\//i },
  { name: '阿里云盘', re: /^https?:\/\/(?:www\.)?(?:alipan|aliyundrive)\.com\//i },
  { name: '123云盘', re: /^https?:\/\/(?:www\.)?123(?:pan|684|865|912)\.(?:com|cn)\//i },
  { name: '迅雷云盘', re: /^https?:\/\/pan\.xunlei\.com\//i },
  { name: '蓝奏云', re: /^https?:\/\/[a-z0-9-]*lanzou[a-z]\.com\//i },
  { name: '天翼云盘', re: /^https?:\/\/cloud\.189\.cn\//i },
  { name: 'UC网盘', re: /^https?:\/\/drive\.uc\.cn\//i },
  { name: 'PikPak', re: /^https?:\/\/mypikpak\.com\//i },
];

function setupContextMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_OPEN,
      title: '识别二维码并打开链接',
      contexts: ['image'],
    });
    chrome.contextMenus.create({
      id: MENU_COPY,
      title: '识别二维码并复制链接',
      contexts: ['image'],
    });
  });
}

chrome.runtime.onInstalled.addListener(setupContextMenus);
chrome.runtime.onStartup.addListener(setupContextMenus);

function matchPanSite(url) {
  for (const rule of PAN_RULES) {
    if (rule.re.test(url)) return rule;
  }
  return null;
}

function normalizePanUrl(rawUrl) {
  let urlStr = rawUrl.trim();
  try {
    const u = new URL(urlStr);
    if (/^(?:pan|yun)\.baidu\.com$/i.test(u.hostname)) {
      const surl = u.searchParams.get('surl');
      const pwd = u.searchParams.get('pwd');
      if (surl && /\/(?:wap|share)\/init/i.test(u.pathname)) {
        const normalizedSurl = surl.startsWith('1') ? surl : '1' + surl;
        urlStr = `https://pan.baidu.com/s/${normalizedSurl}` + (pwd ? `?pwd=${encodeURIComponent(pwd)}` : '');
      }
    }
  } catch {
    // ignore
  }
  return urlStr;
}

// 极速路径 0：如果图片本身就是在线二维码 API（URL 查询参数里直接带目标网盘网址），0.1ms 直接提取
function tryExtractDirectUrlFromQrApi(srcUrl) {
  try {
    const u = new URL(srcUrl);
    if (!/(qr|qrcode|barcode|erweima)/i.test(u.hostname + u.pathname)) return null;
    for (const key of ['url', 'data', 'text', 'content', 'chl', 'code']) {
      const val = u.searchParams.get(key);
      if (val && /^https?:\/\//i.test(val.trim())) {
        return val.trim();
      }
    }
  } catch {
    // ignore
  }
  return null;
}

function getJsQRDecoder() {
  if (typeof jsQR === 'function') return jsQR;
  if (typeof self !== 'undefined' && typeof self.jsQR === 'function') return self.jsQR;
  if (typeof globalThis !== 'undefined' && typeof globalThis.jsQR === 'function') return globalThis.jsQR;
  return null;
}

async function decodeRegionFromBitmap(bitmap, sx, sy, sw, sh) {
  const decoder = getJsQRDecoder();
  if (!decoder) throw new Error('jsQR 解码库加载失败');
  if (sw < 16 || sh < 16) return null;

  const pad = 20;
  const maxDim = Math.max(sw, sh);
  const attempts = [];

  // 首轮用紧凑分辨率（≤400px），通常 3~6ms 命中
  const s1 = maxDim > 400 ? 400 / maxDim : 1;
  attempts.push({ sx, sy, sw, sh, dw: Math.round(sw * s1), dh: Math.round(sh * s1) });

  if (maxDim > 400) {
    const s2 = maxDim > 840 ? 840 / maxDim : 1;
    attempts.push({ sx, sy, sw, sh, dw: Math.round(sw * s2), dh: Math.round(sh * s2) });
  }

  if (sh > sw * 1.15) {
    const subSy = sy + Math.round(sh * 0.22);
    const subSh = sh - Math.round(sh * 0.22);
    const dw = Math.min(440, sw);
    const dh = Math.round((subSh * dw) / sw);
    attempts.push({ sx, sy: subSy, sw, sh: subSh, dw, dh });
  }

  for (const a of attempts) {
    const canvas = new OffscreenCanvas(a.dw + pad * 2, a.dh + pad * 2);
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, a.sx, a.sy, a.sw, a.sh, pad, pad, a.dw, a.dh);

    // 若浏览器支持原生硬件 BarcodeDetector，先试 1ms
    if (typeof BarcodeDetector !== 'undefined') {
      try {
        const det = new BarcodeDetector({ formats: ['qr_code'] });
        const codes = await det.detect(canvas);
        if (codes && codes.length > 0 && codes[0].rawValue) {
          return codes[0].rawValue;
        }
      } catch {
        // fallback to jsQR
      }
    }

    const imgData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const hit = decoder(imgData.data, canvas.width, canvas.height, { inversionAttempts: 'attemptBoth' });
    if (hit && hit.data) return hit.data;
  }
  return null;
}

async function decodeImageBlob(blob) {
  const bitmap = await createImageBitmap(blob);
  try {
    return await decodeRegionFromBitmap(bitmap, 0, 0, bitmap.width, bitmap.height);
  } finally {
    bitmap.close();
  }
}

// 一次性轻量读取：获取被右键图片的屏幕坐标 rect + 单卡提取码（纯 DOM 读取，< 2ms）
async function getImageRectAndPwd(tabId, srcUrl) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      args: [srcUrl],
      func: (targetSrc) => {
        const imgs = Array.from(document.querySelectorAll('img'));
        // 优先匹配视口内可见的同 src 图片（防止页面多处复用同链接时找错）
        const matches = imgs.filter((el) => el.currentSrc === targetSrc || el.src === targetSrc);
        const img =
          matches.find((el) => {
            const r = el.getBoundingClientRect();
            return r.width > 16 && r.height > 16 && r.bottom > 0 && r.top < window.innerHeight && r.right > 0 && r.left < window.innerWidth;
          }) || matches[0];

        if (!img) return { rect: null, pwd: null, dpr: window.devicePixelRatio || 1 };

        const r = img.getBoundingClientRect();
        const rect = {
          left: r.left,
          top: r.top,
          width: r.width,
          height: r.height,
          vw: window.innerWidth,
          vh: window.innerHeight,
        };

        // 单卡隔离提取码：一旦祖先包含超过 1 张大图立刻停止
        let pwd = null;
        const pwdRegex = /(?:提取码|密码|访问码|提取密码|口令|pwd)\s*[:：=]?\s*([a-zA-Z0-9]{4})\b/i;
        let cur = img.parentElement;
        for (let depth = 0; depth < 3 && cur && cur !== document.body; depth++) {
          let mediaCount = 0;
          for (const m of cur.querySelectorAll('img, canvas, svg')) {
            const mr = m.getBoundingClientRect();
            if (mr.width >= 56 && mr.height >= 56) {
              mediaCount++;
              if (mediaCount > 1) break;
            }
          }
          if (mediaCount > 1) break;
          const txt = (cur.innerText || cur.textContent || '').trim();
          if (txt.length > 0 && txt.length < 240) {
            const match = txt.match(pwdRegex);
            if (match) {
              pwd = match[1];
              break;
            }
          }
          cur = cur.parentElement;
        }

        return { rect, pwd, dpr: window.devicePixelRatio || 1 };
      },
    });
    return results?.[0]?.result || { rect: null, pwd: null, dpr: 1 };
  } catch {
    return { rect: null, pwd: null, dpr: 1 };
  }
}

// 极速零网络路径：并行拿本地帧缓冲截屏 + 精确裁剪二维码矩形区域解码（~30-50ms）
async function decodeViaCapturedDataUrl(capturedDataUrl, rect) {
  if (!capturedDataUrl || !rect || rect.width < 20 || rect.height < 20) return null;
  // 若图片大部分在视口外则跳过截屏路径，改走原图 fetch
  const visLeft = Math.max(0, rect.left);
  const visTop = Math.max(0, rect.top);
  const visRight = Math.min(rect.vw, rect.left + rect.width);
  const visBottom = Math.min(rect.vh, rect.top + rect.height);
  if (visRight - visLeft < rect.width * 0.7 || visBottom - visTop < rect.height * 0.7) {
    return null;
  }

  const blob = await (await fetch(capturedDataUrl)).blob();
  const bitmap = await createImageBitmap(blob);
  try {
    const scaleX = bitmap.width / rect.vw;
    const scaleY = bitmap.height / rect.vh;
    const margin = 6;
    const sx = Math.max(0, Math.floor((visLeft - margin) * scaleX));
    const sy = Math.max(0, Math.floor((visTop - margin) * scaleY));
    const ex = Math.min(bitmap.width, Math.ceil((visRight + margin) * scaleX));
    const ey = Math.min(bitmap.height, Math.ceil((visBottom + margin) * scaleY));
    return await decodeRegionFromBitmap(bitmap, sx, sy, ex - sx, ey - sy);
  } finally {
    bitmap.close();
  }
}

async function notifyAndCopyInTab(tabId, { textToCopy, message, isError = false }) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      args: [textToCopy, message, isError],
      func: async (copyText, msg, errFlag) => {
        if (copyText) {
          try {
            await navigator.clipboard.writeText(copyText);
          } catch {
            const ta = document.createElement('textarea');
            ta.value = copyText;
            ta.style.cssText = 'position:fixed;left:-9999px;top:-9999px;';
            document.body.appendChild(ta);
            ta.select();
            document.execCommand('copy');
            ta.remove();
          }
        }

        const old = document.getElementById('__pan_qr_toast_host__');
        if (old) old.remove();

        const host = document.createElement('div');
        host.id = '__pan_qr_toast_host__';
        host.style.cssText = 'position:fixed; top:18px; right:18px; z-index:2147483647; pointer-events:none;';
        const shadow = host.attachShadow({ mode: 'open' });
        const style = document.createElement('style');
        style.textContent = `
          .toast {
            max-width: 360px;
            padding: 10px 14px;
            border-radius: 10px;
            background: ${errFlag ? 'rgba(127, 29, 29, 0.94)' : 'rgba(17, 24, 39, 0.94)'};
            border: 1px solid ${errFlag ? 'rgba(248, 113, 113, 0.45)' : 'rgba(56, 189, 248, 0.45)'};
            color: #f9fafb;
            font: 500 13px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
            box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
            backdrop-filter: blur(8px);
            word-break: break-all;
            opacity: 0;
            transform: translateY(-6px);
            transition: opacity 0.16s ease, transform 0.16s ease;
          }
          .toast.show { opacity: 1; transform: translateY(0); }
        `;
        const box = document.createElement('div');
        box.className = 'toast';
        box.textContent = msg;
        shadow.append(style, box);
        document.documentElement.appendChild(host);

        requestAnimationFrame(() => box.classList.add('show'));
        setTimeout(() => {
          box.classList.remove('show');
          setTimeout(() => host.remove(), 200);
        }, 2500);
      },
    });
  } catch {
    // ignore
  }
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId !== MENU_OPEN && info.menuItemId !== MENU_COPY) return;
  if (!info.srcUrl || !tab?.id) return;

  const t0 = performance.now();
  try {
    let raw = null;
    let nearbyPwd = null;

    // 路径 0：直接检查是不是二维码生成 API 链接（0.1ms 秒出，零网络零解码）
    const directUrl = tryExtractDirectUrlFromQrApi(info.srcUrl);
    if (directUrl) {
      raw = directUrl;
      const meta = await getImageRectAndPwd(tab.id, info.srcUrl);
      nearbyPwd = meta.pwd;
    } else if (info.srcUrl.startsWith('data:')) {
      // 路径 1：base64 本地图片，零网络直解（~10ms）
      const [blob, meta] = await Promise.all([
        fetch(info.srcUrl).then((r) => r.blob()),
        getImageRectAndPwd(tab.id, info.srcUrl),
      ]);
      nearbyPwd = meta.pwd;
      raw = await decodeImageBlob(blob);
    } else {
      // 路径 2：并行执行本地帧缓冲截屏 + DOM 坐标读取，零网络往返（~30-50ms）
      const [capturedDataUrl, meta] = await Promise.all([
        chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 94 }).catch(() => null),
        getImageRectAndPwd(tab.id, info.srcUrl),
      ]);
      nearbyPwd = meta.pwd;
      try {
        raw = await decodeViaCapturedDataUrl(capturedDataUrl, meta.rect);
      } catch {
        raw = null;
      }

      // 路径 3（兜底）：截屏未命中时再走后台拉原图解码
      if (!raw) {
        const res = await fetch(info.srcUrl, { cache: 'force-cache', credentials: 'include' });
        if (res.ok) {
          raw = await decodeImageBlob(await res.blob());
        }
      }
    }

    if (!raw) {
      await notifyAndCopyInTab(tab.id, {
        textToCopy: null,
        message: '未在该图片中识别到标准二维码（不支持微信圆形小程序码）',
        isError: true,
      });
      return;
    }

    const isHttp = /^https?:\/\//i.test(raw.trim());
    let finalText = isHttp ? normalizePanUrl(raw) : raw.trim();
    let autoPwd = null;

    if (isHttp && matchPanSite(finalText) && nearbyPwd) {
      try {
        const u = new URL(finalText);
        if (!u.searchParams.get('pwd')) {
          u.searchParams.set('pwd', nearbyPwd);
          finalText = u.toString();
          autoPwd = nearbyPwd;
        }
      } catch {
        // ignore
      }
    }

    const elapsed = Math.round(performance.now() - t0);
    const pan = isHttp ? matchPanSite(finalText) : null;
    const label = pan ? pan.name : (isHttp ? '网页链接' : '文本');
    const pwdNote = autoPwd ? `（已补码 ${autoPwd}）` : '';

    if (info.menuItemId === MENU_OPEN && isHttp) {
      chrome.tabs.create({ url: finalText, active: true, openerTabId: tab.id });
      notifyAndCopyInTab(tab.id, {
        textToCopy: finalText,
        message: `✓ 已打开${label}${pwdNote}（${elapsed}ms）`,
      });
    } else {
      await notifyAndCopyInTab(tab.id, {
        textToCopy: finalText,
        message: `✓ 已复制${label}${pwdNote}（${elapsed}ms）：${finalText}`,
      });
    }
  } catch (err) {
    await notifyAndCopyInTab(tab.id, {
      textToCopy: null,
      message: `识别失败：${err?.message || '无法读取该图片'}`,
      isError: true,
    });
  }
});

// ─── 兜底：点击浏览器右上角扩展图标，按需扫描当前页可见的 <canvas>/<svg> 二维码 ───
chrome.action.onClicked.addListener(async (tab) => {
  if (!tab?.id) return;
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: async () => {
        const items = [];
        const pwdRegex = /(?:提取码|密码|访问码|提取密码|口令|pwd)\s*[:：=]?\s*([a-zA-Z0-9]{4})\b/i;

        function findPwd(el) {
          let cur = el.parentElement;
          for (let d = 0; d < 3 && cur && cur !== document.body; d++) {
            const media = cur.querySelectorAll('img, canvas, svg');
            let big = 0;
            for (const m of media) {
              const r = m.getBoundingClientRect();
              if (r.width >= 56 && r.height >= 56) big++;
              if (big > 1) return null;
            }
            const t = (cur.innerText || cur.textContent || '').trim();
            if (t.length > 0 && t.length < 240) {
              const m = t.match(pwdRegex);
              if (m) return m[1];
            }
            cur = cur.parentElement;
          }
          return null;
        }

        for (const c of document.querySelectorAll('canvas')) {
          const r = c.getBoundingClientRect();
          if (r.width >= 64 && r.height >= 64 && r.width <= 600 && r.height <= 600) {
            try {
              items.push({ dataUrl: c.toDataURL('image/png'), pwd: findPwd(c) });
            } catch {}
          }
        }

        for (const s of document.querySelectorAll('svg')) {
          const r = s.getBoundingClientRect();
          if (r.width >= 64 && r.height >= 64 && r.width <= 600 && r.height <= 600) {
            try {
              const clone = s.cloneNode(true);
              if (!clone.getAttribute('xmlns')) clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
              clone.setAttribute('width', String(Math.round(r.width * 2)));
              clone.setAttribute('height', String(Math.round(r.height * 2)));
              const svgStr = new XMLSerializer().serializeToString(clone);
              const blob = new Blob([svgStr], { type: 'image/svg+xml;charset=utf-8' });
              const dataUrl = await new Promise((resolve, reject) => {
                const fr = new FileReader();
                fr.onload = () => resolve(fr.result);
                fr.onerror = reject;
                fr.readAsDataURL(blob);
              });
              items.push({ dataUrl, pwd: findPwd(s) });
            } catch {}
          }
        }
        return items;
      },
    });

    const candidates = res?.result || [];
    const found = [];
    const seen = new Set();

    for (const item of candidates) {
      try {
        const blob = await (await fetch(item.dataUrl)).blob();
        const raw = await decodeImageBlob(blob);
        if (!raw) continue;
        let val = /^https?:\/\//i.test(raw.trim()) ? normalizePanUrl(raw) : raw.trim();
        if (/^https?:\/\//i.test(val) && matchPanSite(val) && item.pwd) {
          const u = new URL(val);
          if (!u.searchParams.get('pwd')) {
            u.searchParams.set('pwd', item.pwd);
            val = u.toString();
          }
        }
        if (!seen.has(val)) {
          seen.add(val);
          const pan = matchPanSite(val);
          found.push({ url: val, label: pan ? pan.name : '二维码' });
        }
      } catch {}
    }

    if (found.length === 0) {
      await notifyAndCopyInTab(tab.id, {
        textToCopy: null,
        message: '未在当前页 Canvas/SVG 中找到二维码（普通图片请直接右键点图片识别）',
      });
      return;
    }

    if (found.length === 1 && /^https?:\/\//i.test(found[0].url)) {
      chrome.tabs.create({ url: found[0].url, active: true, openerTabId: tab.id });
      notifyAndCopyInTab(tab.id, {
        textToCopy: found[0].url,
        message: `✓ 已打开${found[0].label}`,
      });
      return;
    }

    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      args: [found],
      func: (list) => {
        const old = document.getElementById('__pan_qr_picker__');
        if (old) old.remove();
        const host = document.createElement('div');
        host.id = '__pan_qr_picker__';
        host.style.cssText = 'position:fixed; top:18px; right:18px; z-index:2147483647;';
        const shadow = host.attachShadow({ mode: 'open' });
        const style = document.createElement('style');
        style.textContent = `
          .panel { width: 320px; background: rgba(17, 24, 39, 0.96); border: 1px solid rgba(255,255,255,0.16); border-radius: 12px; padding: 12px; color: #f3f4f6; font: 12px/1.5 -apple-system, "Microsoft YaHei", sans-serif; box-shadow: 0 10px 30px rgba(0,0,0,0.45); }
          .hd { display:flex; justify-content:space-between; align-items:center; margin-bottom:8px; font-weight:600; color:#7dd3fc; }
          .close { border:none; background:transparent; color:#9ca3af; cursor:pointer; font-size:15px; }
          .row { display:flex; align-items:center; gap:6px; padding:6px 8px; border-radius:8px; background:rgba(255,255,255,0.06); margin-top:6px; }
          .tag { flex-shrink:0; font-size:11px; padding:2px 6px; border-radius:999px; background:#06a7ff; color:#fff; }
          a { flex:1; color:#e5e7eb; text-decoration:none; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
          a:hover { color:#7dd3fc; text-decoration:underline; }
          .cp { flex-shrink:0; border:none; background:rgba(255,255,255,0.14); color:#fff; border-radius:6px; padding:2px 8px; cursor:pointer; font-size:11px; }
        `;
        const panel = document.createElement('div');
        panel.className = 'panel';
        const hd = document.createElement('div');
        hd.className = 'hd';
        const title = document.createElement('span');
        title.textContent = `识别到 ${list.length} 个二维码`;
        const close = document.createElement('button');
        close.className = 'close';
        close.textContent = '×';
        close.onclick = () => host.remove();
        hd.append(title, close);
        panel.appendChild(hd);

        for (const item of list) {
          const row = document.createElement('div');
          row.className = 'row';
          const tag = document.createElement('span');
          tag.className = 'tag';
          tag.textContent = item.label;
          const link = document.createElement('a');
          link.href = item.url;
          link.target = '_blank';
          link.rel = 'noopener noreferrer';
          link.textContent = item.url;
          link.title = item.url;
          const cp = document.createElement('button');
          cp.className = 'cp';
          cp.textContent = '复制';
          cp.onclick = async () => {
            try { await navigator.clipboard.writeText(item.url); } catch {}
            cp.textContent = '✓';
            setTimeout(() => { cp.textContent = '复制'; }, 1200);
          };
          row.append(tag, link, cp);
          panel.appendChild(row);
        }
        shadow.append(style, panel);
        document.documentElement.appendChild(host);
      },
    });
  } catch (err) {
    await notifyAndCopyInTab(tab.id, {
      textToCopy: null,
      message: `无法扫描此页面：${err?.message || '受限页面'}`,
      isError: true,
    });
  }
});
