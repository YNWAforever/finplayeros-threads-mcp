import { Buffer } from 'node:buffer';

const segmenter = new Intl.Segmenter('zh-Hant-HK', { granularity: 'grapheme' });
const emojiCluster = /\p{Extended_Pictographic}|\p{Regional_Indicator}|\p{Emoji_Modifier}|\u20e3/u;

/** Emoji graphemes count as UTF-8 bytes; every other grapheme counts as one. */
export function countThreadsLength(text: string): number {
  let count = 0;
  for (const { segment } of segmenter.segment(text)) {
    count += emojiCluster.test(segment) ? Buffer.byteLength(segment, 'utf8') : 1;
  }
  return count;
}

export function validateThreadsText(text: string): void {
  const count = countThreadsLength(text);
  if (count > 500) {
    throw new Error(`Threads text length is ${count}; maximum is 500 (emoji count as UTF-8 bytes).`);
  }
}

export const DEFAULT_TIMEZONE = 'Asia/Hong_Kong';

/** Offset-free ISO wall times use Hong Kong's UTC+08:00, independent of the OS TZ. */
export function parsePublishAt(value: string, now: Date): string {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})?$/.exec(value);
  if (!match) {
    throw new Error('publish_at must be an ISO 8601 date-time, e.g. 2026-10-30T09:00:00+08:00.');
  }
  const [, date, hour, minute, second = '00', fraction = '', offset = '+08:00'] = match;
  const wallTime = `${date}T${hour}:${minute}:${second}.${fraction.padEnd(3, '0')}Z`;
  const wallMs = Date.parse(wallTime);
  // Date.parse normalizes some impossible calendar dates; reject those explicitly.
  if (!Number.isFinite(wallMs) || new Date(wallMs).toISOString() !== wallTime) {
    throw new Error('publish_at contains an invalid calendar date or time.');
  }
  const timestamp = Date.parse(`${date}T${hour}:${minute}:${second}.${fraction.padEnd(3, '0')}${offset}`);
  if (!Number.isFinite(timestamp)) {
    throw new Error('publish_at contains an invalid UTC offset.');
  }
  if (timestamp <= now.getTime()) {
    throw new Error('publish_at must be in the future; times in the past are rejected.');
  }
  return new Date(timestamp).toISOString();
}
