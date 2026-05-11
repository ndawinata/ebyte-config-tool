/*
 * E22-E9X(SL) protocol constants & encode/decode helpers.
 * Register layout aligned with RF Setting E22-E9X(SL) v3.5.
 */

export const COMMAND = {
  SET_REGISTER:           0xC0, // Permanent write
  GET_REGISTER:           0xC1, // Read
  SET_TEMPORARY_REGISTER: 0xC2, // Volatile write (lost on power cycle)
  WIRELESS_CONFIG_PREFIX: [0xCF, 0xCF],
};

export const REGISTER = {
  ADDH:    0x00,
  ADDL:    0x01,
  NETID:   0x02,
  REG0:    0x03,
  REG1:    0x04,
  REG2:    0x05, // Channel
  REG3:    0x06,
  CRYPT_H: 0x07,
  CRYPT_L: 0x08,
  PID0:    0x80,
};

export const REQ = {
  GET_CONFIG:        [0x00, 0x09], // start address, length
  SET_CONFIG:        [0x00, 0x09],
  GET_PRODUCT_INFO:  [0x80, 0x07],
};

// REG0: UART baud (bits 7..5), parity (4..3), air rate (2..0)
export const UART_BAUD = {
  '1200':   0x00,
  '2400':   0x20,
  '4800':   0x40,
  '9600':   0x60,
  '19200':  0x80,
  '38400':  0xA0,
  '57600':  0xC0,
  '115200': 0xE0,
};
export const MASK_UART_BAUD = 0xE0;

export const UART_PARITY = {
  '8N1': 0x00,
  '8O1': 0x08,
  '8E1': 0x10,
};
export const MASK_UART_PARITY = 0x18;

export const AIR_BAUD = {
  '0.3k':  0x00,
  '1.2k':  0x01,
  '2.4k':  0x02,
  '4.8k':  0x03,
  '9.6k':  0x04,
  '19.2k': 0x05,
  '38.4k': 0x06,
  '62.5k': 0x07,
};
export const MASK_AIR_BAUD = 0x07;

// REG1: sub packet (7..6), ambient noise (5), reserved (4..2), power (1..0)
export const SUB_PACKET = {
  '240': 0x00,
  '128': 0x40,
  '64':  0x80,
  '32':  0xC0,
};
export const MASK_SUB_PACKET = 0xC0;
export const MASK_POWER = 0x03;

/** Same 2-bit REG1 power codes; label depends on module PA (RF Setting shows different dBm per variant). */
export const POWER_PROFILES = {
  pa30: {
    id: 'pa30',
    label: '30 / 27 / 24 / 21 dBm (+30 PA)',
    byCode: ['30', '27', '24', '21'],
  },
  pa22: {
    id: 'pa22',
    label: '22 / 17 / 13 / 10 dBm (varian RF Setting / PA lebih rendah)',
    byCode: ['22', '17', '13', '10'],
  },
};

export function getPowerProfile(profileId) {
  const id = profileId && POWER_PROFILES[profileId] ? profileId : 'pa30';
  return POWER_PROFILES[id];
}

function powerCodeFromLabel(powerLabel, profile) {
  const i = profile.byCode.indexOf(String(powerLabel));
  return (i >= 0 ? i : 0) & MASK_POWER;
}

function powerLabelFromCode(reg1, profile) {
  const code = reg1 & MASK_POWER;
  return profile.byCode[code] ?? profile.byCode[0];
}

export const MASK_AMBIENT_NOISE = 0x20; // RSSI ambient noise enable

// REG3: RSSI byte (7), tx mode (6), repeater (5), LBT (4), WOR mode (3), WOR cycle (2..0)
export const MASK_RSSI = 0x80;
export const MASK_TX_MODE = 0x40;
export const MASK_REPEATER = 0x20;
export const MASK_LBT = 0x10;
export const MASK_WOR_MODE = 0x08;
export const MASK_WOR_CYCLE = 0x07;

export const TX_MODE = {
  'Transparent': 0x00,
  'Fixed':       0x40,
};

export const WOR_MODE = {
  'Receiver':    0x00,
  'Transmitter': 0x08,
};

// WOR cycle: code -> ms => (code+1)*500
export const WOR_CYCLE_OPTIONS = [
  '500', '1000', '1500', '2000', '2500', '3000', '3500', '4000',
];

// Channel: REG2 byte. For E22-400T: 0..83 -> 410..493 MHz, for E22-900T: 0..80 -> 850..930 MHz
export const FREQUENCY_BANDS = {
  '400': { start: 410, end: 493, label: '410.125 MHz ~ 493.125 MHz (E22-400)' },
  '900': { start: 850, end: 930, label: '850.125 MHz ~ 930.125 MHz (E22-900)' },
  '230': { start: 220, end: 236, label: '220.125 MHz ~ 236.125 MHz (E22-230)' },
};

/**
 * Encode 9 raw config bytes from a configuration object.
 * cfg = {
 *   ADDH, ADDL, NETID,
 *   uartBaud, parity, airBaud,
 *   subPacket, ambientNoise, power,
 *   channel,
 *   rssiPacket, txMode, repeater, lbt, worMode, worCycle,
 *   cryptH, cryptL,
 * }
 */
