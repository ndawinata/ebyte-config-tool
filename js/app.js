/*
 * Application logic — UI ↔ E22 serial protocol via Web Serial.
 */
import { SerialBridge } from './serial.js';
import {
  COMMAND, REQ, FREQUENCY_BANDS,
  encodeConfig, decodeConfig, buildFrame, bytesToHex,
} from './e22.js';
import { initMultiTerminal } from './multi-terminal.js';

const $  = (id) => document.getElementById(id);
const qs = (sel, root = document) => root.querySelector(sel);

const serial = new SerialBridge();
let currentBand = '400';

// ===== Logging =====
const logEl = $('log');
function log(msg, kind = 'info') {
  const time = new Date().toLocaleTimeString('en-GB', { hour12: false });
  const span = document.createElement('span');
  span.className = `log-${kind}`;
  span.textContent = `[${time}] ${msg}\n`;
  logEl.appendChild(span);
  logEl.scrollTop = logEl.scrollHeight;
}

// ===== Status pill =====
function setStatus(text, type = 'muted') {
  const pill = $('status-pill');
  pill.classList.remove('pill-muted','pill-busy','pill-ok','pill-error');
  pill.classList.add(`pill-${type}`);
  $('status-text').textContent = text;
}

function setConnectedUI(connected) {
  $('btn-open').disabled  = connected;
  $('btn-close').disabled = !connected;
  for (const id of ['btn-get','btn-set','btn-reset','btn-r-get','btn-r-set','btn-raw-send']) {
    $(id).disabled = !connected;
  }
  $('port-label').textContent = connected ? serial.getPortLabel() : '—';
}

// ===== Tabs =====
document.querySelectorAll('.tab').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('tab-active'));
    btn.classList.add('tab-active');
    const target = btn.dataset.tab;
    document.querySelectorAll('.tab-panel').forEach(p => {
      p.classList.toggle('hidden', p.dataset.panel !== target);
    });
  });
});

// ===== Theme: dark / light / system =====
const THEME_KEY = 'e22-theme';

function normalizeThemeMode(raw) {
  if (raw === 'light' || raw === 'dark' || raw === 'system') return raw;
  if (raw === 'true') return 'light';
  return 'system';
}

let themeMode = normalizeThemeMode(localStorage.getItem(THEME_KEY));

function applyDocumentTheme() {
  const root = document.documentElement;
  root.removeAttribute('data-theme');
  if (themeMode === 'light') root.dataset.theme = 'light';
  else if (themeMode === 'dark') root.dataset.theme = 'dark';
  document.querySelectorAll('.theme-seg').forEach((btn) => {
    btn.classList.toggle('theme-seg-active', btn.dataset.themeMode === themeMode);
  });
}

applyDocumentTheme();

document.querySelectorAll('.theme-seg').forEach((btn) => {
  btn.addEventListener('click', () => {
    themeMode = normalizeThemeMode(btn.dataset.themeMode);
    localStorage.setItem(THEME_KEY, themeMode);
    applyDocumentTheme();
  });
});

// ===== Address / key dual hex+dec inputs =====
function bind16BitPair(hexId, decId) {
  const hexInput = $(hexId);
  const decInput = $(decId);
  hexInput.addEventListener('input', () => {
    const v = parseInt(hexInput.value || '0', 16);
    if (!Number.isNaN(v)) decInput.value = v;
  });
  decInput.addEventListener('input', () => {
    const v = parseInt(decInput.value || '0', 10);
    if (!Number.isNaN(v)) hexInput.value = v.toString(16).toUpperCase().padStart(4, '0');
  });
}
bind16BitPair('addr-hex', 'addr-dec');
bind16BitPair('key-hex',  'key-dec');

initMultiTerminal();

// ===== Frequency band =====
function applyBand(band) {
  currentBand = band;
  const info = FREQUENCY_BANDS[band];
  $('ch-band').textContent = `${info.start}–${info.end}`;
  const ch = $('channel');
  if (+ch.value < info.start || +ch.value > info.end) {
    ch.value = info.start + 23; // default channel
  }
  ch.min = info.start;
  ch.max = info.end;
  $('r-channel').min = info.start;
  $('r-channel').max = info.end;
  log(`Frequency band: ${info.label}`, 'info');
}
$('model').addEventListener('change', e => applyBand(e.target.value));
applyBand('400');

