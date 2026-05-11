/**
 * Multi-device UART terminal tab: several StreamingSerial instances,
 * send/receive per slot for E22 transparent-mode testing.
 */
import { StreamingSerial } from './streaming-serial.js';

const MAX_SLOTS = 6;
const COUNT_KEY = 'multi-device-count';
const textEncoder = new TextEncoder();

const SLOT_WRAP =
  'multi-slot flex flex-col gap-3 rounded-2xl border border-zinc-200/80 bg-white/90 p-4 shadow-sm dark:border-zinc-500/45 dark:bg-zinc-800/90 dark:shadow-lg dark:shadow-black/20';

const ROOT_GRID = 'grid gap-4 sm:grid-cols-1 xl:grid-cols-2';

const TERM_LINE = 'font-mono text-[12px] leading-relaxed ';
const TERM_CLS = {
  'log-err': `${TERM_LINE}text-red-600 dark:text-red-400`,
  'log-info': `${TERM_LINE}text-blue-600 dark:text-blue-400`,
  'log-in': `${TERM_LINE}text-emerald-600 dark:text-emerald-400`,
  'log-out': `${TERM_LINE}text-amber-600 dark:text-amber-400`,
};

function bytesToHexLine(u8) {
  return Array.from(u8, (b) => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
}

function asciiPreview(u8) {
  return Array.from(u8, (b) => (b >= 32 && b < 127 ? String.fromCharCode(b) : '.')).join('');
}

function parseHexToBytes(str) {
  const parts = str.trim().split(/\s+/).filter(Boolean);
  const out = [];
  for (const p of parts) {
    const n = parseInt(p, 16);
    if (Number.isNaN(n) || n < 0 || n > 255) {
      throw new Error(`Invalid hex byte: "${p}"`);
    }
    out.push(n);
  }
  return new Uint8Array(out);
}

function appendTerminal(pre, line, cls) {
  const span = document.createElement('span');
  if (cls) span.className = TERM_CLS[cls] ?? TERM_CLS['log-info'];
  span.textContent = `${line}\n`;
  pre.appendChild(span);
  pre.scrollTop = pre.scrollHeight;
  const max = 8000;
  while (pre.textContent.length > max) {
    const first = pre.firstChild;
    if (first) pre.removeChild(first);
    else break;
  }
}

function createSlot(index) {
  const wrap = document.createElement('div');
  wrap.className = SLOT_WRAP;
  wrap.dataset.slotIndex = String(index);
  wrap.innerHTML = `
    <div class="flex flex-wrap items-baseline justify-between gap-2 border-b border-zinc-200/80 pb-2 dark:border-zinc-600/40">
      <span class="text-sm font-semibold text-zinc-900 dark:text-zinc-100">Device ${index}</span>
      <span class="multi-slot-status text-xs text-zinc-500 dark:text-zinc-400">Disconnected</span>
    </div>
    <div class="flex flex-wrap items-center gap-2 gap-y-2 py-2">
      <div class="grid w-28 gap-1">
        <label class="text-xs font-semibold text-zinc-500 dark:text-zinc-400">Baud</label>
        <select class="multi-baud w-full rounded-lg border border-black/12 bg-white px-2 py-2 text-sm dark:border-zinc-500/35 dark:bg-zinc-900/55 dark:text-zinc-100">
          <option value="9600" selected>9600</option>
          <option value="19200">19200</option>
          <option value="38400">38400</option>
          <option value="57600">57600</option>
          <option value="115200">115200</option>
        </select>
      </div>
      <button type="button" class="multi-btn-connect shrink-0 rounded-xl border border-blue-600 bg-blue-600 px-3 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-blue-700 dark:border-blue-500 dark:bg-blue-600 dark:hover:bg-blue-500">Connect</button>
      <button type="button" class="multi-btn-disconnect shrink-0 rounded-xl border border-black/10 bg-white px-3 py-2 text-sm font-medium text-zinc-900 shadow-sm transition hover:bg-zinc-50 disabled:pointer-events-none disabled:opacity-40 dark:border-zinc-500/40 dark:bg-zinc-700/90 dark:text-zinc-100 dark:hover:bg-zinc-600" disabled>Disconnect</button>
      <label class="flex cursor-pointer items-center gap-1.5 text-xs text-zinc-700 dark:text-zinc-300"><input type="checkbox" class="multi-append-lf rounded border-zinc-300 text-blue-600 dark:border-zinc-600" checked /> Append LF</label>
      <label class="flex cursor-pointer items-center gap-1.5 text-xs text-zinc-700 dark:text-zinc-300"><input type="checkbox" class="multi-hex-send rounded border-zinc-300 text-blue-600 dark:border-zinc-600" /> Send as hex</label>
      <label class="flex cursor-pointer items-center gap-1.5 text-xs text-zinc-700 dark:text-zinc-300"><input type="checkbox" class="multi-hex-rx rounded border-zinc-300 text-blue-600 dark:border-zinc-600" /> RX as hex only</label>
      <button type="button" class="multi-btn-clear rounded-lg px-2 py-1 text-sm font-medium text-blue-600 transition hover:bg-blue-50 dark:text-blue-400 dark:hover:bg-blue-950/40">Clear log</button>
    </div>
    <pre class="multi-term-out max-h-[min(40vh,220px)] min-h-[100px] overflow-auto whitespace-pre-wrap break-words rounded-lg border border-black/10 bg-zinc-50 p-3 font-mono text-xs text-zinc-800 dark:border-zinc-500/35 dark:bg-zinc-900/50 dark:text-zinc-200" aria-live="polite"></pre>
    <div class="flex gap-2 pt-1">
      <input type="text" class="multi-send-input min-w-0 flex-1 rounded-lg border border-black/12 bg-white px-3 py-2 text-sm text-zinc-900 placeholder:text-zinc-400 dark:border-zinc-500/35 dark:bg-zinc-900/55 dark:text-zinc-100" placeholder="Type text or hex (when enabled)…" autocomplete="off" />
      <button type="button" class="multi-btn-send shrink-0 rounded-xl border border-blue-600 bg-blue-600 px-4 py-2 text-sm font-medium text-white shadow-sm transition hover:bg-blue-700 disabled:pointer-events-none disabled:opacity-40 dark:border-blue-500 dark:bg-blue-600 dark:hover:bg-blue-500" disabled>Send</button>
    </div>
  `;

  const serial = new StreamingSerial();
  wrap.__serial = serial;

  const pre = wrap.querySelector('.multi-term-out');
  const statusEl = wrap.querySelector('.multi-slot-status');
  const btnConnect = wrap.querySelector('.multi-btn-connect');
  const btnDisconnect = wrap.querySelector('.multi-btn-disconnect');
  const btnSend = wrap.querySelector('.multi-btn-send');
  const btnClear = wrap.querySelector('.multi-btn-clear');
  const input = wrap.querySelector('.multi-send-input');
  const baudSel = wrap.querySelector('.multi-baud');
  const appendLf = wrap.querySelector('.multi-append-lf');
  const hexSend = wrap.querySelector('.multi-hex-send');
  const hexRx = wrap.querySelector('.multi-hex-rx');

  function setUiConnected(connected) {
    statusEl.textContent = connected ? serial.getPortLabel() : 'Disconnected';
    btnConnect.disabled = connected;
    btnDisconnect.disabled = !connected;
    btnSend.disabled = !connected;
    baudSel.disabled = connected;
    input.disabled = !connected;
  }

  btnConnect.addEventListener('click', async () => {
    if (!StreamingSerial.isSupported()) {
      appendTerminal(pre, '[!] Web Serial not supported.', 'log-err');
      return;
    }
    try {
      appendTerminal(pre, '[…] Choose a serial port…', 'log-info');
      await serial.requestPort();
      const baud = parseInt(baudSel.value, 10);
      await serial.open({ baudRate: baud });
      serial.startReader((chunk) => {
        const ts = new Date().toLocaleTimeString('en-GB', { hour12: false });
        if (hexRx.checked) {
          appendTerminal(pre, `[${ts}] RX ${bytesToHexLine(chunk)}`, 'log-in');
        } else {
          appendTerminal(
            pre,
            `[${ts}] RX ${bytesToHexLine(chunk)}  |  ${asciiPreview(chunk)}`,
            'log-in',
          );
        }
      });
      setUiConnected(true);
      appendTerminal(pre, `[+] Open @ ${baud} baud — ${serial.getPortLabel()}`, 'log-info');
    } catch (e) {
      appendTerminal(pre, `[!] ${e.message}`, 'log-err');
      try {
        await serial.close();
      } catch (_) {}
      setUiConnected(false);
    }
  });

  btnDisconnect.addEventListener('click', async () => {
    try {
      await serial.close();
      appendTerminal(pre, '[-] Port closed.', 'log-info');
    } catch (e) {
      appendTerminal(pre, `[!] ${e.message}`, 'log-err');
    }
    setUiConnected(false);
  });

  function sendLine() {
    const raw = input.value;
    if (!serial.isOpen() || !raw.length) return;
    void (async () => {
      try {
        let payload;
        if (hexSend.checked) {
          payload = parseHexToBytes(raw);
        } else {
          let s = raw;
          if (appendLf.checked) s += '\n';
          payload = textEncoder.encode(s);
        }
        await serial.write(payload);
        const ts = new Date().toLocaleTimeString('en-GB', { hour12: false });
        appendTerminal(pre, `[${ts}] TX ${bytesToHexLine(payload)}`, 'log-out');
        input.value = '';
      } catch (e) {
        appendTerminal(pre, `[!] Send: ${e.message}`, 'log-err');
      }
    })();
  }

  btnSend.addEventListener('click', sendLine);
  input.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && !ev.shiftKey) {
      ev.preventDefault();
      sendLine();
    }
  });

  btnClear.addEventListener('click', () => {
    pre.textContent = '';
  });

  return wrap;
}

