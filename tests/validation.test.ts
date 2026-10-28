import { describe, expect, it } from 'vitest';
import { countThreadsLength, parsePublishAt, validateThreadsText } from '../src/core/validation.js';

describe('countThreadsLength', () => {
  it.each([
    ['', 0],
    ['今日個市好波動，大家點睇？', 13],
    ['😀', 4],
    ['你好😀', 6],
    ['🇭🇰', 8],
    ['1️⃣', 7],
    ['👍🏽', 8],
    ['👨‍👩‍👧‍👦', 25],
    ['❤️', 6],
    ['e\u0301', 1],
    ['123#*', 5],
    ['😀'.repeat(125), 500],
    ['😀'.repeat(126), 504],
  ])('counts %j as %i', (text, count) => {
    expect(countThreadsLength(text)).toBe(count);
  });

  it('accepts the boundary and reports the actual weighted count when exceeded', () => {
    expect(() => validateThreadsText('廣'.repeat(500))).not.toThrow();
    expect(() => validateThreadsText('😀'.repeat(125))).not.toThrow();
    expect(() => validateThreadsText('😀'.repeat(126))).toThrow(/504.*500/);
  });
});

describe('parsePublishAt', () => {
  const now = new Date('2026-10-29T00:00:00.000Z');

  it.each([
    ['2026-10-30T09:00', '2026-10-30T01:00:00.000Z'],
    ['2026-10-30T09:00:01.25', '2026-10-30T01:00:01.250Z'],
    ['2026-10-30T09:00:00+08:00', '2026-10-30T01:00:00.000Z'],
    ['2026-10-30T09:00:00-04:00', '2026-10-30T13:00:00.000Z'],
    ['2026-10-30T09:00:00Z', '2026-10-30T09:00:00.000Z'],
  ])('normalizes %s to %s', (input, expected) => {
    expect(parsePublishAt(input, now)).toBe(expected);
  });

  it.each([
    '2026-10-28T09:00:00',
    '2026-10-29T00:00:00Z',
    '2026-02-30T10:00:00',
    '2026-10-30T24:00:00',
    '2026-10-30T09:00:00+25:00',
    '2026-10-30',
    'tomorrow morning',
  ])('rejects past or invalid time %s', (input) => {
    expect(() => parsePublishAt(input, now)).toThrow(/publish_at/);
  });
});
