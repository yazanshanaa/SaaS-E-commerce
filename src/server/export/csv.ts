/**
 * CSV for Arabic data, which is a narrower problem than it looks.
 *
 * Two things break real merchants opening a real file in Excel:
 *   1. no UTF-8 BOM — Excel guesses the system codepage and renders Arabic as mojibake. The
 *      merchant concludes their data is corrupt, on the day their site went dark.
 *   2. CRLF — Excel on Windows is the overwhelmingly likely destination.
 *
 * A field starting with `=`, `+`, `-` or `@` is also prefixed with a single quote: a product
 * name is merchant-supplied text, and CSV injection into a spreadsheet formula is a real
 * export vulnerability, not a theoretical one.
 */

export const UTF8_BOM = '﻿';

const FORMULA_PREFIXES = ['=', '+', '-', '@', '\t', '\r'];

function escapeField(value: unknown): string {
  if (value === null || value === undefined) return '';

  let text = String(value);

  if (FORMULA_PREFIXES.some((prefix) => text.startsWith(prefix))) {
    text = `'${text}`;
  }

  if (/[",\r\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }

  return text;
}

export function toCsv(headers: string[], rows: Array<Array<unknown>>): string {
  const lines = [headers.map(escapeField).join(','), ...rows.map((row) => row.map(escapeField).join(','))];
  return `${UTF8_BOM}${lines.join('\r\n')}\r\n`;
}

/** Agorot -> a plain decimal string. Never a locale-formatted number in a machine file. */
export function agorotToDecimal(agorot: number): string {
  const sign = agorot < 0 ? '-' : '';
  const abs = Math.abs(agorot);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}
