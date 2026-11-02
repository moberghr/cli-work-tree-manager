import type { UsageWire } from '../../core/api-types.js';

/** The demo's usage meter: Claude's default account at 42 % of its 5-hour limit and 18 % of the weekly one, its second
 *  account (demo-accounts.ts) at a few percent, and a few made-up token counts. */
export function demoUsage(now = Date.now()): UsageWire {
  // The weekly limit resets next Monday at 09:00, local time.
  const monday = new Date(now);
  monday.setHours(9, 0, 0, 0);
  monday.setDate(monday.getDate() + ((8 - monday.getDay()) % 7 || 7));
  return {
    agents: [
      {
        agent: 'claude',
        name: 'Claude Code',
        accounts: [
          {
            account: 'default',
            isDefault: true,
            at: new Date(now - 60_000).toISOString(),
            windows: [
              { id: 'five_hour', label: '5-hour limit', usedPercent: 42, resetsAt: new Date(now + 2 * 3_600_000).toISOString() },
              { id: 'seven_day', label: 'Weekly limit', usedPercent: 18, resetsAt: monday.toISOString() },
            ],
          },
          // The second login (demo-accounts.ts): little used this week, read a while ago.
          {
            account: 'work',
            at: new Date(now - 3 * 3_600_000).toISOString(),
            windows: [
              { id: 'five_hour', label: '5-hour limit', usedPercent: 6, resetsAt: new Date(now + 4 * 3_600_000).toISOString() },
              { id: 'seven_day', label: 'Weekly limit', usedPercent: 3, resetsAt: monday.toISOString() },
            ],
          },
        ],
      },
    ],
    tokens: {
      today: { input: 182_000, cached: 3_400_000, output: 61_000 },
      week: { input: 960_000, cached: 17_800_000, output: 318_000 },
      byModel: [
        {
          model: 'claude-opus-5-5',
          today: { input: 120_000, cached: 2_500_000, output: 44_000 },
          week: { input: 700_000, cached: 13_100_000, output: 240_000 },
        },
        {
          model: 'claude-haiku-4-5',
          today: { input: 62_000, cached: 900_000, output: 17_000 },
          week: { input: 260_000, cached: 4_700_000, output: 78_000 },
        },
      ],
      topSessions: [
        {
          id: 'demo-api-feat-invoice-export',
          label: 'api · feat/invoice-export',
          week: { input: 380_000, cached: 7_200_000, output: 120_000 },
        },
        { id: 'demo-shop-feat-checkout-v2', label: 'shop · feat/checkout-v2', week: { input: 250_000, cached: 4_600_000, output: 90_000 } },
        {
          id: 'demo-web-fix-login-redirect',
          label: 'web · fix/login-redirect',
          week: { input: 140_000, cached: 2_500_000, output: 50_000 },
        },
      ],
    },
    at: new Date(now).toISOString(),
  };
}
