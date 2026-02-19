/**
 * SimpleFin Transaction Sync Engine
 *
 * Syncs transactions from SimpleFin into GnuCash.
 * Handles deduplication, category guessing, and transaction creation.
 */

import prisma, { generateGuid } from '@/lib/prisma';
import { decryptAccessUrl, fetchAccountsChunked, SimpleFinTransaction, SimpleFinAccessRevokedError } from './simplefin.service';
import { toNumDenom } from '@/lib/validation';

export interface SyncResult {
  accountsProcessed: number;
  transactionsImported: number;
  transactionsSkipped: number;
  errors: { account: string; error: string }[];
}

/**
 * Sync all mapped accounts for a given connection.
 */
export async function syncSimpleFin(connectionId: number, bookGuid: string): Promise<SyncResult> {
  const result: SyncResult = {
    accountsProcessed: 0,
    transactionsImported: 0,
    transactionsSkipped: 0,
    errors: [],
  };

  // Get connection
  const connections = await prisma.$queryRaw<{
    id: number;
    access_url_encrypted: string;
    last_sync_at: Date | null;
  }[]>`
    SELECT id, access_url_encrypted, last_sync_at
    FROM gnucash_web_simplefin_connections
    WHERE id = ${connectionId}
  `;

  if (connections.length === 0) {
    result.errors.push({ account: 'connection', error: 'Connection not found' });
    return result;
  }

  const connection = connections[0];
  let accessUrl: string;
  try {
    accessUrl = decryptAccessUrl(connection.access_url_encrypted);
  } catch {
    result.errors.push({ account: 'connection', error: 'Failed to decrypt access URL' });
    return result;
  }

  // Get mapped accounts
  const mappedAccounts = await prisma.$queryRaw<{
    id: number;
    simplefin_account_id: string;
    simplefin_account_name: string | null;
    gnucash_account_guid: string;
    last_sync_at: Date | null;
  }[]>`
    SELECT id, simplefin_account_id, simplefin_account_name, gnucash_account_guid, last_sync_at
    FROM gnucash_web_simplefin_account_map
    WHERE connection_id = ${connectionId} AND gnucash_account_guid IS NOT NULL
  `;

  if (mappedAccounts.length === 0) {
    return result;
  }

  // Determine the date range for fetching
  // Use earliest last_sync_at across all mapped accounts, or 90 days ago
  const ninetyDaysAgo = new Date();
  ninetyDaysAgo.setDate(ninetyDaysAgo.getDate() - 90);

  let earliestSync = ninetyDaysAgo;
  for (const acct of mappedAccounts) {
    if (acct.last_sync_at && acct.last_sync_at < earliestSync) {
      earliestSync = acct.last_sync_at;
    }
  }

  const endDate = new Date();

  // Fetch all accounts with transactions using 60-day chunking
  let accountSet;
  try {
    accountSet = await fetchAccountsChunked(accessUrl, earliestSync, endDate);
  } catch (error) {
    if (error instanceof SimpleFinAccessRevokedError) {
      result.errors.push({ account: 'all', error: 'SimpleFin access has been revoked' });
    } else {
      result.errors.push({ account: 'all', error: `Failed to fetch from SimpleFin: ${error}` });
    }
    return result;
  }

  // Build a map of SimpleFin account id -> account data
  const sfAccountMap = new Map(accountSet.accounts.map(a => [a.id, a]));

  // Get the transaction currency for the book
  const bookCurrency = await prisma.$queryRaw<{ commodity_guid: string; mnemonic: string }[]>`
    SELECT c.guid as commodity_guid, c.mnemonic
    FROM books b
    JOIN commodities c ON c.guid = b.root_template_guid
    WHERE b.guid = ${bookGuid}
    LIMIT 1
  `;

  // Process each mapped account
  for (const mappedAccount of mappedAccounts) {
    const sfAccount = sfAccountMap.get(mappedAccount.simplefin_account_id);
    if (!sfAccount || !sfAccount.transactions) {
      continue;
    }

    result.accountsProcessed++;

    try {
      // Get existing SimpleFin transaction IDs for this account to dedup
      const existingMeta = await prisma.$queryRaw<{ simplefin_transaction_id: string }[]>`
        SELECT meta.simplefin_transaction_id
        FROM gnucash_web_transaction_meta meta
        WHERE meta.simplefin_transaction_id IS NOT NULL
          AND meta.source = 'simplefin'
      `;
      const existingIds = new Set(existingMeta.map(m => m.simplefin_transaction_id));

      // Get the GnuCash account's commodity/currency for the splits
      const gnucashAccount = await prisma.accounts.findUnique({
        where: { guid: mappedAccount.gnucash_account_guid },
        include: { commodity: true },
      });

      if (!gnucashAccount) {
        result.errors.push({
          account: mappedAccount.simplefin_account_name || mappedAccount.simplefin_account_id,
          error: 'Mapped GnuCash account not found',
        });
        continue;
      }

      if (!gnucashAccount.commodity_guid) {
        result.errors.push({
          account: mappedAccount.simplefin_account_name || mappedAccount.simplefin_account_id,
          error: 'GnuCash account has no currency assigned',
        });
        continue;
      }

      const currencyGuid = gnucashAccount.commodity_guid;
      const currencyMnemonic = gnucashAccount.commodity?.mnemonic || 'USD';

      for (const sfTxn of sfAccount.transactions) {
        // Dedup by SimpleFin transaction ID
        if (existingIds.has(sfTxn.id)) {
          result.transactionsSkipped++;
          continue;
        }

        try {
          await importTransaction(
            sfTxn,
            mappedAccount.gnucash_account_guid,
            currencyGuid,
            currencyMnemonic,
            bookGuid
          );
          result.transactionsImported++;
          existingIds.add(sfTxn.id); // Prevent re-import within same sync
        } catch (err) {
          result.errors.push({
            account: mappedAccount.simplefin_account_name || mappedAccount.simplefin_account_id,
            error: `Failed to import transaction ${sfTxn.id}: ${err}`,
          });
        }
      }

      // Update last_sync_at on the account mapping
      await prisma.$executeRaw`
        UPDATE gnucash_web_simplefin_account_map
        SET last_sync_at = NOW()
        WHERE id = ${mappedAccount.id}
      `;
    } catch (err) {
      result.errors.push({
        account: mappedAccount.simplefin_account_name || mappedAccount.simplefin_account_id,
        error: `Sync failed: ${err}`,
      });
    }
  }

  // Update connection last_sync_at
  await prisma.$executeRaw`
    UPDATE gnucash_web_simplefin_connections
    SET last_sync_at = NOW()
    WHERE id = ${connectionId}
  `;

  return result;
}

