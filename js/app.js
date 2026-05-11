/*
 * Application logic — UI ↔ E22 serial protocol via Web Serial.
 */
import { SerialBridge } from './serial.js';
import {
  COMMAND, REQ, FREQUENCY_BANDS, REGISTER,
  encodeConfig, decodeConfig, buildFrame, bytesToHex,
  buildSetConfigFrame,
  getPowerProfile,
} from './e22.js';
import { initMultiTerminal } from './multi-terminal.js';

const $  = (id) => document.getElementById(id);
const qs = (sel, root = document) => root.querySelector(sel);

const serial = new SerialBridge();

const logEl = $('log');

const LOG_LINE = 'font-mono text-[12px] leading-relaxed ';
const LOG_KIND = {
  out: `${LOG_LINE}text-amber-600 dark:text-amber-400`,
  in: `${LOG_LINE}text-emerald-600 dark:text-emerald-400`,
  err: `${LOG_LINE}text-red-600 dark:text-red-400`,
  info: `${LOG_LINE}text-blue-600 dark:text-blue-400`,
};

function log(msg, kind = 'info') {
  const time = new Date().toLocaleTimeString('en-GB', { hour12: false });
  const span = document.createElement('span');
  span.className = LOG_KIND[kind] ?? LOG_KIND.info;
  span.textContent = `[${time}] ${msg}\n`;
  logEl.appendChild(span);
  logEl.scrollTop = logEl.scrollHeight;
}

const PILL_BASE =
  'inline-flex items-center gap-2 rounded-full border px-3 py-1.5 text-xs font-medium ';
const PILL_TYPE = {
  muted: `${PILL_BASE}border-zinc-200 bg-zinc-100 text-zinc-600 dark:border-zinc-500/40 dark:bg-zinc-700/80 dark:text-zinc-300`,
  busy: `${PILL_BASE}border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900/40 dark:bg-amber-950/40 dark:text-amber-200`,
  ok: `${PILL_BASE}border-emerald-200 bg-emerald-50 text-emerald-900 dark:border-emerald-900/40 dark:bg-emerald-950/40 dark:text-emerald-200`,
  error: `${PILL_BASE}border-red-200 bg-red-50 text-red-900 dark:border-red-900/40 dark:bg-red-950/40 dark:text-red-200`,
};

// ===== Status pill =====
function setStatus(text, type = 'muted') {
  const pill = $('status-pill');
  pill.className = PILL_TYPE[type] ?? PILL_TYPE.muted;
  $('status-text').textContent = text;
}

/** Local tab: inputs editable only after a successful Get Param (or Load File). */
let moduleParamsUnlocked = false;

const freqMHzFmt = new Intl.NumberFormat('id-ID', {
  minimumFractionDigits: 1,
  maximumFractionDigits: 3,
});

function formatFreqMHz(mhz) {
  if (!Number.isFinite(mhz)) return '—';
  return `${freqMHzFmt.format(mhz)} MHz`;
}

function formatCommaHexBytes0x(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return [...u8].map((b) => `0x${b.toString(16).padStart(2, '0')}`).join(' ');
}

/** RF centre frequency per E22 datasheet (.125 MHz channel grid for preset bands). */
function formatRfMegahertzFromReg2(rawArgs) {
  const reg2 = rawArgs[REGISTER.REG2] & 0xff;
  const info = getActiveBandInfo();
  let mhz;
  if (info.preset === '400') mhz = 410.125 + reg2;
  else if (info.preset === '900') mhz = 850.125 + reg2;
  else if (info.preset === '230') mhz = 220.125 + reg2;
  else mhz = info.start + reg2;
  return formatFreqMHz(mhz);
}

const POWER_PROFILE_KEY = 'e22-power-profile';

function getActivePowerProfile() {
  return getPowerProfile($('power-profile')?.value);
}

function syncPowerSelectOptions(profile) {
  const sel = $('power');
  const prev = sel.value;
  sel.replaceChildren(...profile.byCode.map((dbm) => {
    const opt = document.createElement('option');
    opt.value = dbm;
    opt.textContent = `${dbm} dBm`;
    return opt;
  }));
  const idx = profile.byCode.indexOf(prev);
  sel.value = idx >= 0 ? profile.byCode[idx] : profile.byCode[0];
}

function initPowerProfileUI() {
  const sel = $('power-profile');
  if (!sel) return;
  const saved = localStorage.getItem(POWER_PROFILE_KEY);
  if (saved === 'pa22' || saved === 'pa30') sel.value = saved;
  sel.dataset.activeId = sel.value;
  syncPowerSelectOptions(getActivePowerProfile());
  sel.addEventListener('change', () => {
    const oldId = sel.dataset.activeId || 'pa30';
    const oldP = getPowerProfile(oldId);
    const newP = getActivePowerProfile();
    let idx = oldP.byCode.indexOf($('power').value);
    if (idx < 0) idx = 0;
    syncPowerSelectOptions(newP);
    $('power').value = newP.byCode[Math.min(idx, newP.byCode.length - 1)];
    sel.dataset.activeId = newP.id;
    localStorage.setItem(POWER_PROFILE_KEY, newP.id);
  });
}