async function closeAllSlots(root) {
  const slots = root.querySelectorAll('.multi-slot');
  for (const el of slots) {
    const s = el.__serial;
    if (s && typeof s.isOpen === 'function' && s.isOpen()) {
      await s.close().catch(() => {});
    }
  }
}

function clampCount(n) {
  const x = Number.parseInt(String(n), 10);
  if (Number.isNaN(x)) return 1;
  return Math.min(MAX_SLOTS, Math.max(1, x));
}

export function initMultiTerminal() {
  const root = document.getElementById('multi-slots');
  const btnCreate = document.getElementById('multi-create');
  const inputCount = document.getElementById('multi-count');
  if (!root || !btnCreate || !inputCount) return;

  const saved = localStorage.getItem(COUNT_KEY);
  if (saved != null) {
    const v = clampCount(saved);
    inputCount.value = String(v);
  }

  btnCreate.addEventListener('click', async () => {
    const hadSlots = root.querySelectorAll('.multi-slot').length > 0;
    if (hadSlots) {
      const ok = window.confirm(
        'Recreate panels? Any open serial ports in this tab will be closed first.',
      );
      if (!ok) return;
    }
    await closeAllSlots(root);

    const n = clampCount(inputCount.value);
    inputCount.value = String(n);
    localStorage.setItem(COUNT_KEY, String(n));

    root.innerHTML = '';
    root.className = ROOT_GRID;
    for (let i = 1; i <= n; i += 1) {
      root.appendChild(createSlot(i));
    }
  });
}
