import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { loadEnvConfig } = require('@next/env') as { loadEnvConfig: (dir: string) => void };
loadEnvConfig(process.cwd());

async function main() {
  const { auditAndBackfillPrices } = await import('@/lib/price-service');
  const symbols = process.argv
    .slice(2)
    .map((value) => value.trim().toUpperCase())
    .filter(Boolean);

  const result = await auditAndBackfillPrices(symbols.length > 0 ? symbols : undefined);
  console.log(
    JSON.stringify(
      {
        stored: result.stored,
        audited: result.audited,
        failed: result.failed,
        results: result.results,
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error('Price audit failed:', error);
  process.exit(1);
});
