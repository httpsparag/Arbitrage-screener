// Shared domain types used by the worker, the calculation engine and the UI.

/** How the price data was obtained. Only 'live' (and clearly labelled 'sample') can be executable. */
export type DataKind = 'live' | 'delayed' | 'snapshot' | 'eod' | 'sample';

export interface DepthLevel {
  price: number;
  quantity: number;
  orders?: number;
}

export interface Quote {
  token: string;
  ltp: number | null;
  /** Best bid first. */
  bids: DepthLevel[];
  /** Best ask first. */
  asks: DepthLevel[];
  volume: number | null;
  /** Traded value in rupees. */
  turnover: number | null;
  openInterest: number | null;
  /** Exchange timestamp of the last update, ms epoch. */
  exchangeTimestamp: number | null;
  /** When this process last received/confirmed the quote, ms epoch. Drives freshness. */
  receivedAt: number;
  tradable: boolean;
  dataKind: DataKind;
}

export type ContractStatus = 'active' | 'expired' | 'suspended' | 'ban_period';

/** One stock-futures contract paired with its underlying NSE cash instrument. */
export interface Contract {
  /** Underlying symbol, e.g. RELIANCE. */
  symbol: string;
  name: string;
  cashToken: string;
  cashTradingSymbol: string;
  futToken: string;
  futTradingSymbol: string;
  /** Expiry date, YYYY-MM-DD (IST). */
  expiry: string;
  lotSize: number;
  tickSize: number;
  status: ContractStatus;
}

export type PriceMode = 'ltp' | 'bidask' | 'depth';
export type ExitMode = 'square_off' | 'physical_settlement';

export interface CorporateAction {
  symbol: string;
  /** Ex-date, YYYY-MM-DD. */
  exDate: string;
  type: 'dividend' | 'other';
  description?: string;
  /** Dividend per share in rupees, when known. */
  amountPerShare?: number | null;
  /** Whether the exchange adjusts the futures price for this event. null = unknown. */
  futuresAdjusted: boolean | null;
  confidence: 'confirmed' | 'estimated' | 'unknown';
  source?: string;
}

export type ExclusionReason =
  | 'MARKET_CLOSED'
  | 'CROSSED_BOOK'
  | 'MISSING_CASH_QUOTE'
  | 'MISSING_FUT_QUOTE'
  | 'STALE_CASH_QUOTE'
  | 'STALE_FUT_QUOTE'
  | 'CASH_NOT_TRADABLE'
  | 'FUT_NOT_TRADABLE'
  | 'CONTRACT_EXPIRED'
  | 'CONTRACT_SUSPENDED'
  | 'CONTRACT_IN_BAN_PERIOD'
  | 'TOKEN_MISMATCH'
  | 'INVALID_LOT_SIZE'
  | 'NO_CASH_ASK'
  | 'NO_FUT_BID'
  | 'NO_CASH_LTP'
  | 'NO_FUT_LTP'
  | 'INVALID_PRICE'
  | 'INSUFFICIENT_CASH_DEPTH'
  | 'INSUFFICIENT_FUT_DEPTH';

export type WarningCode =
  | 'NEAR_EXPIRY'
  | 'EXPIRY_DAY'
  | 'TOP_OF_BOOK_QTY_LOW'
  | 'DIVIDEND_IN_WINDOW'
  | 'DIVIDEND_UNCERTAIN'
  | 'DIVIDEND_FUTURES_ADJUSTED'
  | 'CORPORATE_ACTION_IN_WINDOW'
  | 'NON_LIVE_DATA'
  | 'SAMPLE_DATA'
  | 'THEORETICAL_LTP_MODE'
  | 'BROKERAGE_ESTIMATED'
  | 'EXIT_PRICE_ESTIMATED'
  | 'WIDE_SPREAD';

export interface Warning {
  code: WarningCode;
  message: string;
}

export type OpportunityStatus =
  /** Valid live executable prices and positive estimated net profit. */
  | 'executable'
  /** Valid executable prices but non-positive estimated net profit. */
  | 'unprofitable'
  /** Calculated, but not executable (LTP mode or non-live data). Research view only. */
  | 'research'
  /** Failed validation; see exclusionReasons. Diagnostics view only. */
  | 'excluded';
