// Separate the John Hancock "Industrial Insight 401k" holdings (recorded under
// real tickers VT & FSMDX, but priced in John Hancock *units* that differ from
// the market) into their own JH-specific commodities, and backfill a daily
// price series = (buy-derived ratio) x (clean Yahoo market price). This makes
// the historical 401k balance reflect the actual JH unit value instead of the
// inflated real-ticker market value.
//
// Idempotent and fully reversible (creates commodities + prices, re-points 2
// accounts; deletes nothing pre-existing). Usage:
//   node scripts/jh-401k-separate.mjs <connectionString> [--dry]
import pg from 'pg';
import YahooFinance from 'yahoo-finance2';

const cs = process.argv[2];
const DRY = process.argv.includes('--dry');
if (!cs) { console.error('usage: jh-401k-separate.mjs <connectionString> [--dry]'); process.exit(1); }

const PRICE_DENOM = 100_000_000;
const NAMESPACE = 'JOHNHANCOCK';
const HOLDINGS = [
  { sym: 'VT',    acctPfx: '2fe3aa63', mnemonic: 'JH-VT',    fullname: 'John Hancock Industrial Insight — VT (World Stock unit)' },
  { sym: 'FSMDX', acctPfx: '7ceb9540', mnemonic: 'JH-FSMDX', fullname: 'John Hancock Industrial Insight — FSMDX (Mid Cap unit)' },
];

const y = new YahooFinance({ suppressNotices: ['yahooSurvey'] });
const guid = () => crypto.randomUUID().replace(/-/g, '');
const ymd = (d) => d.toISOString().slice(0, 10);

// Linear-interpolate the buy ratio for a given date; clamp outside the range.
function ratioAt(buyRatios, date) {
  if (date <= buyRatios[0].date) return buyRatios[0].r;
  if (date >= buyRatios[buyRatios.length - 1].date) return buyRatios[buyRatios.length - 1].r;
  for (let i = 1; i < buyRatios.length; i++) {
    if (date <= buyRatios[i].date) {
      const a = buyRatios[i - 1], b = buyRatios[i];
      const span = b.date.getTime() - a.date.getTime();
      const f = span === 0 ? 0 : (date.getTime() - a.date.getTime()) / span;
      return a.r + f * (b.r - a.r);
    }
  }
  return buyRatios[buyRatios.length - 1].r;
}

const c = new pg.Client({ connectionString: cs });
await c.connect();
const usd = (await c.query("SELECT guid FROM commodities WHERE namespace='CURRENCY' AND mnemonic='USD'")).rows[0].guid;