/**
 * Import a single SimpleFin transaction into GnuCash.
 */
async function importTransaction(
  sfTxn: SimpleFinTransaction,
  bankAccountGuid: string,
  currencyGuid: string,
  currencyMnemonic: string,
  bookGuid: string
): Promise<void> {
  const amount = parseFloat(sfTxn.amount);
  if (isNaN(amount) || amount === 0) return;

  // Guess the destination account based on historical transactions
  const destAccountGuid = await guessCategory(
    bankAccountGuid,
    sfTxn.description || sfTxn.payee || '',
    currencyMnemonic,
    bookGuid
  );

  const postDate = new Date(sfTxn.posted * 1000);
  const description = sfTxn.description || sfTxn.payee || 'SimpleFin Import';
  const memo = sfTxn.pending ? '(Pending) ' + (sfTxn.memo || '') : (sfTxn.memo || '');

  const txGuid = generateGuid();
  const split1Guid = generateGuid();
  const split2Guid = generateGuid();

  // Amount: positive = money in (credit to bank), negative = money out (debit from bank)
  const { num: absNum, denom } = toNumDenom(Math.abs(amount));
  const bankValueNum = amount > 0 ? absNum : -absNum;
  const destValueNum = amount > 0 ? -absNum : absNum;

  await prisma.$transaction(async (tx) => {
    // Create transaction
    await tx.transactions.create({
      data: {
        guid: txGuid,
        currency_guid: currencyGuid,
        num: '',
        post_date: postDate,
        enter_date: new Date(),
        description,
      },
    });

    // Bank account split
    await tx.splits.create({
      data: {
        guid: split1Guid,
        tx_guid: txGuid,
        account_guid: bankAccountGuid,
        memo: memo,
        action: '',
        reconcile_state: 'n',
        reconcile_date: null,
        value_num: BigInt(bankValueNum),
        value_denom: BigInt(denom),
        quantity_num: BigInt(bankValueNum),
        quantity_denom: BigInt(denom),
        lot_guid: null,
      },
    });

    // Destination account split (opposite sign)
    await tx.splits.create({
      data: {
        guid: split2Guid,
        tx_guid: txGuid,
        account_guid: destAccountGuid,
        memo: '',
        action: '',
        reconcile_state: 'n',
        reconcile_date: null,
        value_num: BigInt(destValueNum),
        value_denom: BigInt(denom),
        quantity_num: BigInt(destValueNum),
        quantity_denom: BigInt(denom),
        lot_guid: null,
      },
    });

    // Insert transaction meta (reviewed=false for imports)
    await prisma.$executeRaw`
      INSERT INTO gnucash_web_transaction_meta
        (transaction_guid, source, reviewed, simplefin_transaction_id, confidence)
      VALUES
        (${txGuid}, 'simplefin', FALSE, ${sfTxn.id}, ${destAccountGuid.includes('Imbalance') ? 'low' : 'medium'})
    `;
  });
}

