import {
  REGISTRY_MODS_ROOT,
  RegistryKeyPathSchema,
  parseRegistrySnapshot,
  type RegistryKey,
  type RegistrySnapshot,
  type RegistryValue,
} from '@shared/domain';
import { ValidationError } from '@shared/errors';

const REG_HEADER = 'Windows Registry Editor Version 5.00';
const LEGACY_REG_HEADER = 'REGEDIT4';
const MAX_REG_FILE_BYTES = 16 * 1024 * 1024;
const MAX_SECTION_COUNT = 10_000;
const MAX_VALUE_COUNT = 100_000;

export interface ParseRegOptions {
  readonly capturedAt?: string;
}

interface LogicalLine {
  readonly text: string;
  readonly lineNumber: number;
}

function fail(message: string): never {
  throw new ValidationError(message);
}

function decodeUtf8(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    fail('The .reg file is not valid UTF-8 or ASCII.');
  }
}

function decodeUtf16Le(bytes: Uint8Array): string {
  if (bytes.length % 2 !== 0) fail('The UTF-16LE .reg file has an odd number of bytes.');

  try {
    return new TextDecoder('utf-16le', { fatal: true }).decode(bytes);
  } catch {
    fail('The .reg file is not valid UTF-16LE.');
  }
}

function looksLikeUtf16LeWithoutBom(bytes: Uint8Array): boolean {
  if (bytes.length < 2 || bytes.length % 2 !== 0) return false;

  const sampleLength = Math.min(bytes.length, 512);
  let evenNuls = 0;
  let oddNuls = 0;
  for (let index = 0; index < sampleLength; index += 1) {
    if (bytes[index] !== 0) continue;
    if (index % 2 === 0) evenNuls += 1;
    else oddNuls += 1;
  }

  return oddNuls > sampleLength / 8 && oddNuls > evenNuls * 2;
}

function decodeRegBytes(bytes: Uint8Array): string {
  if (bytes.length === 0) fail('The .reg file is empty.');
  if (bytes.length > MAX_REG_FILE_BYTES) fail('The .reg file is too large.');

  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    return decodeUtf16Le(bytes.subarray(2));
  }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    const swapped = new Uint8Array(bytes.length - 2);
    for (let index = 2; index < bytes.length; index += 2) {
      if (index + 1 >= bytes.length) fail('The UTF-16BE .reg file has an odd number of bytes.');
      swapped[index - 2] = bytes[index + 1] ?? 0;
      swapped[index - 1] = bytes[index] ?? 0;
    }
    return decodeUtf16Le(swapped);
  }
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return decodeUtf8(bytes.subarray(3));
  }
  if (looksLikeUtf16LeWithoutBom(bytes)) {
    return decodeUtf16Le(bytes);
  }

  return decodeUtf8(bytes);
}