for (const h of HOLDINGS) {
  console.log(`\n=== ${h.sym} -> ${h.mnemonic} ===`);
  const acct = (await c.query('SELECT guid, commodity_guid FROM accounts WHERE guid LIKE $1', [h.acctPfx + '%'])).rows[0];
  if (!acct) { console.log('  account not found, skipping'); continue; }
  const oldCg = acct.commodity_guid;
  const oldFraction = (await c.query('SELECT fraction FROM commodities WHERE guid=$1', [oldCg])).rows[0].fraction;

  // Buys with their JH implied unit price.
  const buys = (await c.query(`
    SELECT t.post_date d, ABS(sp.value_num::numeric/sp.value_denom) v, ABS(sp.quantity_num::numeric/sp.quantity_denom) q
    FROM splits sp JOIN transactions t ON t.guid=sp.tx_guid
    WHERE sp.account_guid=$1 AND sp.quantity_num>0 ORDER BY t.post_date`, [acct.guid])).rows;
  const lastTxn = (await c.query(`
    SELECT MAX(t.post_date) d FROM splits sp JOIN transactions t ON t.guid=sp.tx_guid WHERE sp.account_guid=$1`, [acct.guid])).rows[0].d;

  // Clean Yahoo daily closes over the holding window.
  const start = new Date(buys[0].d); start.setDate(start.getDate() - 5);
  const end = new Date(lastTxn); end.setDate(end.getDate() + 2);
  const chart = await y.chart(h.sym, { period1: start, period2: end, interval: '1d' });
  const bars = (chart.quotes || []).filter((q) => typeof q.close === 'number' && q.close > 0)
    .map((q) => ({ date: new Date(ymd(q.date) + 'T00:00:00Z'), close: q.close }));
  const closeOnOrBefore = (d) => {
    let best = null;
    for (const b of bars) { if (b.date <= d) best = b; else break; }
    return best?.close ?? null;
  };

  // Buy-derived ratios (JH implied / clean market close).
  const rawRatios = [];
  for (const b of buys) {
    const bd = new Date(ymd(new Date(b.d)) + 'T00:00:00Z');
    const mk = closeOnOrBefore(bd);
    if (!mk) continue;
    rawRatios.push({ date: bd, r: (Number(b.v) / Number(b.q)) / mk });
  }
  // The JH fund tracks its ticker with a near-constant conversion, so reject
  // outlier buys (dividend reinvestments / glitchy records) that would otherwise
  // corrupt the interpolated series. Keep ratios within +/-40% of the median.
  const sortedAll = rawRatios.map((x) => x.r).sort((a, b) => a - b);
  const median = sortedAll[Math.floor(sortedAll.length / 2)];
  const buyRatios = rawRatios.filter((x) => x.r >= median * 0.6 && x.r <= median * 1.4);
  const dropped = rawRatios.length - buyRatios.length;
  if (buyRatios.length < 2) { // degenerate: fall back to a single constant median anchor
    buyRatios.length = 0;
    buyRatios.push({ date: new Date(buys[0].d), r: median }, { date: new Date(lastTxn), r: median });
  }
  const rs = buyRatios.map((x) => x.r).sort((a, b) => a - b);
  console.log(`  buys=${buys.length} kept=${buyRatios.length} dropped=${dropped} ratio median=${median.toFixed(4)} (kept min ${rs[0].toFixed(4)} max ${rs[rs.length - 1].toFixed(4)})`);
  console.log(`  holding window ${ymd(new Date(buys[0].d))} .. ${ymd(new Date(lastTxn))}, Yahoo bars=${bars.length}`);

  if (DRY) { console.log('  [dry] would create commodity, re-point account, backfill', bars.length, 'prices'); continue; }

  // Find-or-create the JH-specific commodity.
  let newCg = (await c.query('SELECT guid FROM commodities WHERE namespace=$1 AND mnemonic=$2', [NAMESPACE, h.mnemonic])).rows[0]?.guid;
  if (!newCg) {
    newCg = guid();
    await c.query(
      `INSERT INTO commodities (guid, namespace, mnemonic, fullname, cusip, fraction, quote_flag, quote_source, quote_tz)
       VALUES ($1,$2,$3,$4,NULL,$5,0,NULL,NULL)`,
      [newCg, NAMESPACE, h.mnemonic, h.fullname, oldFraction]);
    console.log(`  created commodity ${h.mnemonic} (${newCg.slice(0, 8)}) fraction=${oldFraction}`);
  } else {
    console.log(`  commodity ${h.mnemonic} exists (${newCg.slice(0, 8)})`);
  }

  // Re-point the account (record old for reversibility).
  await c.query('UPDATE accounts SET commodity_guid=$1 WHERE guid=$2', [newCg, acct.guid]);
  console.log(`  re-pointed account ${h.acctPfx} : ${oldCg.slice(0, 8)} -> ${newCg.slice(0, 8)} (old ticker preserved as a separate commodity)`);

  // Rebuild the JH price series.
  await c.query('DELETE FROM prices WHERE commodity_guid=$1', [newCg]);
  let n = 0;
  for (const b of bars) {
    const jh = ratioAt(buyRatios, b.date) * b.close;
    const num = BigInt(Math.round(jh * PRICE_DENOM));
    await c.query(
      `INSERT INTO prices (guid, commodity_guid, currency_guid, date, source, type, value_num, value_denom)
       VALUES ($1,$2,$3,$4,'user:jh-unit','last',$5,$6)`,
      [guid(), newCg, usd, b.date, num.toString(), String(PRICE_DENOM)]);
    n++;
  }
  console.log(`  backfilled ${n} JH-unit prices`);
}

await c.end();
console.log('\nDone.');
