import { initializeDatabase } from '../src/lib/db-init';

async function main() {
    await initializeDatabase();
    process.exit(0);
}

main().catch((err) => {
    console.error('db-init failed:', err);
    process.exit(1);
});
