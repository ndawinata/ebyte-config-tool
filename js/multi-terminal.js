/**
 * Multi-device UART terminal tab: several StreamingSerial instances,
 * send/receive per slot for E22 transparent-mode testing.
 */
import { StreamingSerial } from './streaming-serial.js';

const MAX_SLOTS = 6;
const COUNT_KEY = 'multi-device-count';
const textEncoder = new TextEncoder();

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
  if (cls) span.className = cls;
  span.textContent = line + '\n';
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
  wrap.className = 'multi-slot';
  wrap.dataset.slotIndex = String(index);
  wrap.innerHTML = `
    <div class="multi-slot-head">
      <span class="multi-slot-title">Device ${index}</span>
      <span class="multi-slot-status muted small">Disconnected</span>
    </div>
    <div class="multi-slot-toolbar">
      <div class="field narrow">
        <label>Baud</label>
        <select class="multi-baud">
          <option value="9600" selected>9600</option>
          <option value="19200">19200</option>
          <option value="38400">38400</option>
          <option value="57600">57600</option>
          <option value="115200">115200</option>
        </select>
      </div>
      <button type="button" class="btn btn-primary multi-btn-connect">Connect</button>
      <button type="button" class="btn multi-btn-disconnect" disabled>Disconnect</button>
      <label class="check inline"><input type="checkbox" class="multi-append-lf" checked /> Append LF</label>
      <label class="check inline"><input type="checkbox" class="multi-hex-send" /> Send as hex</label>
      <label class="check inline"><input type="checkbox" class="multi-hex-rx" /> RX as hex only</label>
      <button type="button" class="btn btn-ghost multi-btn-clear">Clear log</button>
    </div>
    <pre class="multi-term-out log" aria-live="polite"></pre>
    <div class="multi-slot-send">
      <input type="text" class="multi-send-input" placeholder="Type text or hex (when enabled)…" autocomplete="off" />
      <button type="button" class="btn btn-primary multi-btn-send" disabled>Send</button>
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
    root.classList.remove('multi-slots-empty');
    for (let i = 1; i <= n; i += 1) {
      root.appendChild(createSlot(i));
    }
  });
}
