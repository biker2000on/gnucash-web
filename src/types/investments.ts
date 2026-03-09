export interface CashByAccount {
  parentGuid: string;
  parentName: string;
  parentPath: string;
  cashBalance: number;
  investmentValue: number;
  cashPercent: number;
  cashAccountGuid?: string;
  cashAccountName?: string;
  cashAccountPath?: string;
  cashSource?: 'sibling' | 'parent' | 'none';
}

export interface OverallCash {
  totalCashBalance: number;
  totalInvestmentValue: number;
  totalValue: number;
  cashPercent: number;
}

export interface SectorExposure {
  sector: string;
  value: number;
  percent: number;
}

export interface ConsolidatedHolding {
  commodityGuid: string;
  symbol: string;
  fullname: string;
  totalShares: number;
  totalCostBasis: number;
  totalMarketValue: number;
  totalGainLoss: number;
  totalGainLossPercent: number;
  latestPrice: number;
  priceDate: string;
  accounts: Array<{
    accountGuid: string;
    accountName: string;
    accountPath: string;
    shares: number;
    costBasis: number;
    marketValue: number;
    gainLoss: number;
    gainLossPercent: number;
  }>;
}

export interface IndexDataPoint {
  date: string;
  value: number;
  percentChange: number;
}

export interface IndicesData {
  sp500: IndexDataPoint[];
  djia: IndexDataPoint[];
  nasdaq: IndexDataPoint[];
  russell2000: IndexDataPoint[];
}

export interface HistoryPoint {
  date: string;
  value: number;
}

export interface CashFlowPoint {
  date: string;
  amount: number;
}

export interface PortfolioData {
  summary: {
    totalValue: number;
    totalCostBasis: number;
    totalGainLoss: number;
    totalGainLossPercent: number;
    dayChange: number;
    dayChangePercent: number;
  };
  holdings: Array<{
    accountGuid: string;
    accountName: string;
    accountPath: string;
    commodityGuid: string;
    symbol: string;
    fullname: string;
    shares: number;
    costBasis: number;
    marketValue: number;
    gainLoss: number;
    gainLossPercent: number;
    latestPrice: number;
    priceDate: string;
  }>;
  allocation: Array<{
    category: string;
    value: number;
    percent: number;
  }>;
  cashByAccount: CashByAccount[];
  overallCash: OverallCash;
  sectorExposure: SectorExposure[];
  sectorByAccount: Record<string, SectorExposure[]>;
  consolidatedHoldings: ConsolidatedHolding[];
}

export interface HistoryData {
  history: HistoryPoint[];
  cashFlows: CashFlowPoint[];
  indices: IndicesData;
}