// ===== Form helpers =====
function readForm() {
  const addr = parseInt($('addr-dec').value || '0', 10) & 0xFFFF;
  const key  = parseInt($('key-dec').value  || '0', 10) & 0xFFFF;
  return {
    ADDH: (addr >> 8) & 0xFF,
    ADDL:  addr       & 0xFF,
    NETID: parseInt($('netid').value || '0', 10) & 0xFF,
    uartBaud:     $('uart-baud').value,
    parity:       $('parity').value,
    airBaud:      $('air-baud').value,
    subPacket:    $('sub-packet').value,
    ambientNoise: $('ambient').checked,
    power:        $('power').value,
    channel:      parseInt($('channel').value || '0', 10),
    rssiPacket:   $('rssi-packet').checked,
    txMode:       $('tx-mode').value,
    repeater:     $('repeater').checked,
    lbt:          $('lbt').checked,
    worMode:      $('wor-mode').value,
    worCycle:     $('wor-cycle').value,
    cryptH:       (key >> 8) & 0xFF,
    cryptL:        key       & 0xFF,
  };
}

function writeForm(cfg) {
  const addr = ((cfg.ADDH & 0xFF) << 8) | (cfg.ADDL & 0xFF);
  $('addr-dec').value = addr;
  $('addr-hex').value = addr.toString(16).toUpperCase().padStart(4, '0');
  $('netid').value = cfg.NETID ?? 0;

  if (cfg.uartBaud)  $('uart-baud').value  = cfg.uartBaud;
  if (cfg.parity)    $('parity').value     = cfg.parity;
  if (cfg.airBaud)   $('air-baud').value   = cfg.airBaud;
  if (cfg.subPacket) $('sub-packet').value = cfg.subPacket;
  if (cfg.power)     $('power').value      = cfg.power;
  if (cfg.txMode)    $('tx-mode').value    = cfg.txMode;
  if (cfg.worMode)   $('wor-mode').value   = cfg.worMode;
  if (cfg.worCycle)  $('wor-cycle').value  = cfg.worCycle;
  $('ambient').checked     = !!cfg.ambientNoise;
  $('rssi-packet').checked = !!cfg.rssiPacket;
  $('repeater').checked    = !!cfg.repeater;
  $('lbt').checked         = !!cfg.lbt;
  if (cfg.channel != null) $('channel').value = cfg.channel;
}

// ===== Open / Close port =====
$('btn-open').addEventListener('click', async () => {
  try {
    setStatus('Selecting port…', 'busy');
    await serial.requestPort();
    await serial.open({ baudRate: parseInt($('config-baud').value, 10) });
    setStatus(`Connected · ${serial.getPortLabel()}`, 'ok');
    setConnectedUI(true);
    log(`Port opened @ ${$('config-baud').value} bps`, 'info');
    fetchProductInfo().catch(() => {});
  } catch (err) {
    setStatus('Failed to open port', 'error');
    log(err.message, 'err');
  }
});

$('btn-close').addEventListener('click', async () => {
  await serial.close();
  setConnectedUI(false);
  setStatus('Disconnected', 'muted');
  log('Port closed', 'info');
});

// ===== Get Param =====
async function fetchProductInfo() {
  try {
    const frame = buildFrame(COMMAND.GET_REGISTER, REQ.GET_PRODUCT_INFO[0], REQ.GET_PRODUCT_INFO[1]);
    log(`TX » ${bytesToHex(frame)}`, 'out');
    const resp = await serial.command(frame, { responseLength: 3 + REQ.GET_PRODUCT_INFO[1], timeoutMs: 1500 });
    if (resp.length >= 3) {
      log(`RX « ${bytesToHex(resp)}`, 'in');
      const pidBytes = resp.slice(3);
      const pidStr = Array.from(pidBytes, b => b.toString(16).padStart(2, '0').toUpperCase()).join('');
      $('pid-label').textContent = pidStr || '—';
    }
  } catch (err) {
    log('PID read: ' + err.message, 'err');
  }
}