function clearModuleStatusPanel() {
  for (const id of ['module-freq-now', 'module-param-now']) {
    const el = $(id);
    if (el) el.textContent = '—';
  }
}

function updateModuleStatusFromConfig(rawArgs) {
  const u8 = rawArgs instanceof Uint8Array ? rawArgs : new Uint8Array(rawArgs);
  $('module-freq-now').textContent = formatRfMegahertzFromReg2(u8);
  try {
    const frame = buildSetConfigFrame(u8);
    $('module-param-now').textContent = formatCommaHexBytes0x(frame);
  } catch {
    $('module-param-now').textContent = '—';
  }
}

function refreshParamEditState() {
  const connected = serial.isOpen();
  const canEditFields = moduleParamsUnlocked;
  const canWriteModule = connected && moduleParamsUnlocked;
  const fs = $('local-params-fieldset');
  if (fs) fs.disabled = !canEditFields;
  $('btn-set').disabled = !canWriteModule;
  $('btn-reset').disabled = !canWriteModule;
  $('btn-r-set').disabled = !canWriteModule;
}

function setConnectedUI(connected) {
  $('btn-open').disabled  = connected;
  $('btn-close').disabled = !connected;
  $('btn-get').disabled   = !connected;
  $('btn-r-get').disabled = !connected;
  $('btn-raw-send').disabled = !connected;
  $('port-label').textContent = connected ? serial.getPortLabel() : '—';
  if (!connected) {
    clearModuleStatusPanel();
    $('pid-label').textContent = '—';
  }
  refreshParamEditState();
}

// ===== Tabs =====
const TAB_ACTIVE =
  'tab rounded-lg bg-white px-4 py-2.5 text-[13px] font-medium text-zinc-900 shadow-sm transition dark:bg-zinc-700 dark:text-white dark:ring-1 dark:ring-white/10';
const TAB_IDLE =
  'tab rounded-lg px-4 py-2.5 text-[13px] font-medium text-zinc-500 transition hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200';

