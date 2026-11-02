import { describe, expect, it } from 'vitest';
import {
  matchTestsToCode,
  subjectOf,
  testBreakdown,
  testLevel,
  testsInFile,
  type DiffFileLines,
  type DiffLine,
} from '../../../src/core/review/test-breakdown.js';

/** A one-hunk file from lines written as a diff: `+` added, `-` deleted, ` ` context. */
function diffFile(path: string, text: string, status = 'modified'): DiffFileLines {
  const lines: DiffLine[] = text
    .split('\n')
    .filter((l) => l.length)
    .map((l) => ({ kind: l[0] === '+' ? 'add' : l[0] === '-' ? 'delete' : 'context', content: l.slice(1) }));
  return { path, status, hunks: [{ lines }] };
}

const pick = (f: DiffFileLines) => testsInFile(f).map((t) => [t.name, t.change, t.framework, t.cases ?? null]);

describe('testsInFile: per framework', () => {
  it('xUnit: Fact and Theory, InlineData rows counted, Skip, removed, and a context test with changed lines', () => {
    const f = diffFile(
      'tests/Orders.Tests/RefundTests.cs',
      `
+    [Fact]
+    public async Task Refunds_the_full_amount()
+    {
+    }
+    [Theory]
+    [InlineData(1)]
+    [InlineData(2)]
+    [InlineData(3)]
+    public void Partial_refunds(int n)
-    [Fact]
-    public void Old_refund_rule()
     [Fact(Skip = "flaky")]
     public void Was_already_skipped()
     {
-        Assert.True(false);
+        Assert.True(true);
     }
-    [Fact]
+    [Fact(Skip = "waits on the payments mock")]
     public void Newly_skipped()
`,
    );
    expect(pick(f)).toEqual([
      ['Refunds_the_full_amount', 'added', 'xunit', null],
      ['Partial_refunds', 'added', 'xunit', 3],
      ['Old_refund_rule', 'removed', 'xunit', null],
      ['Was_already_skipped', 'changed', 'xunit', null],
      ['Newly_skipped', 'skipped', 'xunit', null],
    ]);
  });

  it('NUnit and MSTest: their attributes, TestCase / DataRow rows, Ignore', () => {
    const nunit = diffFile(
      'tests/Billing.Tests/InvoiceTests.cs',
      `
+    [Test]
+    public void Totals_add_up()
+    [TestCase(1)]
+    [TestCase(2)]
+    public void Rounds(int n)
+    [Test, Ignore("later")]
+    public void Later()
`,
    );
    expect(pick(nunit)).toEqual([
      ['Totals_add_up', 'added', 'nunit', null],
      ['Rounds', 'added', 'nunit', 2],
      ['Later', 'skipped', 'nunit', null],
    ]);
    const mstest = diffFile(
      'tests/X.Tests/T.cs',
      `
+    [TestMethod]
+    [DataRow(1)]
+    [DataRow(2)]
+    public void Works(int n)
`,
    );
    expect(pick(mstest)).toEqual([['Works', 'added', 'mstest', 2]]);
  });

  it('Jest / Vitest: it and test, .each (parameterised, rows not counted), .skip and xit, removed, a changed body', () => {
    const f = diffFile(
      'src/orders/refund.test.ts',
      `
+  it('refunds the full amount', () => {
+  test.each([[1], [2]])('partial refund %i', (n) => {
+  it.skip('waits on the mock', () => {
+  xit('later', () => {
-  it('the old rule', () => {
   it('rounds to cents', () => {
-    expect(round(1.005)).toBe(1);
+    expect(round(1.005)).toBe(1.01);
`,
    );
    expect(pick(f)).toEqual([
      ['refunds the full amount', 'added', 'jest', null],
      ['partial refund %i', 'added', 'jest', null],
      ['waits on the mock', 'skipped', 'jest', null],
      ['later', 'skipped', 'jest', null],
      ['the old rule', 'removed', 'jest', null],
      ['rounds to cents', 'changed', 'jest', null],
    ]);
  });

  it('pytest: def test_, parametrize, skip', () => {
    const f = diffFile(
      'tests/test_refunds.py',
      `
+def test_full_refund():
+@pytest.mark.parametrize("n", [1, 2])
+def test_partial(n):
+@pytest.mark.skip(reason="later")
+def test_later():
-def test_old():
`,
    );
    expect(pick(f)).toEqual([
      ['test_full_refund', 'added', 'pytest', null],
      ['test_partial', 'added', 'pytest', null],
      ['test_later', 'skipped', 'pytest', null],
      ['test_old', 'removed', 'pytest', null],
    ]);
  });

  it('a renamed declaration (removed and added under one name) reads as one change; untouched tests are left out', () => {
    const f = diffFile(
      'src/a.test.ts',
      `
-  it('same name', () => {
+  it('same name', async () => {
   it('untouched', () => {
     expect(1).toBe(1);
`,
    );
    expect(pick(f)).toEqual([['same name', 'changed', 'jest', null]]);
  });
});

