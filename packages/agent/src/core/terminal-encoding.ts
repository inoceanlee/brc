import iconv from 'iconv-lite';

export interface ShellEncodingInfo {
  consoleInput: string;
  consoleOutput: string;
  nativePipe: string;
  codePage: number;
}

export interface ShellProbeResult {
  state: 'pending' | 'complete';
  info?: ShellEncodingInfo;
  stdout?: Buffer;
  trailing?: Buffer;
}

export const SHELL_PROBE_TIMEOUT_MS = 5000;
export const SHELL_PROBE_OUTPUT_LIMIT_BYTES = 64 * 1024;

const WINDOWS_CODE_PAGES: Record<number, string> = {
  932: 'shift_jis',
  936: 'gbk',
  949: 'cp949',
  950: 'big5',
  65001: 'utf-8',
  1200: 'utf-16le',
  1201: 'utf-16be',
};

const ENCODING_CODE_PAGES: Record<string, number> = {
  'utf-8': 65001,
  'gbk': 936,
  'gb2312': 936,
  'gb18030': 54936,
  'shift_jis': 932,
  'shift-jis': 932,
  'cp949': 949,
  'big5': 950,
  'iso-8859-1': 28591,
  'euc-jp': 20932,
  'ascii': 20127,
  'us-ascii': 20127,
};

const POSIX_ENCODING_ALIASES: Record<string, string> = {
  'utf8': 'utf-8',
  'utf-8': 'utf-8',
  'gbk': 'gbk',
  'gb2312': 'gbk',
  'gb-2312': 'gbk',
  'euc-cn': 'gbk',
  'euccn': 'gbk',
  'gb18030': 'gb18030',
  'gb-18030': 'gb18030',
  'iso-8859-1': 'iso-8859-1',
  'iso8859-1': 'iso-8859-1',
  'iso88591': 'iso-8859-1',
  'latin1': 'iso-8859-1',
  'latin-1': 'iso-8859-1',
  'euc-jp': 'euc-jp',
  'eucjp': 'euc-jp',
  'ujis': 'euc-jp',
  'shift-jis': 'shift_jis',
  'shift_jis': 'shift_jis',
  'sjis': 'shift_jis',
  'cp932': 'shift_jis',
  'ms932': 'shift_jis',
  'cp936': 'gbk',
  'cp949': 'cp949',
  'cp950': 'big5',
  'big5': 'big5',
  'ansi_x3.4-1968': 'ascii',
  'us-ascii': 'ascii',
  'ascii': 'ascii',
};

export function normalizeEncoding(value: string): string {
  const cleaned = value.trim().toLowerCase();
  const alias = POSIX_ENCODING_ALIASES[cleaned] ?? POSIX_ENCODING_ALIASES[cleaned.replaceAll('_', '-')];
  if (alias) return alias;
  const normalized = cleaned.replaceAll('_', '-');
  const finalEnc = normalized === 'gb2312' || normalized === 'gb-2312' ? 'gbk' : normalized;
  if (!iconv.encodingExists(finalEnc)) throw new Error(`unsupported shell encoding: ${value}`);
  return finalEnc;
}

export function parsePosixLocaleReport(report: string): ShellEncodingInfo {
  const charmapMatch = /(?:^|[;\s])charmap\s*=\s*([^;\r\n]*)/i.exec(report);
  const langMatch = /(?:^|[;\s])lang\s*=\s*([^;\r\n]*)/i.exec(report);
  if (!charmapMatch && !langMatch) {
    throw new Error('invalid POSIX locale probe report: missing charmap and lang');
  }

  const rawCharmap = charmapMatch ? charmapMatch[1].trim() : '';
  const rawLang = langMatch ? langMatch[1].trim() : '';

  const m = /\.([^@\s]+)/.exec(rawLang);
  const langCodeset = m ? m[1].trim() : '';
  const isAscii = /^(?:ansi_x3\.4-1968|us-ascii|ascii)$/i.test(rawCharmap);

  let chosenEncoding: string;
  if (rawCharmap && !isAscii) {
    chosenEncoding = rawCharmap;
  } else if (isAscii && langCodeset) {
    chosenEncoding = langCodeset;
  } else if (rawCharmap) {
    chosenEncoding = rawCharmap;
  } else if (langCodeset) {
    chosenEncoding = langCodeset;
  } else {
    chosenEncoding = 'utf-8';
  }

  const encoding = normalizeEncoding(chosenEncoding);
  const codePage = ENCODING_CODE_PAGES[encoding] ?? 0;
  return {
    consoleInput: encoding,
    consoleOutput: encoding,
    nativePipe: encoding,
    codePage,
  };
}