document.querySelectorAll('.tab').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => {
      t.className = TAB_IDLE;
    });
    btn.className = TAB_ACTIVE;
    const target = btn.dataset.tab;
    document.querySelectorAll('.tab-panel').forEach((p) => {
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

let systemThemeListener = null;

function syncDarkClass() {
  const root = document.documentElement;
  root.classList.remove('dark');
  if (themeMode === 'dark') root.classList.add('dark');
  else if (themeMode === 'light') return;
  else if (window.matchMedia('(prefers-color-scheme: dark)').matches) {
    root.classList.add('dark');
  }
}

const SEG_ACTIVE =
  'theme-seg rounded-lg bg-white px-3 py-1.5 text-xs font-medium text-zinc-900 shadow-sm transition dark:bg-zinc-700 dark:text-white dark:ring-1 dark:ring-white/10';
const SEG_IDLE =
  'theme-seg rounded-lg px-3 py-1.5 text-xs font-medium text-zinc-500 transition hover:text-zinc-800 dark:text-zinc-400 dark:hover:text-zinc-200';

function applyDocumentTheme() {
  syncDarkClass();
  if (systemThemeListener) {
    window.matchMedia('(prefers-color-scheme: dark)').removeEventListener('change', systemThemeListener);
    systemThemeListener = null;
  }
  if (themeMode === 'system') {
    systemThemeListener = () => syncDarkClass();
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', systemThemeListener);
  }
  document.querySelectorAll('.theme-seg').forEach((btn) => {
    btn.className = btn.dataset.themeMode === themeMode ? SEG_ACTIVE : SEG_IDLE;
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

// ===== Frequency band (preset or custom MHz; UART protocol = E22-E9X register map) =====
function getActiveBandInfo() {
  const m = $('model').value;
  if (m === 'custom') {
    let start = Math.round(Number.parseFloat(String($('custom-freq-base').value)));
    let end = Math.round(Number.parseFloat(String($('custom-freq-end').value)));
    if (!Number.isFinite(start)) start = 410;
    if (!Number.isFinite(end)) end = start + 83;
    if (end < start) end = start;
    const maxEnd = start + 255;
    if (end > maxEnd) end = maxEnd;
    return {
      preset: 'custom',
      start,
      end,
      label: `${start}–${end} MHz (custom)`,
    };
  }
  const fb = FREQUENCY_BANDS[m];
  return {
    preset: m,
    start: fb.start,
    end: fb.end,
    label: fb.label,
  };
}

function syncCustomBandRowVisibility() {
  const row = $('custom-band-row');
  if (!row) return;
  row.classList.toggle('hidden', $('model').value !== 'custom');
}

function applyBand() {
  syncCustomBandRowVisibility();
  const info = getActiveBandInfo();
  $('ch-band').textContent = `${info.start}–${info.end}`;
  const ch = $('channel');
  if (+ch.value < info.start || +ch.value > info.end) {
    const span = info.end - info.start;
    const mid = info.start + Math.min(23, Math.max(0, Math.floor(span / 2)));
    ch.value = String(mid);
  }
  ch.min = info.start;
  ch.max = info.end;
  $('r-channel').min = info.start;
  $('r-channel').max = info.end;
  log(`Band: ${info.label}`, 'info');
}

$('model').addEventListener('change', () => applyBand());
['custom-freq-base', 'custom-freq-end'].forEach((id) => {
  const el = $(id);
  if (el) el.addEventListener('change', () => { if ($('model').value === 'custom') applyBand(); });
});
applyBand();
initPowerProfileUI();

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
  if (cfg.power) {
    const p = getActivePowerProfile();
    const s = String(cfg.power);
    $('power').value = p.byCode.includes(s) ? s : p.byCode[0];
  }
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
    const cfg = decodeConfig(args, getActiveBandInfo().start, getActivePowerProfile());
    writeForm(cfg);
    moduleParamsUnlocked = true;
    refreshParamEditState();
    updateModuleStatusFromConfig(args);
    await fetchProductInfo();
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
    const args = encodeConfig(cfg, getActiveBandInfo().start, getActivePowerProfile());
    const frame = buildFrame(COMMAND.SET_REGISTER, REQ.SET_CONFIG[0], REQ.SET_CONFIG[1], Array.from(args));
    log(`TX » ${bytesToHex(frame)}`, 'out');
    const resp = await serial.command(frame, { responseLength: 3 + REQ.SET_CONFIG[1], timeoutMs: 1500 });
    log(`RX « ${bytesToHex(resp)}`, 'in');
    if (resp.length < 3 + 9) {
      throw new Error('Module did not respond as expected. Try again.');
    }
    setStatus('Configuration saved', 'ok');
    const cfgAfter = readForm();
    const argsOut = encodeConfig(cfgAfter, getActiveBandInfo().start, getActivePowerProfile());
    updateModuleStatusFromConfig(argsOut);
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
    const band = getActiveBandInfo();
    const span = band.end - band.start;
    const defCh = band.start + Math.min(23, Math.max(0, span));
    const pp = getActivePowerProfile();
    const defaults = {
      ADDH: 0, ADDL: 0, NETID: 0,
      uartBaud: '9600', parity: '8N1', airBaud: '2.4k',
      subPacket: '240', ambientNoise: false, power: pp.byCode[0],
      channel: defCh,
      rssiPacket: false, txMode: 'Transparent', repeater: false, lbt: false,
      worMode: 'Receiver', worCycle: '2000',
      cryptH: 0, cryptL: 0,
    };
    writeForm(defaults);
    const args = encodeConfig(defaults, band.start, pp);
    const frame = buildFrame(COMMAND.SET_REGISTER, REQ.SET_CONFIG[0], REQ.SET_CONFIG[1], Array.from(args));
    log(`TX » ${bytesToHex(frame)}`, 'out');
    const resp = await serial.command(frame, { responseLength: 3 + REQ.SET_CONFIG[1], timeoutMs: 1500 });
    log(`RX « ${bytesToHex(resp)}`, 'in');
    setStatus('Reset complete', 'ok');
    const cfgAfter = readForm();
    const argsOut = encodeConfig(cfgAfter, band.start, getActivePowerProfile());
    updateModuleStatusFromConfig(argsOut);
    log('Param reset finished.', 'info');
  } catch (err) {
    setStatus('Reset failed', 'error');
    log(err.message, 'err');
  }
});

// ===== File Save / Load =====
$('btn-save').addEventListener('click', () => {
  const cfg = readForm();
  const bandInfo = getActiveBandInfo();
  const out = {
    _meta: {
      app: 'RF Setting Ebyte',
      version: '1.0',
      band: bandInfo.preset,
      ...(bandInfo.preset === 'custom'
        ? { customBase: bandInfo.start, customEnd: bandInfo.end }
        : {}),
      powerProfile: getActivePowerProfile().id,
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
    if (data._meta?.band === 'custom' && Number.isFinite(Number(data._meta.customBase))) {
      $('model').value = 'custom';
      $('custom-freq-base').value = String(data._meta.customBase);
      $('custom-freq-end').value = String(
        Number.isFinite(Number(data._meta.customEnd)) ? data._meta.customEnd : Number(data._meta.customBase) + 83,
      );
      applyBand();
    } else if (data._meta?.band && FREQUENCY_BANDS[data._meta.band]) {
      $('model').value = data._meta.band;
      applyBand();
    }
    const ppid = data._meta?.powerProfile;
    if (ppid === 'pa22' || ppid === 'pa30') {
      $('power-profile').value = ppid;
      $('power-profile').dataset.activeId = ppid;
      syncPowerSelectOptions(getPowerProfile(ppid));
    }
    writeForm(data);
    moduleParamsUnlocked = true;
    refreshParamEditState();
    const cfgLoaded = readForm();
    const rawLoaded = encodeConfig(cfgLoaded, getActiveBandInfo().start, getActivePowerProfile());
    updateModuleStatusFromConfig(rawLoaded);
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
  const ch   = (parseInt($('r-channel').value || '0', 10) - getActiveBandInfo().start) & 0xFF;
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
    const args = encodeConfig(cfg, getActiveBandInfo().start, getActivePowerProfile());
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