/**
 * Guess the destination account based on historical transactions with similar descriptions.
 * Returns Imbalance-{currency} if no confident match found.
 */
async function guessCategory(
  bankAccountGuid: string,
  description: string,
  currencyMnemonic: string,
  bookGuid: string
): Promise<string> {
  if (!description.trim()) {
    return await getOrCreateImbalanceAccount(currencyMnemonic, bookGuid);
  }

  // Find the most frequent counterpart account for similar descriptions
  const matches = await prisma.$queryRaw<{ account_guid: string; cnt: bigint }[]>`
    SELECT s2.account_guid, COUNT(*) as cnt
    FROM transactions t
    JOIN splits s1 ON s1.tx_guid = t.guid AND s1.account_guid = ${bankAccountGuid}
    JOIN splits s2 ON s2.tx_guid = t.guid AND s2.account_guid != ${bankAccountGuid}
    WHERE LOWER(t.description) LIKE LOWER(${`%${description.substring(0, 50)}%`})
    GROUP BY s2.account_guid
    ORDER BY cnt DESC
    LIMIT 1
  `;

  if (matches.length > 0 && Number(matches[0].cnt) >= 2) {
    return matches[0].account_guid;
  }

  return await getOrCreateImbalanceAccount(currencyMnemonic, bookGuid);
}

/**
 * Get or create the Imbalance-{currency} account.
 */
async function getOrCreateImbalanceAccount(
  currencyMnemonic: string,
  bookGuid: string
): Promise<string> {
  const imbalanceName = `Imbalance-${currencyMnemonic}`;

  // Check if it already exists
  const existing = await prisma.accounts.findFirst({
    where: { name: imbalanceName },
  });

  if (existing) {
    return existing.guid;
  }

  // Get root account for this book
  const roots = await prisma.$queryRaw<{ root_account_guid: string }[]>`
    SELECT root_account_guid FROM books WHERE guid = ${bookGuid} LIMIT 1
  `;

  if (roots.length === 0) {
    // Fallback: find any root account
    const root = await prisma.accounts.findFirst({
      where: { account_type: 'ROOT' },
    });
    if (!root) throw new Error('No root account found');

    return root.guid;
  }

  // Get the currency commodity guid
  const currency = await prisma.commodities.findFirst({
    where: { mnemonic: currencyMnemonic, namespace: 'CURRENCY' },
  });

  if (!currency) {
    throw new Error(`Currency ${currencyMnemonic} not found`);
  }

  // Create the Imbalance account
  const guid = generateGuid();
  await prisma.accounts.create({
    data: {
      guid,
      name: imbalanceName,
      account_type: 'BANK',
      commodity_guid: currency.guid,
      commodity_scu: 100,
      non_std_scu: 0,
      parent_guid: roots[0].root_account_guid,
      code: '',
      description: 'Auto-created for unmatched SimpleFin imports',
      hidden: 0,
      placeholder: 0,
    },
  });

  return guid;
}

/**
 * Sync all active connections (used by the worker process).
 */
export async function syncAllConnections(): Promise<SyncResult[]> {
  const connections = await prisma.$queryRaw<{
    id: number;
    book_guid: string;
  }[]>`
    SELECT id, book_guid FROM gnucash_web_simplefin_connections
    WHERE sync_enabled = TRUE
  `;

  const results: SyncResult[] = [];

  for (const conn of connections) {
    try {
      const result = await syncSimpleFin(conn.id, conn.book_guid);
      results.push(result);
    } catch (error) {
      results.push({
        accountsProcessed: 0,
        transactionsImported: 0,
        transactionsSkipped: 0,
        errors: [{ account: 'connection', error: `Sync failed: ${error}` }],
      });
    }
  }

  return results;
}