function normalizeNewlines(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function toLogicalLines(text: string): LogicalLine[] {
  const rawLines = normalizeNewlines(text).split('\n');
  const logicalLines: LogicalLine[] = [];

  for (let index = 0; index < rawLines.length; index += 1) {
    let line = rawLines[index] ?? '';
    const lineNumber = index + 1;
    const trimmed = line.trim();

    if (trimmed.length === 0 || trimmed.startsWith(';')) {
      logicalLines.push({ text: line, lineNumber });
      continue;
    }

    while (line.trimEnd().endsWith('\\') && index + 1 < rawLines.length) {
      line = line.trimEnd().slice(0, -1) + (rawLines[index + 1] ?? '').trimStart();
      index += 1;
    }

    logicalLines.push({ text: line, lineNumber });
  }

  return logicalLines;
}

const HIVE_ALIASES: ReadonlyArray<readonly [long: string, short: string]> = [
  ['HKEY_LOCAL_MACHINE', 'HKLM'],
  ['HKEY_CURRENT_USER', 'HKCU'],
  ['HKEY_USERS', 'HKU'],
  ['HKEY_CLASSES_ROOT', 'HKCR'],
  ['HKEY_CURRENT_CONFIG', 'HKCC'],
];

function normalizeRegistryPath(rawPath: string): string {
  const path = rawPath.trim();
  for (const [longName, shortName] of HIVE_ALIASES) {
    if (path.toLowerCase() === longName.toLowerCase()) return shortName;
    if (path.toLowerCase().startsWith(`${longName.toLowerCase()}\\`)) {
      return `${shortName}${path.slice(longName.length)}`;
    }
  }

  if (path.toLowerCase() === REGISTRY_MODS_ROOT.toLowerCase()) return REGISTRY_MODS_ROOT;
  if (path.toLowerCase().startsWith(`${REGISTRY_MODS_ROOT.toLowerCase()}\\`)) {
    return `${REGISTRY_MODS_ROOT}${path.slice(REGISTRY_MODS_ROOT.length)}`;
  }

  return path;
}

function parseQuotedString(text: string, start: number): { value: string; next: number } {
  if (text[start] !== '"') fail('Expected a quoted registry string.');
  let value = '';

  for (let index = start + 1; index < text.length; index += 1) {
    const character = text[index];
    if (character === '"') return { value, next: index + 1 };
    if (character !== '\\') {
      value += character;
      continue;
    }

    const escaped = text[index + 1];
    if (escaped !== '\\' && escaped !== '"') {
      fail('Only \\\\ and \\" escapes are supported in registry strings.');
    }
    value += escaped;
    index += 1;
  }

  return fail('Unterminated quoted registry string.');
}

function parseHexBytes(data: string): Uint8Array {
  const compact = data.replace(/\s+/g, '');
  if (compact.length === 0) return new Uint8Array();

  const parts = compact.split(',');
  const bytes = new Uint8Array(parts.length);
  for (const [index, part] of parts.entries()) {
    if (!/^[0-9a-f]{2}$/i.test(part)) {
      fail('Registry hex data must contain comma-separated two-digit bytes.');
    }
    bytes[index] = Number.parseInt(part, 16);
  }

  return bytes;
}

function decodeUtf16LeValue(bytes: Uint8Array): string {
  if (bytes.length % 2 !== 0) fail('UTF-16LE registry data has an odd number of bytes.');
  try {
    return new TextDecoder('utf-16le', { fatal: true }).decode(bytes);
  } catch {
    fail('Registry data is not valid UTF-16LE.');
  }
}

function parseExpandString(bytes: Uint8Array): string {
  const decoded = decodeUtf16LeValue(bytes);
  return decoded.endsWith('\0') ? decoded.slice(0, -1) : decoded;
}

function parseMultiString(bytes: Uint8Array): string[] {
  const decoded = decodeUtf16LeValue(bytes);
  if (decoded.length === 0) return [];

  const parts = decoded.split('\0');
  while (parts.at(-1) === '') parts.pop();
  return parts;
}

function bytesToQword(bytes: Uint8Array): string {
  if (bytes.length !== 8) fail('A QWORD registry value must contain exactly eight bytes.');

  let value = 0n;
  for (let index = 7; index >= 0; index -= 1) {
    value = (value << 8n) | BigInt(bytes[index] ?? 0);
  }
  return value.toString();
}

function bytesToDword(bytes: Uint8Array): number {
  if (bytes.length !== 4) fail('A DWORD registry value must contain exactly four bytes.');
  return (
    ((bytes[0] ?? 0) |
      ((bytes[1] ?? 0) << 8) |
      ((bytes[2] ?? 0) << 16) |
      ((bytes[3] ?? 0) << 24)) >>>
    0
  );
}

function parseRegValueData(data: string): RegistryValue {
  const trimmed = data.trim();

  if (trimmed.startsWith('"')) {
    const parsed = parseQuotedString(trimmed, 0);
    if (trimmed.slice(parsed.next).trim().length > 0) {
      fail('Unexpected characters after a registry string value.');
    }
    return { type: 'string', value: parsed.value };
  }

  const dwordMatch = /^dword:([0-9a-f]{8})$/i.exec(trimmed);
  if (dwordMatch !== null) {
    return { type: 'dword', value: Number.parseInt(dwordMatch[1] ?? '', 16) };
  }

  const hexTypedMatch = /^hex\(([0-9a-f]+)\):(.*)$/i.exec(trimmed);
  if (hexTypedMatch !== null) {
    const type = (hexTypedMatch[1] ?? '').toLowerCase();
    const bytes = parseHexBytes(hexTypedMatch[2] ?? '');

    if (type === '0') {
      if (bytes.length !== 0) fail('A REG_NONE value cannot contain data.');
      return { type: 'none', value: null };
    }
    if (type === '2') return { type: 'expandString', value: parseExpandString(bytes) };
    if (type === '4') return { type: 'dword', value: bytesToDword(bytes) };
    if (type === '7') return { type: 'multiString', value: parseMultiString(bytes) };
    if (type === 'b') return { type: 'qword', value: bytesToQword(bytes) };

    return fail(`Unsupported registry hex type hex(${type}).`);
  }

  if (/^hex:/i.test(trimmed)) {
    const bytes = parseHexBytes(trimmed.slice(4));
    return {
      type: 'binary',
      value: Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join(''),
    };
  }

  return fail('Unsupported registry value data.');
}

function parseRegValueLine(line: LogicalLine): { name: string; value: RegistryValue } {
  const text = line.text.trim();
  let name = '';
  let position = 0;

  if (text.startsWith('@')) {
    position = 1;
  } else if (text.startsWith('"')) {
    const parsed = parseQuotedString(text, 0);
    name = parsed.value;
    position = parsed.next;
  } else {
    fail(`Unsupported registry value syntax on line ${line.lineNumber}.`);
  }

  while (text[position] === ' ' || text[position] === '\t') position += 1;
  if (text[position] !== '=') fail(`Expected "=" on line ${line.lineNumber}.`);

  const data = text.slice(position + 1).trim();
  if (data === '-') {
    fail(`Registry value deletion directives are not supported (line ${line.lineNumber}).`);
  }

  return { name, value: parseRegValueData(data) };
}

export function parseRegFile(
  input: string | Uint8Array,
  options: ParseRegOptions = {},
): RegistrySnapshot {
  const decoded = typeof input === 'string' ? input.replace(/^\uFEFF/, '') : decodeRegBytes(input);
  const lines = toLogicalLines(decoded);

  let headerIndex = -1;
  for (const [index, line] of lines.entries()) {
    const trimmed = line.text.trim();
    if (trimmed.length === 0 || trimmed.startsWith(';')) continue;
    headerIndex = index;
    break;
  }

  if (headerIndex === -1) fail('The .reg file is empty.');
  const header = lines[headerIndex]?.text.trim() ?? '';
  if (header !== REG_HEADER && header !== LEGACY_REG_HEADER) {
    fail(`Unsupported .reg header "${header}".`);
  }

  const keys: RegistryKey[] = [];
  const keyPaths = new Set<string>();
  let currentKey: RegistryKey | null = null;
  let valueCount = 0;

  for (const line of lines.slice(headerIndex + 1)) {
    const trimmed = line.text.trim();
    if (trimmed.length === 0 || trimmed.startsWith(';')) continue;

    if (trimmed.startsWith('[')) {
      if (!trimmed.endsWith(']')) fail(`Malformed section header on line ${line.lineNumber}.`);
      const rawPath = trimmed.slice(1, -1);
      if (rawPath.startsWith('-')) {
        fail(`Registry key deletion directives are not supported (line ${line.lineNumber}).`);
      }

      const path = normalizeRegistryPath(rawPath);
      if (!RegistryKeyPathSchema.safeParse(path).success) {
        fail(`Registry key "${path}" is outside the Windhawk mods subtree.`);
      }

      const normalizedPath = path.toLowerCase();
      if (keyPaths.has(normalizedPath)) {
        fail(`Duplicate registry key "${path}" on line ${line.lineNumber}.`);
      }
      if (keys.length >= MAX_SECTION_COUNT) fail('The .reg file contains too many sections.');

      currentKey = { path, values: [] };
      keys.push(currentKey);
      keyPaths.add(normalizedPath);
      continue;
    }

    if (currentKey === null) {
      fail(`Registry value found before a section header on line ${line.lineNumber}.`);
    }

    const parsed = parseRegValueLine(line);
    const normalizedName = parsed.name.toLowerCase();
    if (currentKey.values.some((entry) => entry.name.toLowerCase() === normalizedName)) {
      fail(`Duplicate registry value "${parsed.name}" on line ${line.lineNumber}.`);
    }
    if (valueCount >= MAX_VALUE_COUNT) fail('The .reg file contains too many values.');

    currentKey.values.push(parsed);
    valueCount += 1;
  }

  const snapshot: RegistrySnapshot = {
    schemaVersion: 1,
    capturedAt: options.capturedAt ?? new Date().toISOString(),
    registryView: '64-bit',
    keys,
  };

  return parseRegistrySnapshot(snapshot);
}

function escapeRegString(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function canonicalRegistryPath(path: string): string {
  const normalized = path.toLowerCase();
  const root = REGISTRY_MODS_ROOT.toLowerCase();
  if (normalized === root) return REGISTRY_MODS_ROOT;
  if (normalized.startsWith(`${root}\\`)) {
    return `${REGISTRY_MODS_ROOT}${path.slice(REGISTRY_MODS_ROOT.length)}`;
  }
  return path;
}

function encodeUtf16Le(value: string): Uint8Array {
  const bytes = new Uint8Array(value.length * 2);
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    bytes[index * 2] = codeUnit & 0xff;
    bytes[index * 2 + 1] = codeUnit >> 8;
  }
  return bytes;
}

function formatHexBytes(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join(',');
}

function formatValueData(value: RegistryValue): string {
  switch (value.type) {
    case 'string':
      return `"${escapeRegString(value.value)}"`;
    case 'dword':
      return `dword:${value.value.toString(16).padStart(8, '0')}`;
    case 'qword': {
      let remaining = BigInt(value.value);
      const bytes = new Uint8Array(8);
      for (let index = 0; index < 8; index += 1) {
        bytes[index] = Number(remaining & 0xffn);
        remaining >>= 8n;
      }
      return `hex(b):${formatHexBytes(bytes)}`;
    }
    case 'expandString':
      return `hex(2):${formatHexBytes(encodeUtf16Le(`${value.value}\0`))}`;
    case 'multiString': {
      const bytes = new Uint8Array(
        value.value.reduce((total, entry) => total + (entry.length + 1) * 2, 2),
      );
      let offset = 0;
      for (const entry of value.value) {
        bytes.set(encodeUtf16Le(`${entry}\0`), offset);
        offset += (entry.length + 1) * 2;
      }
      bytes[offset] = 0;
      bytes[offset + 1] = 0;
      return `hex(7):${formatHexBytes(bytes)}`;
    }
    case 'binary': {
      const bytes = new Uint8Array(value.value.length / 2);
      for (let index = 0; index < bytes.length; index += 1) {
        bytes[index] = Number.parseInt(value.value.slice(index * 2, index * 2 + 2), 16);
      }
      return `hex:${formatHexBytes(bytes)}`;
    }
    case 'none':
      return 'hex(0):';
  }
}

function formatValueName(name: string): string {
  return name.length === 0 ? '@' : `"${escapeRegString(name)}"`;
}

function comparePaths(left: string, right: string): number {
  const a = left.toLowerCase();
  const b = right.toLowerCase();
  return a < b ? -1 : a > b ? 1 : 0;
}

function encodeRegText(text: string): Uint8Array {
  const encoded = encodeUtf16Le(text);
  const withBom = new Uint8Array(encoded.length + 2);
  withBom[0] = 0xff;
  withBom[1] = 0xfe;
  withBom.set(encoded, 2);
  return withBom;
}

export function serializeRegFile(snapshot: RegistrySnapshot): Uint8Array {
  const validated = parseRegistrySnapshot(snapshot);
  const lines: string[] = [REG_HEADER, ''];

  const keys = [...validated.keys]
    .map((key) => ({ ...key, path: canonicalRegistryPath(key.path) }))
    .sort((left, right) => comparePaths(left.path, right.path));
  for (const key of keys) {
    lines.push(`[${key.path}]`);
    const values = [...key.values].sort((left, right) => {
      const a = left.name.toLowerCase();
      const b = right.name.toLowerCase();
      return a < b ? -1 : a > b ? 1 : 0;
    });
    for (const entry of values) {
      lines.push(`${formatValueName(entry.name)}=${formatValueData(entry.value)}`);
    }
    lines.push('');
  }

  return encodeRegText(lines.join('\r\n'));
}
