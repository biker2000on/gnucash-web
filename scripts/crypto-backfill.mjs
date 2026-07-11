// Backfill daily crypto prices from Yahoo Finance for all CRYPTO-namespace
// commodities in a book. Fetches from each commodity's first transaction date
// (or 3y ago if it has no txns), dedups against existing prices, stores in USD
// at 1e8 precision. Usage: node scripts/crypto-backfill.mjs <connectionString>
import pg from 'pg';
import YahooFinance from 'yahoo-finance2';

const cs = process.argv[2];
if (!cs) { console.error('usage: crypto-backfill.mjs <connectionString>'); process.exit(1); }

const PRICE_DENOM = 100_000_000;
const y = new YahooFinance({ suppressNotices: ['yahooSurvey'] });

function guid() { return crypto.randomUUID().replace(/-/g, ''); }
function ymd(d) { return d.toISOString().slice(0, 10); }

const c = new pg.Client({ connectionString: cs });
await c.connect();

const usd = (await c.query("SELECT guid FROM commodities WHERE namespace='CURRENCY' AND mnemonic='USD'")).rows[0];
if (!usd) { console.error('USD currency not found'); process.exit(1); }

const cryptos = (await c.query("SELECT guid, mnemonic FROM commodities WHERE namespace='CRYPTO' ORDER BY mnemonic")).rows;
console.log(`${cryptos.length} crypto commodities`);

const endDate = new Date();
let grandTotal = 0;

for (const cm of cryptos) {
  // earliest of: first transaction post_date, first existing price, else 3y ago
  const txn = (await c.query(
    `SELECT MIN(t.post_date) AS d FROM splits s JOIN transactions t ON t.guid=s.tx_guid
     JOIN accounts a ON a.guid=s.account_guid WHERE a.commodity_guid=$1`, [cm.guid])).rows[0].d;
  let start = txn ? new Date(txn) : new Date(Date.now() - 3 * 365 * 864e5);
  start.setUTCHours(0, 0, 0, 0);

  const existing = new Set((await c.query(
    `SELECT date FROM prices WHERE commodity_guid=$1 AND date >= $2`, [cm.guid, start])).rows.map(r => ymd(r.date)));

  let quotes;
  try {
    const r = await y.chart(`${cm.mnemonic.toUpperCase()}-USD`, { period1: start, period2: endDate, interval: '1d' });
    quotes = (r.quotes || []).filter(q => typeof q.close === 'number' && q.close > 0);
  } catch (e) { console.log(`  ${cm.mnemonic}: FETCH ERR ${String(e.message).slice(0, 60)}`); continue; }

  let stored = 0;
  for (const q of quotes) {
    const dstr = ymd(q.date);
    if (existing.has(dstr)) continue;
    existing.add(dstr);
    const num = BigInt(Math.round(q.close * PRICE_DENOM));
    const d = new Date(q.date); d.setUTCHours(0, 0, 0, 0);
    await c.query(
      `INSERT INTO prices (guid, commodity_guid, currency_guid, date, source, type, value_num, value_denom)
       VALUES ($1,$2,$3,$4,'Finance::Quote','last',$5,$6)`,
      [guid(), cm.guid, usd.guid, d, num.toString(), String(PRICE_DENOM)]);
    stored++;
  }
  grandTotal += stored;
  console.log(`  ${cm.mnemonic.padEnd(5)} from ${ymd(start)}: +${stored} (had ${quotes.length} bars)`);
}

console.log(`TOTAL stored: ${grandTotal}`);
await c.end();
