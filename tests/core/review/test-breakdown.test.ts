import { describe, expect, it } from 'vitest';
import {
  matchTestsToCode,
  tableRows,
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

  it('Jest / Vitest: it and test, .each (its rows counted when written as a list), .skip and xit, removed, a changed body', () => {
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
      ['partial refund %i', 'added', 'jest', 2],
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
      ['test_partial', 'added', 'pytest', 2],
      ['test_later', 'skipped', 'pytest', null],
      ['test_old', 'removed', 'pytest', null],
    ]);
  });

  it('a skip already there (context) is no news: only a skip the PR writes counts; a change inside one is a change', () => {
    const f = diffFile(
      'src/a.test.ts',
      `
   xit('was skipped before', () => {
   it.skip('also before', () => {
-    expect(1).toBe(1);
+    expect(1).toBe(2);
`,
    );
    expect(pick(f)).toEqual([['also before', 'changed', 'jest', null]]);
  });

  it('a parametrize over several lines has its rows counted; a table that is no list (range, a template) gives no number', () => {
    const f = diffFile(
      'tests/test_rates.py',
      `
+@pytest.mark.parametrize(
+    "a, b",
+    [
+        (1, 2),
+        (3, "x, y"),
+        (5, [6, 7]),
+    ],
+)
+def test_rates(a, b):
+@pytest.mark.parametrize("n", range(3))
+def test_range(n):
`,
    );
    expect(pick(f)).toEqual([
      ['test_rates', 'added', 'pytest', 3],
      ['test_range', 'added', 'pytest', null],
    ]);
    expect(tableRows('test.each`a | b`')).toBeNull();
    expect(tableRows('it.each([])(')).toBe(0);
    expect(tableRows('it.each([[1, 2], [3, 4], [5, 6],])(')).toBe(3);
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

  it('a database test is integration: by its folder, its file name, its base class or its fixture', () => {
    // Folders and file names.
    expect(testLevel('src/Shop.Tests/PostgreTests/Handlers/SubmissionQueriesPostgreTests.cs', '')).toBe('integration');
    expect(testLevel('src/Shop.Tests/Handlers/SubmissionQueriesPostgreTests.cs', '')).toBe('integration');
    expect(testLevel('src/Shop.Tests/DbTests/Orders.cs', '')).toBe('integration');
    expect(testLevel('src/Shop.Tests/SqlTests/Orders.cs', '')).toBe('integration');
    expect(testLevel('src/Shop.IntegrationTests/OrderTests.cs', '')).toBe('integration');
    // What the test uses, anywhere in the file.
    expect(testLevel('src/Shop.Tests/Handlers/AuditTests.cs', 'public class AuditTests : BasePostgreTest')).toBe('integration');
    expect(
      testLevel('src/Shop.Tests/Handlers/AuditTests.cs', 'public AuditTests(DatabaseFixture databaseFixture) : base(databaseFixture)'),
    ).toBe('integration');
    expect(testLevel('src/Shop.Tests/Handlers/AuditTests.cs', 'public class AuditTests : IClassFixture<PostgresDatabaseFixture>')).toBe(
      'integration',
    );
    expect(testLevel('src/Shop.Tests/Handlers/AuditTests.cs', 'var pg = new PostgreSqlContainer();')).toBe('integration');
    // Not one: a unit test that only mentions the database by name, a feedback test.
    expect(testLevel('src/Shop.Tests/UnitTests/FeedbackTests.cs', 'var db = new FakeDb(); // the database is mocked')).toBe('unit');
    expect(testLevel('src/Shop.Tests/UnitTests/Handlers/UpdateTests.cs', '')).toBe('unit');
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

  it('by a type the code file declares that the test names anywhere, or (C#) by importing its namespace', () => {
    const code = [
      diffFile(
        'src/Shop.Core/Types/Onboarding/SubmissionFields.cs',
        ' namespace Shop.Core.Types.Onboarding;\n+public class SignatoryFields\n+{',
      ),
      // No namespace line in its diff: its folders spell it.
      diffFile(
        'src/Shop.Core/Types/Onboarding/SubmissionValidator.cs',
        ' public static class SubmissionValidator\n+    if (f.Ssn is null) throw;',
      ),
      diffFile('src/Shop.Core/Data/Entities/Agreement.cs', '+public class Agreement\n+{'),
      diffFile('src/Shop.Core/Billing/Invoice.cs', '+public class Invoice\n+{'),
      diffFile('src/web/rates.ts', '+export function shippingRate(kg: number) {'),
    ];
    const tests = [
      // Names the declared type in a plain statement (not `new X(`), and imports the validator's namespace.
      diffFile(
        'src/Shop.Tests/UnitTests/SubmitCommandTests.cs',
        ' using Shop.Core.Types.Onboarding;\n+        var s = SignatoryFields.Empty;\n+        typeof(Agreement).FullName.ShouldNotBeNull();',
      ),
      diffFile('web/src/checkout.test.ts', '+  expect(shippingRate(2)).toBe(5);'),
    ];
    const cov = matchTestsToCode(
      tests,
      code.map((f) => f.path),
      code,
    );
    expect(cov.covers['src/Shop.Tests/UnitTests/SubmitCommandTests.cs']).toEqual([
      'src/Shop.Core/Types/Onboarding/SubmissionFields.cs',
      'src/Shop.Core/Types/Onboarding/SubmissionValidator.cs',
      'src/Shop.Core/Data/Entities/Agreement.cs',
    ]);
    expect(cov.covers['web/src/checkout.test.ts']).toEqual(['src/web/rates.ts']);
    expect(cov.coveredBy['src/Shop.Core/Billing/Invoice.cs']).toBeUndefined();
    // Without the code's diffs: names and imports only, as before.
    expect(matchTestsToCode(tests, ['src/Shop.Core/Billing/Invoice.cs', 'src/Shop.Core/Data/Entities/Agreement.cs']).coveredBy).toEqual({});
  });

  it('test support (a data builder) is test code but covers nothing itself', () => {
    const files = [
      diffFile('src/Shop.Core/Data/Entities/Submission.cs', '+public class Submission\n+{'),
      diffFile('src/Shop.Tests.Shared/CreateSubmission.cs', '+    public static Submission New() => new Submission();'),
    ];
    const b = testBreakdown(files, {
      'src/Shop.Core/Data/Entities/Submission.cs': 'logic',
      'src/Shop.Tests.Shared/CreateSubmission.cs': 'tests',
    });
    expect(b.gaps).toEqual(['src/Shop.Core/Data/Entities/Submission.cs']);
    expect(b.coverage.covers).toEqual({});
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