$('btn-get').addEventListener('click', async () => {
  try {
    setStatus('Reading configuration…', 'busy');
    const frame = buildFrame(COMMAND.GET_REGISTER, REQ.GET_CONFIG[0], REQ.GET_CONFIG[1]);
    log(`TX » ${bytesToHex(frame)}`, 'out');
    const resp = await serial.command(frame, {
      responseLength: 3 + REQ.GET_CONFIG[1], // header + 9 register bytes
      timeoutMs: 1500,
    });
    log(`RX « ${bytesToHex(resp)}`, 'in');
    if (resp.length < 3 + 9) {
      throw new Error(`Response too short (${resp.length} bytes). Put the module in config mode (M0=1, M1=1).`);
    }
    if (resp[0] !== 0xC1) {
      throw new Error(`Invalid response header: 0x${resp[0].toString(16)}`);
    }
    const args = resp.slice(3, 3 + 9);
    const cfg = decodeConfig(args, FREQUENCY_BANDS[currentBand].start);
    writeForm(cfg);
    setStatus('Configuration read', 'ok');
    log('Get Param finished.', 'info');
  } catch (err) {
    setStatus('Get Param failed', 'error');
    log(err.message, 'err');
  }
});

// ===== Set Param =====
$('btn-set').addEventListener('click', async () => {
  try {
    setStatus('Writing configuration…', 'busy');
    const cfg = readForm();
    const args = encodeConfig(cfg, FREQUENCY_BANDS[currentBand].start);
    const frame = buildFrame(COMMAND.SET_REGISTER, REQ.SET_CONFIG[0], REQ.SET_CONFIG[1], Array.from(args));
    log(`TX » ${bytesToHex(frame)}`, 'out');
    const resp = await serial.command(frame, { responseLength: 3 + REQ.SET_CONFIG[1], timeoutMs: 1500 });
    log(`RX « ${bytesToHex(resp)}`, 'in');
    if (resp.length < 3 + 9) {
      throw new Error('Module did not respond as expected. Try again.');
    }
    setStatus('Configuration saved', 'ok');
    log('Set Param finished.', 'info');
  } catch (err) {
    setStatus('Set Param failed', 'error');
    log(err.message, 'err');
  }
});

// ===== Param Reset =====
$('btn-reset').addEventListener('click', async () => {
  if (!confirm('Reset all parameters to factory defaults? This will write to the module.')) return;
  try {
    setStatus('Resetting…', 'busy');
    const defaults = {
      ADDH: 0, ADDL: 0, NETID: 0,
      uartBaud: '9600', parity: '8N1', airBaud: '2.4k',
      subPacket: '240', ambientNoise: false, power: '30',
      channel: FREQUENCY_BANDS[currentBand].start + 23,
      rssiPacket: false, txMode: 'Transparent', repeater: false, lbt: false,
      worMode: 'Receiver', worCycle: '2000',
      cryptH: 0, cryptL: 0,
    };
    writeForm(defaults);
    const args = encodeConfig(defaults, FREQUENCY_BANDS[currentBand].start);
    const frame = buildFrame(COMMAND.SET_REGISTER, REQ.SET_CONFIG[0], REQ.SET_CONFIG[1], Array.from(args));
    log(`TX » ${bytesToHex(frame)}`, 'out');
    const resp = await serial.command(frame, { responseLength: 3 + REQ.SET_CONFIG[1], timeoutMs: 1500 });
    log(`RX « ${bytesToHex(resp)}`, 'in');
    setStatus('Reset complete', 'ok');
    log('Param reset finished.', 'info');
  } catch (err) {
    setStatus('Reset failed', 'error');
    log(err.message, 'err');
  }
});

