import type { FinancialAction } from './types';

const ACCOUNT_GUID_PATTERN = /^[0-9a-f]{32}$/i;
const ACCOUNT_LINK_PATTERN = /\/accounts\/([0-9a-f]{32})(?:[/?#]|$)/i;

function addGuid(guids: Set<string>, value: unknown): void {
  if (typeof value === 'string' && ACCOUNT_GUID_PATTERN.test(value)) {
    guids.add(value);
  }
}

export function actionAccountGuids(action: FinancialAction): string[] {
  const guids = new Set<string>();
  addGuid(guids, action.metadata?.accountGuid);
  addGuid(guids, action.metadata?.account_guid);

  const metadataGuids = action.metadata?.accountGuids;
  if (Array.isArray(metadataGuids)) {
    for (const guid of metadataGuids) addGuid(guids, guid);
  }

  for (const evidence of action.trace.evidence) {
    if (evidence.kind === 'account') addGuid(guids, evidence.id);
    addGuid(guids, evidence.href?.match(ACCOUNT_LINK_PATTERN)?.[1]);
  }

  for (const operation of action.operations) {
    addGuid(guids, operation.href?.match(ACCOUNT_LINK_PATTERN)?.[1]);
  }

  return [...guids];
}

export function enrichActionsWithAccountPaths(
  actions: FinancialAction[],
  accountPaths: ReadonlyMap<string, string>,
): FinancialAction[] {
  return actions.map(action => {
    if (typeof action.metadata?.accountPath === 'string' && action.metadata.accountPath.trim()) {
      return action;
    }

    const paths = [...new Set(
      actionAccountGuids(action)
        .map(guid => accountPaths.get(guid))
        .filter((path): path is string => Boolean(path)),
    )];
    if (paths.length !== 1) return action;

    return {
      ...action,
      metadata: {
        ...action.metadata,
        accountPath: paths[0],
      },
    };
  });
}
