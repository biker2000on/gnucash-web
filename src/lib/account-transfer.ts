import { toDecimalNumber } from './gnucash';

type TransferSibling = {
  account_guid: string;
  quantity_num: bigint;
  quantity_denom: bigint;
  account?: { commodity_guid?: string | null; account_type?: string | null } | null;
};

type TransferSplit = {
  account_guid: string;
  quantity_num: bigint;
  quantity_denom: bigint;
  transaction?: { splits?: TransferSibling[] | null } | null;
};

/**
 * True when a security split is one leg of an own-account, same-commodity
 * transfer. Trading legs are deliberately excluded: they can accompany an
 * ordinary purchase and must not turn it into a transfer.
 */
export function isOwnAccountCommodityTransfer(
  split: TransferSplit,
  commodityGuid: string | null | undefined,
  direction: 'in' | 'out',
): boolean {
  const quantity = toDecimalNumber(split.quantity_num, split.quantity_denom);
  if (direction === 'in' ? quantity <= 0 : quantity >= 0) return false;
  const expectedSiblingSign = direction === 'in' ? -1 : 1;
  return (split.transaction?.splits ?? []).some(sibling =>
    sibling.account_guid !== split.account_guid &&
    sibling.account?.commodity_guid === commodityGuid &&
    sibling.account?.account_type !== 'TRADING' &&
    expectedSiblingSign * toDecimalNumber(sibling.quantity_num, sibling.quantity_denom) > 0,
  );
}
