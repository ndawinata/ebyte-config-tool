/*
 * Tiny Web Serial API wrapper for the E22 module.
 * Requires a Chromium-based browser (Chrome / Edge / Opera) on a
 * secure origin (https:// or http://localhost or file:// in some flags).
 */

export class SerialBridge {
  constructor() {
    this.port = null;
    this.reader = null;
    this.writer = null;
    this._readBuffer = [];
    this._readResolvers = [];
    this._readLoopPromise = null;
    this._closing = false;
  }

  static isSupported() {
    return 'serial' in navigator;
  }

  /** Prompt the user to choose a serial device. */
  async requestPort() {
    if (!SerialBridge.isSupported()) {
      throw new Error('Web Serial is not supported in this browser. Use a recent Chrome or Edge.');
    }
    this.port = await navigator.serial.requestPort();
    return this.port;
  }

  /** Open the chosen serial port with typical E22 config-mode defaults. */
  async open(options = {}) {
    if (!this.port) {
      throw new Error('No port selected. Click "Open Port" first.');
    }
    const opts = Object.assign(
      {
        baudRate: 9600,
        dataBits: 8,
        stopBits: 1,
        parity:   'none',
        bufferSize: 4096,
        flowControl: 'none',
      },
      options,
    );
    await this.port.open(opts);
    this.writer = this.port.writable.getWriter();
    this.reader = this.port.readable.getReader();
    this._closing = false;
    this._readLoopPromise = this._readLoop();
  }

  async _readLoop() {
    try {
      while (!this._closing) {
        const { value, done } = await this.reader.read();
        if (done) break;
        if (value && value.length) {
          for (const b of value) this._readBuffer.push(b);
          this._flushResolvers();
        }
      }
    } catch (err) {
      if (!this._closing) console.warn('Serial read loop error:', err);
    }
  }

  _flushResolvers() {
    while (this._readResolvers.length && this._readBuffer.length) {
      const { resolve, count } = this._readResolvers[0];
      if (this._readBuffer.length >= count) {
        const out = this._readBuffer.splice(0, count);
        this._readResolvers.shift();
        resolve(new Uint8Array(out));
      } else {
        break;
      }
    }
  }

  /** Wait for `count` bytes from the device with a timeout. */
  readBytes(count, timeoutMs = 1500) {
    return new Promise((resolve, reject) => {
      const entry = { count, resolve };
      this._readResolvers.push(entry);
      this._flushResolvers();
      if (this._readResolvers.includes(entry)) {
        setTimeout(() => {
          const idx = this._readResolvers.indexOf(entry);
          if (idx !== -1) {
            this._readResolvers.splice(idx, 1);
            const drained = this._readBuffer.splice(0);
            if (drained.length) {
              resolve(new Uint8Array(drained));
            } else {
              reject(new Error('Serial read timed out.'));
            }
          }
        }, timeoutMs);
      }
    });
  }

  /** Read whatever is available within the given window. */
  async readWithin(timeoutMs = 600) {
    await new Promise(r => setTimeout(r, timeoutMs));
    const drained = this._readBuffer.splice(0);
    return new Uint8Array(drained);
  }

  async write(bytes) {
    if (!this.writer) throw new Error('Port is not open.');
    await this.writer.write(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes));
  }

  /** Round-trip: send a command, then collect the response. */
  async command(bytes, { responseLength = null, timeoutMs = 1200 } = {}) {
    this._readBuffer.length = 0;
    await this.write(bytes);
    if (responseLength) {
      return await this.readBytes(responseLength, timeoutMs);
    }
    return await this.readWithin(timeoutMs);
  }

  isOpen() {
    return !!(this.port && this.port.readable && this.writer);
  }

  async close() {
    this._closing = true;
    try { if (this.reader) { await this.reader.cancel().catch(() => {}); this.reader.releaseLock(); } } catch (_) {}
    try { if (this.writer) { await this.writer.close().catch(() => {}); this.writer.releaseLock?.(); } } catch (_) {}
    try { if (this.port)   { await this.port.close().catch(() => {}); } } catch (_) {}
    this.reader = null;
    this.writer = null;
  }

  /** Get a friendly identifier string for the open port. */
  getPortLabel() {
    if (!this.port) return 'No port';
    const info = this.port.getInfo?.() || {};
    const v = info.usbVendorId  ? info.usbVendorId.toString(16).padStart(4, '0').toUpperCase() : '----';
    const p = info.usbProductId ? info.usbProductId.toString(16).padStart(4, '0').toUpperCase() : '----';
    return `USB ${v}:${p}`;
  }
}