// ===== File Save / Load =====
$('btn-save').addEventListener('click', () => {
  const cfg = readForm();
  const out = {
    _meta: {
      app: 'RF Setting Ebyte',
      version: '1.0',
      band: currentBand,
      savedAt: new Date().toISOString(),
    },
    ...cfg,
  };
  const blob = new Blob([JSON.stringify(out, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `e22-config-${Date.now()}.json`;
  a.click();
  URL.revokeObjectURL(url);
  log('Configuration saved to file.', 'info');
});

$('btn-load').addEventListener('click', () => $('file-load').click());
$('file-load').addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    if (data._meta?.band && FREQUENCY_BANDS[data._meta.band]) {
      $('model').value = data._meta.band;
      applyBand(data._meta.band);
    }
    writeForm(data);
    log(`Configuration loaded: ${file.name}`, 'info');
  } catch (err) {
    log('Load file failed: ' + err.message, 'err');
  } finally {
    e.target.value = '';
  }
});

// ===== Clear log =====
$('btn-clear-log').addEventListener('click', () => { logEl.textContent = ''; });

// ===== Remote Get / Set (experimental, fixed-point) =====
async function remoteFrame(commandByte) {
  // Experimental: WIRELESS_CONFIG prefix 0xCF 0xCF, then mirror GET/SET.
  // Public spec is incomplete—use with care.
  const addh = parseInt($('r-addh').value || '0', 10) & 0xFF;
  const addl = parseInt($('r-addl').value || '0', 10) & 0xFF;
  const ch   = (parseInt($('r-channel').value || '0', 10) - FREQUENCY_BANDS[currentBand].start) & 0xFF;
  return new Uint8Array([
    0xCF, 0xCF,
    addh, addl, ch,
    commandByte, REQ.GET_CONFIG[0], REQ.GET_CONFIG[1],
  ]);
}
$('btn-r-get').addEventListener('click', async () => {
  try {
    const frame = await remoteFrame(COMMAND.GET_REGISTER);
    log(`TX » ${bytesToHex(frame)}`, 'out');
    const resp = await serial.command(frame, { timeoutMs: 2000 });
    log(`RX « ${bytesToHex(resp)}`, 'in');
  } catch (err) { log(err.message, 'err'); }
});
$('btn-r-set').addEventListener('click', async () => {
  try {
    const cfg  = readForm();
    const args = encodeConfig(cfg, FREQUENCY_BANDS[currentBand].start);
    const head = await remoteFrame(COMMAND.SET_REGISTER);
    const frame = new Uint8Array([...head, ...args]);
    log(`TX » ${bytesToHex(frame)}`, 'out');
    const resp = await serial.command(frame, { timeoutMs: 2500 });
    log(`RX « ${bytesToHex(resp)}`, 'in');
  } catch (err) { log(err.message, 'err'); }
});

// ===== Raw send (download tab) =====
$('btn-raw-send').addEventListener('click', async () => {
  try {
    const text = $('raw-bytes').value.trim();
    const bytes = text.split(/\s+/).map(s => parseInt(s, 16)).filter(n => !Number.isNaN(n));
    if (!bytes.length) throw new Error('Invalid hex input.');
    const frame = new Uint8Array(bytes);
    log(`TX » ${bytesToHex(frame)}`, 'out');
    const resp = await serial.command(frame, { timeoutMs: 1500 });
    if (resp.length) log(`RX « ${bytesToHex(resp)}`, 'in');
    else log('No response (timeout).', 'err');
  } catch (err) { log(err.message, 'err'); }
});

// ===== Boot =====
window.addEventListener('load', () => {
  if (!SerialBridge.isSupported()) {
    setStatus('Web Serial not supported', 'error');
    log('This browser does not support the Web Serial API. Use a recent Chrome, Edge, or Opera.', 'err');
    $('btn-open').disabled = true;
  } else {
    log('Ready. Click "Open Port" to pick your USB-Serial device.', 'info');
  }
});

// Disconnect listener (cable unplugged)
if ('serial' in navigator) {
  navigator.serial.addEventListener('disconnect', async () => {
    if (!serial.isOpen()) return;
    log('Device disconnected.', 'err');
    await serial.close();
    setConnectedUI(false);
    setStatus('Device disconnected', 'error');
  });
}
