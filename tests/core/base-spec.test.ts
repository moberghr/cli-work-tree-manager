import { describe, it, expect } from 'vitest';
import {
  parseBaseSpec,
  baseForAlias,
  isEmptyBaseSpec,
  baseSpecOverrideAliases,
  toBaseSpec,
  BaseSpecError,
} from '../../src/core/base-spec.js';

describe('parseBaseSpec', () => {
  it('returns an empty spec for undefined', () => {
    const spec = parseBaseSpec(undefined);
    expect(isEmptyBaseSpec(spec)).toBe(true);
    expect(spec.default).toBeUndefined();
    expect(spec.perRepo).toEqual({});
  });

  it('parses a bare branch as the default', () => {
    const spec = parseBaseSpec('dev');
    expect(spec.default).toBe('dev');
    expect(spec.perRepo).toEqual({});
    expect(isEmptyBaseSpec(spec)).toBe(false);
  });

  it('parses alias=branch as a per-repo override', () => {
    const spec = parseBaseSpec(['backend=dev', 'frontend=feat/foo']);
    expect(spec.default).toBeUndefined();
    expect(spec.perRepo).toEqual({ backend: 'dev', frontend: 'feat/foo' });
  });

  it('mixes a bare default with per-repo overrides', () => {
    const spec = parseBaseSpec(['dev', 'frontend=feat/foo']);
    expect(spec.default).toBe('dev');
    expect(spec.perRepo).toEqual({ frontend: 'feat/foo' });
  });

  it('keeps everything after the first = as the branch (refs may contain =)', () => {
    const spec = parseBaseSpec('backend=release=2.0');
    expect(spec.perRepo).toEqual({ backend: 'release=2.0' });
  });

  it('trims surrounding whitespace', () => {
    const spec = parseBaseSpec(['  dev  ', ' frontend = feat/foo ']);
    expect(spec.default).toBe('dev');
    expect(spec.perRepo).toEqual({ frontend: 'feat/foo' });
  });

  it('ignores empty values', () => {
    const spec = parseBaseSpec(['', '   ']);
    expect(isEmptyBaseSpec(spec)).toBe(true);
  });

  it('accepts a repeated identical default', () => {
    const spec = parseBaseSpec(['dev', 'dev']);
    expect(spec.default).toBe('dev');
  });

  it('accepts a repeated identical per-repo override', () => {
    const spec = parseBaseSpec(['backend=dev', 'backend=dev']);
    expect(spec.perRepo).toEqual({ backend: 'dev' });
  });

  it('throws on conflicting default values', () => {
    expect(() => parseBaseSpec(['dev', 'main'])).toThrow(BaseSpecError);
  });

  it('throws on conflicting per-repo values', () => {
    expect(() => parseBaseSpec(['backend=dev', 'backend=main'])).toThrow(
      BaseSpecError,
    );
  });

  it('throws on an empty alias', () => {
    expect(() => parseBaseSpec('=dev')).toThrow(BaseSpecError);
  });

  it('throws on an empty branch', () => {
    expect(() => parseBaseSpec('backend=')).toThrow(BaseSpecError);
  });
});

describe('baseForAlias', () => {
  it('returns the override when present', () => {
    const spec = parseBaseSpec(['dev', 'frontend=feat/foo']);
    expect(baseForAlias(spec, 'frontend')).toBe('feat/foo');
  });

  it('falls back to the default when no override', () => {
    const spec = parseBaseSpec(['dev', 'frontend=feat/foo']);
    expect(baseForAlias(spec, 'backend')).toBe('dev');
  });

  it('returns undefined when neither override nor default applies', () => {
    const spec = parseBaseSpec('frontend=feat/foo');
    expect(baseForAlias(spec, 'backend')).toBeUndefined();
  });
});

describe('baseSpecOverrideAliases', () => {
  it('lists only the per-repo override keys', () => {
    const spec = parseBaseSpec(['dev', 'frontend=feat/foo', 'backend=main']);
    expect(baseSpecOverrideAliases(spec).sort()).toEqual(['backend', 'frontend']);
  });

  it('is empty when only a default is set', () => {
    expect(baseSpecOverrideAliases(parseBaseSpec('dev'))).toEqual([]);
  });
});

describe('toBaseSpec', () => {
  it('normalizes undefined to an empty spec', () => {
    expect(isEmptyBaseSpec(toBaseSpec(undefined))).toBe(true);
  });

  it('normalizes a string to a default spec', () => {
    const spec = toBaseSpec('dev');
    expect(spec.default).toBe('dev');
    expect(spec.perRepo).toEqual({});
  });

  it('passes through an existing BaseSpec unchanged', () => {
    const original = parseBaseSpec('backend=dev');
    expect(toBaseSpec(original)).toBe(original);
  });
});