export function encodeConfig(cfg, freqStart, powerProfile = getPowerProfile('pa30')) {
  const u8 = (n) => (n & 0xFF);
  const args = new Uint8Array(9);

  args[REGISTER.ADDH]  = u8(cfg.ADDH);
  args[REGISTER.ADDL]  = u8(cfg.ADDL);
  args[REGISTER.NETID] = u8(cfg.NETID);

  // REG0
  let reg0 = 0;
  reg0 |= UART_BAUD[cfg.uartBaud] ?? 0x60;
  reg0 |= UART_PARITY[cfg.parity] ?? 0x00;
  reg0 |= AIR_BAUD[cfg.airBaud] ?? 0x02;
  args[REGISTER.REG0] = reg0;

  // REG1
  let reg1 = 0;
  reg1 |= SUB_PACKET[cfg.subPacket] ?? 0x00;
  if (cfg.ambientNoise) reg1 |= MASK_AMBIENT_NOISE;
  reg1 |= powerCodeFromLabel(cfg.power, powerProfile);
  args[REGISTER.REG1] = reg1;

  // REG2 channel offset
  const chOffset = (cfg.channel | 0) - freqStart;
  args[REGISTER.REG2] = u8(Math.max(0, chOffset));

  // REG3
  let reg3 = 0;
  if (cfg.rssiPacket) reg3 |= MASK_RSSI;
  reg3 |= TX_MODE[cfg.txMode] ?? 0x00;
  if (cfg.repeater) reg3 |= MASK_REPEATER;
  if (cfg.lbt) reg3 |= MASK_LBT;
  reg3 |= WOR_MODE[cfg.worMode] ?? 0x00;
  const cycleIdx = WOR_CYCLE_OPTIONS.indexOf(String(cfg.worCycle));
  reg3 |= (cycleIdx >= 0 ? cycleIdx : 0) & MASK_WOR_CYCLE;
  args[REGISTER.REG3] = reg3;

  args[REGISTER.CRYPT_H] = u8(cfg.cryptH);
  args[REGISTER.CRYPT_L] = u8(cfg.cryptL);

  return args;
}

/**
 * Decode 9 raw config bytes into a configuration object.
 * Returns the inverse of encodeConfig().
 */
export function decodeConfig(args, freqStart, powerProfile = getPowerProfile('pa30')) {
  const lookup = (table, value) =>
    Object.entries(table).find(([, v]) => v === value)?.[0] ?? null;

  const reg0 = args[REGISTER.REG0];
  const reg1 = args[REGISTER.REG1];
  const reg3 = args[REGISTER.REG3];

  return {
    ADDH:         args[REGISTER.ADDH],
    ADDL:         args[REGISTER.ADDL],
    NETID:        args[REGISTER.NETID],
    uartBaud:     lookup(UART_BAUD, reg0 & MASK_UART_BAUD),
    parity:       lookup(UART_PARITY, reg0 & MASK_UART_PARITY),
    airBaud:      lookup(AIR_BAUD, reg0 & MASK_AIR_BAUD),
    subPacket:    lookup(SUB_PACKET, reg1 & MASK_SUB_PACKET),
    ambientNoise: (reg1 & MASK_AMBIENT_NOISE) !== 0,
    power:        powerLabelFromCode(reg1, powerProfile),
    channel:      args[REGISTER.REG2] + freqStart,
    rssiPacket:   (reg3 & MASK_RSSI) !== 0,
    txMode:       lookup(TX_MODE, reg3 & MASK_TX_MODE),
    repeater:     (reg3 & MASK_REPEATER) !== 0,
    lbt:          (reg3 & MASK_LBT) !== 0,
    worMode:      lookup(WOR_MODE, reg3 & MASK_WOR_MODE),
    worCycle:     WOR_CYCLE_OPTIONS[reg3 & MASK_WOR_CYCLE],
    cryptH:       args[REGISTER.CRYPT_H],
    cryptL:       args[REGISTER.CRYPT_L],
  };
}

/**
 * Build a serial frame:
 *   [command][startAddr][length][..payload]
 */
export function buildFrame(command, startAddr, length, payload = []) {
  const out = [command, startAddr, length, ...payload];
  return new Uint8Array(out);
}

/**
 * 12-byte wire sequence matching desktop “Parameter (Hex String)” for permanent write:
 * C0 | start 00 | length 09 | nine register bytes (ADDH…CRYPT_L).
 * Same payload the module stores; GET response uses header C1 instead.
 */
export function buildSetConfigFrame(nineRegisterBytes) {
  const p = nineRegisterBytes instanceof Uint8Array
    ? Array.from(nineRegisterBytes)
    : [...nineRegisterBytes];
  if (p.length !== 9) {
    throw new Error('buildSetConfigFrame: expected 9 register bytes');
  }
  return buildFrame(COMMAND.SET_REGISTER, REQ.SET_CONFIG[0], REQ.SET_CONFIG[1], p);
}

export function bytesToHex(bytes) {
  return Array.from(bytes, b => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');
}