describe('the level a test runs at', () => {
  it('end-to-end by path, integration by path or by what it uses, else unit', () => {
    expect(testLevel('e2e/checkout.spec.ts', '')).toBe('e2e');
    expect(testLevel('tests/Orders.IntegrationTests/RefundTests.cs', '')).toBe('integration');
    expect(testLevel('tests/Orders.Tests/RefundTests.cs', 'var app = new WebApplicationFactory<Program>();')).toBe('integration');
    expect(testLevel('tests/Orders.Tests/RefundTests.cs', 'await using var pg = new PostgreSqlBuilder().Build(); // Testcontainers')).toBe(
      'integration',
    );
    expect(testLevel('src/orders/refund.test.ts', 'expect(1)')).toBe('unit');
  });
});

describe('which code each test covers, and the gaps', () => {
  it('by name (OrderServiceTests → OrderService), and by what it imports or builds', () => {
    expect(subjectOf('tests/Orders.Tests/OrderServiceTests.cs')).toBe('orderservice');
    expect(subjectOf('src/orders/order-service.test.ts')).toBe('orderservice');
    expect(subjectOf('tests/test_refunds.py')).toBe('refunds');
    const tests = [
      diffFile('tests/Orders.Tests/OrderServiceTests.cs', '+    var policy = new RefundPolicy(clock);'),
      diffFile('src/web/checkout.test.ts', "+import { total } from './cart.js';"),
    ];
    const cov = matchTestsToCode(tests, [
      'src/Orders/OrderService.cs',
      'src/Orders/RefundPolicy.cs',
      'src/web/cart.ts',
      'src/web/other.ts',
    ]);
    expect(cov.covers['tests/Orders.Tests/OrderServiceTests.cs']).toEqual(['src/Orders/OrderService.cs', 'src/Orders/RefundPolicy.cs']);
    expect(cov.covers['src/web/checkout.test.ts']).toEqual(['src/web/cart.ts']);
    expect(cov.coveredBy['src/web/other.ts']).toBeUndefined();
  });

  it('the breakdown: counts, the gaps, what goes away quietly, and unit tests alone for a schema change', () => {
    const files = [
      diffFile('src/Orders/RefundPolicy.cs', '+ return amount;'),
      diffFile('src/Orders/Shipping.cs', '+ return 0;'),
      diffFile('src/Data/Migrations/1_Refunds.cs', '+ migrationBuilder.AddColumn();'),
      diffFile('src/Orders/Gone.cs', '- old', 'deleted'),
      diffFile('tests/Orders.Tests/RefundPolicyTests.cs', '+    [Fact]\n+    public void Refunds()\n-    [Fact]\n-    public void Old()'),
    ];
    const kinds = {
      'src/Orders/RefundPolicy.cs': 'logic',
      'src/Orders/Shipping.cs': 'logic',
      'src/Data/Migrations/1_Refunds.cs': 'schema',
      'src/Orders/Gone.cs': 'logic',
      'tests/Orders.Tests/RefundPolicyTests.cs': 'tests',
    };
    const b = testBreakdown(files, kinds);
    expect(b.counts).toEqual({ added: 1, changed: 0, removed: 1, skipped: 0 });
    // A deleted file needs no test; the migration and Shipping have none.
    expect(b.gaps).toEqual(['src/Orders/Shipping.cs', 'src/Data/Migrations/1_Refunds.cs']);
    expect(b.lost.map((t) => t.name)).toEqual(['Old']);
    expect(b.unitOnlyForSchema).toBe(true);
  });
});