export function parseShellEncodingInfo(shell: 'powershell' | 'cmd' | 'posix', report: string): ShellEncodingInfo {
  if (shell === 'posix') {
    return parsePosixLocaleReport(report);
  }
  let consoleInput: string;
  let consoleOutput: string;
  let nativePipe: string;
  let codePage: number;
  if (shell === 'cmd') {
    const match = /(?:^|[;\s])cp=\s*(\d+)(?:$|[;\s])/i.exec(report);
    if (!match) throw new Error('invalid CMD code page probe');
    codePage = Number(match[1]);
    const encoding = WINDOWS_CODE_PAGES[codePage] ?? `cp${codePage}`;
    if (!iconv.encodingExists(encoding)) throw new Error(`unsupported code page: ${codePage}`);
    consoleInput = encoding;
    consoleOutput = encoding;
    nativePipe = encoding;
  } else {
    const match = /^in=([^;]+);out=([^;]+);pipe=([^;]+);cp=(\d+)$/i.exec(report.trim());
    if (!match) throw new Error('invalid PowerShell encoding probe');
    consoleInput = normalizeEncoding(match[1]);
    consoleOutput = normalizeEncoding(match[2]);
    nativePipe = normalizeEncoding(match[3]);
    codePage = Number(match[4]);
    if (!Number.isSafeInteger(codePage) || codePage < 1) throw new Error(`unsupported code page: ${match[4]}`);
  }
  return { consoleInput, consoleOutput, nativePipe, codePage };
}

export function getPosixShellProbeCommand(marker: string, command: string): string {
  return `cm=$(locale charmap 2>/dev/null || echo ""); lang="\${LC_ALL:-\${LC_CTYPE:-\${LANG:-}}}"; printf '${marker}|charmap=%s;lang=%s\\n' "$cm" "$lang"; read -r _BRC_READY; ${command}`;
}

export const buildPosixShellProbeCommand = getPosixShellProbeCommand;

export function getShellProbeCommand(
  shell: 'powershell' | 'cmd' | 'posix',
  marker: string,
  command: string,
): string {
  if (shell === 'powershell') {
    return `$utf8=New-Object System.Text.UTF8Encoding($false);if([Console]::InputEncoding.CodePage -ne 65001){[Console]::InputEncoding=$utf8};if([Console]::OutputEncoding.CodePage -ne 65001){[Console]::OutputEncoding=$utf8};if($OutputEncoding.CodePage -ne 65001){$OutputEncoding=$utf8};$in=[Console]::InputEncoding.WebName;$out=[Console]::OutputEncoding.WebName;$pipe=$OutputEncoding.WebName;$cp=[Console]::OutputEncoding.CodePage;$report='${marker}|in='+$in+';out='+$out+';pipe='+$pipe+';cp='+$cp+[char]10;$bytes=[Text.Encoding]::ASCII.GetBytes($report);$stream=[Console]::OpenStandardOutput();$stream.Write($bytes,0,$bytes.Length);$stream.Flush();if([Console]::In.ReadLine() -ne 'Y'){exit 125};${command}`;
  }
  if (shell === 'cmd') {
    return `for /f "tokens=2 delims=:" %A in ('chcp') do @echo ${marker}^|cp=%A & set /p "_BRC_READY=" && ${command}`;
  }
  return getPosixShellProbeCommand(marker, command);
}

export class ShellEncodingProbe {
  private buffered = Buffer.alloc(0);
  private complete = false;

  constructor(
    private readonly marker: string,
    private readonly maxBytes = SHELL_PROBE_OUTPUT_LIMIT_BYTES,
    private readonly shell: 'powershell' | 'cmd' | 'posix' = 'powershell',
  ) {
    if (!/^[A-Za-z0-9_]+$/.test(marker)) throw new Error('probe marker must contain ASCII letters, digits, or underscores');
  }

  get bufferedByteLength(): number {
    return this.buffered.length;
  }

  push(chunk: Buffer): ShellProbeResult {
    if (this.complete) throw new Error('encoding probe already completed');
    this.buffered = Buffer.concat([this.buffered, chunk]);
    if (this.buffered.length > this.maxBytes) throw new Error('shell encoding probe output exceeded limit');
    const token = Buffer.from(`${this.marker}|`, 'ascii');
    const index = this.buffered.indexOf(token);
    if (index < 0) return { state: 'pending' };
    const lineEnd = this.buffered.indexOf(0x0a, index + token.length);
    if (lineEnd < 0) return { state: 'pending' };
    const report = this.buffered.subarray(index + token.length, lineEnd).toString('ascii').replace(/\r$/, '');
    const info = this.shell === 'posix'
      ? parsePosixLocaleReport(report)
      : parseShellEncodingInfo(this.shell, report);
    this.complete = true;
    return {
      state: 'complete',
      info,
      stdout: this.buffered.subarray(0, index),
      trailing: this.buffered.subarray(lineEnd + 1),
    };
  }
}

export function createShellEncodingDecoder(encoding: string): { write(chunk: Buffer): string; end(chunk?: Buffer): string } {
  const decoder = iconv.getDecoder(normalizeEncoding(encoding));
  return {
    write: (chunk) => decoder.write(chunk),
    end: (chunk) => `${chunk ? decoder.write(chunk) : ''}${decoder.end() ?? ''}`,
  };
}

export function encodeShellInput(text: string, encoding: string): Buffer {
  return iconv.encode(text, normalizeEncoding(encoding));
}
