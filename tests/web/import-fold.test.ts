import { describe, expect, it } from 'vitest';
import { leadingImports } from '../../src/web/src/state/import-fold.js';

describe('the import lines a new file starts with', () => {
  it('C#: the using block (blank lines inside it fold too, not the blank after it)', () => {
    const lines = ['using MediatR;', 'using Microsoft.EntityFrameworkCore;', '', 'using Payfac.Core.Data;', '', 'namespace X;'];
    expect(leadingImports(lines)).toEqual({ first: 0, last: 3, count: 3 });
  });

  it('after a header comment; global, static and alias usings count', () => {
    const lines = [
      '// Copyright',
      '/* licence */',
      'global using System;',
      'using static System.Math;',
      'using Json = System.Text.Json;',
      'class A {}',
    ];
    expect(leadingImports(lines)).toEqual({ first: 2, last: 4, count: 3 });
  });

  it('TS / JS: imports over several lines are one statement; require too', () => {
    const lines = ['import { a,', '  b,', "} from './a.js';", "import c from 'c';", "const d = require('d');", '', 'export const x = 1;'];
    expect(leadingImports(lines)).toEqual({ first: 0, last: 4, count: 3 });
  });

  it('Go, Java, Python, C', () => {
    expect(leadingImports(['package main', '', 'import (', '  "fmt"', '  "os"', ')', 'import "x"', 'func main() {}'])).toEqual({
      first: 0,
      last: 6,
      count: 3,
    });
    expect(leadingImports(['package a.b;', 'import java.util.List;', 'import java.util.Map;', 'class A {}'])).toEqual({
      first: 0,
      last: 2,
      count: 3,
    });
    expect(leadingImports(['import os', 'from a import b', 'import sys', 'x = 1'])).toEqual({ first: 0, last: 2, count: 3 });
    expect(leadingImports(['#include <stdio.h>', '#include "a.h"', '# include "b.h"', 'int main() {}'])).toEqual({
      first: 0,
      last: 2,
      count: 3,
    });
  });

  it('nothing to fold: too few imports, code first, a statement that never ends, or no file at all', () => {
    expect(leadingImports(['using A;', 'using B;', 'class C {}'])).toBeNull();
    expect(leadingImports(['class C {}', 'using A;', 'using B;', 'using D;'])).toBeNull();
    expect(leadingImports(['using (var x = Open())', '{', '}'])).toBeNull();
    expect(leadingImports(['import { a,', '  b,'])).toBeNull();
    expect(leadingImports([])).toBeNull();
  });
});
