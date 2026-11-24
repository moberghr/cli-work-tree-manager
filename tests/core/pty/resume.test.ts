import { describe, it, expect } from 'vitest';
import { RESUME_PARAM, StreamPosition, isStreamId, resumeFromParams, withResume } from '../../../src/core/pty/resume.js';

const point = { stream: 'abcdef0123456789', offset: 1234, cols: 120, rows: 32 };
const parse = (url: string) => resumeFromParams(new URL(url, 'http://h').searchParams);

describe('the resume parameter', () => {
  it('round-trips, alone or after other parameters', () => {
    expect(withResume('/attach/s1', point)).toBe(`/attach/s1?${RESUME_PARAM}=abcdef0123456789-1234-120x32`);
    expect(parse(withResume('/attach/s1', point))).toEqual(point);
    expect(parse(withResume('/attach/s1?flow=1&cols=120&rows=32', point))).toEqual(point);
  });

  it('none stated: the url as it was', () => {
    expect(withResume('/attach/s1?flow=1', null)).toBe('/attach/s1?flow=1');
    expect(withResume('/attach/s1', undefined)).toBe('/attach/s1');
    expect(parse('/attach/s1')).toBeNull();
  });

  it('anything malformed is no position (a screen)', () => {
    for (const bad of [
      'ABCDEF0123456789-1-80x24', // not ours: hex is lower case
      'abc-1-80x24', // too short a stream
      'abcdef0123456789--1-80x24',
      'abcdef0123456789-1.5-80x24',
      'abcdef0123456789-1-0x24', // no grid
      'abcdef0123456789-1-80x24x',
      'abcdef0123456789-9999999999999999-80x24', // past a safe integer's digits
      'abcdef0123456789-1-80x24&x',
    ]) {
      expect(resumeFromParams(new URLSearchParams({ [RESUME_PARAM]: bad })), bad).toBeNull();
    }
  });

  it('isStreamId takes what the host makes', () => {
    expect(isStreamId('abcdef0123456789')).toBe(true);
    expect(isStreamId('xyz')).toBe(false);
    expect(isStreamId(42)).toBe(false);
  });
});

describe('StreamPosition', () => {
  it('a screen sets it, each frame moves it on', () => {
    const p = new StreamPosition();
    p.replay({ stream: 'abcdef0123456789', offset: 100 });
    p.output(5);
    p.output(7);
    expect(p.point(80, 24)).toEqual({ stream: 'abcdef0123456789', offset: 112, cols: 80, rows: 24 });
  });

  it('what it missed sets it as a screen does (its offset is where the live output starts)', () => {
    const p = new StreamPosition();
    p.replay({ stream: 'abcdef0123456789', offset: 100 });
    p.output(5);
    p.replay({ stream: 'abcdef0123456789', offset: 140, resumed: true });
    expect(p.point(80, 24)?.offset).toBe(140);
  });

  it('a host that says nothing of it (an older host): unknown, and stays so whatever output follows', () => {
    const p = new StreamPosition();
    p.replay({});
    p.output(10);
    expect(p.point(80, 24)).toBeNull();
    p.replay({ stream: 'abcdef0123456789', offset: -1 });
    expect(p.point(80, 24)).toBeNull();
  });

  it('no valid grid, or forgotten: unknown', () => {
    const p = new StreamPosition();
    p.replay({ stream: 'abcdef0123456789', offset: 0 });
    expect(p.point(0, 24)).toBeNull();
    p.forget();
    expect(p.point(80, 24)).toBeNull();
  });
});
