/**
 * @openapi
 * components:
 *   schemas:
 *     Account:
 *       type: object
 *       properties:
 *         guid:
 *           type: string
 *         name:
 *           type: string
 *         account_type:
 *           type: string
 *         parent_guid:
 *           type: string
 *           nullable: true
 *         hidden:
 *           type: integer
 *         total_balance:
 *           type: string
 *         period_balance:
 *           type: string
 *     Transaction:
 *       type: object
 *       properties:
 *         guid:
 *           type: string
 *         description:
 *           type: string
 *         post_date:
 *           type: string
 *           format: date-time
 *         splits:
 *           type: array
 *           items:
 *             $ref: '#/components/schemas/Split'
 *     Split:
 *       type: object
 *       properties:
 *         guid:
 *           type: string
 *         account_guid:
 *           type: string
 *         account_name:
 *           type: string
 *         value_decimal:
 *           type: string
 */
export interface Account {
    guid: string;
    name: string;
    account_type: string;
    commodity_guid: string;
    commodity_scu: number;
    non_std_scu: number;
    parent_guid: string | null;
    code: string;
    description: string;
    hidden: number;
    placeholder: number;
    fullname?: string;
    total_balance?: string;
    period_balance?: string;
}

export interface Transaction {
    guid: string;
    currency_guid: string;
    num: string;
    post_date: Date;
    enter_date: Date;
    description: string;
    splits?: Split[];
}

export interface Split {
    guid: string;
    tx_guid: string;
    account_guid: string;
    memo: string;
    action: string;
    reconcile_state: string;
    reconcile_date: Date | null;
    value_num: number | string | bigint;
    value_denom: number | string | bigint;
    quantity_num: number | string | bigint;
    quantity_denom: number | string | bigint;
    lot_guid: string | null;
    account_name?: string;
    value_decimal?: string;
}

export interface AccountWithChildren extends Account {
    children: AccountWithChildren[];
}
