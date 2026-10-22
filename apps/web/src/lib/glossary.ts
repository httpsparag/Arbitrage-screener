// Plain-language explanations shown behind the "?" buttons.

export type Term =
  | "strategy"
  | "yield"
  | "vsFunding"
  | "netPerLot"
  | "gross"
  | "capital"
  | "quality"
  | "closing"
  | "status"
  | "expiry"
  | "live";

export const GLOSSARY: Record<Term, { title: string; body: string[] }> = {
  strategy: {
    title: "How cash–futures arbitrage works",
    body: [
      "You buy a stock and, at the same moment, sell its futures contract at a slightly higher price.",
      "On expiry day the futures price and the stock price become the same, so the gap you locked in becomes your profit — whichever way the market moves.",
      "Charges (STT, brokerage, exchange fees, GST, stamp duty) eat part of the gap. The screener only calls a trade profitable after taking all of them off.",
    ],
  },
  yield: {
    title: "Yield after costs (per year)",
    body: [
      "The profit after every charge, divided by the money spent on the shares, scaled to a full year.",
      "Example: 0.5% profit over 30 days ≈ 6.1% a year. Use it to compare with an FD or liquid fund.",
      "Very short expiries can make this number look large — also check the ₹ profit per lot.",
    ],
  },
  vsFunding: {
    title: "Versus your funding rate",
    body: [
      "How much the trade beats (or falls short of) what your money could earn elsewhere — the rate you set in Settings (7% by default).",
      "Positive means the trade earns more than that alternative after all costs.",
    ],
  },
  netPerLot: {
    title: "Net profit per lot",
    body: [
      "Rupees you keep from one futures lot (for example 500 shares) after all charges, if held to expiry.",
      "It assumes the futures and stock prices meet at expiry, which is how futures settle.",
    ],
  },
  gross: {
    title: "Gross spread",
    body: [
      "How much higher the futures price is than the stock price, before any charges.",
      "A big gross spread alone is not enough — charges and the holding period decide the real return.",
    ],
  },
  capital: {
    title: "Capital required",
    body: [
      "Total money needed to run the trade: the full cost of the shares, plus entry charges, plus the margin your broker blocks for the short future.",
      "Margins come from Angel One's own margin calculator. They are returned when the trade is closed.",
    ],
  },
  quality: {
    title: "Quality score",
    body: [
      "A 0–100 score for how reliable and tradable the opportunity looks: fresh prices, enough trading activity, tight bid–ask spreads, enough depth for your quantity and low charges relative to the gap.",
      "It helps you avoid opportunities that look good on paper but are hard to execute. It never replaces the profit figures.",
    ],
  },
  closing: {
    title: "Closing prices view",
    body: [
      "When the market is closed you see every contract calculated from the day's closing prices.",
      "Stocks close in an auction at 15:35 and futures at 15:40, a few minutes apart, so these numbers are for review only — they are not live and cannot be traded.",
    ],
  },
  status: {
    title: "What the labels mean",
    body: [
      "Profitable — real, current prices and a positive result after all charges.",
      "Unprofitable — prices are fine, but charges are bigger than the gap.",
      "Excluded — not usable right now (market closed, prices too old, auction, or missing data). Tap a row to see why.",
      "At close — calculated from closing prices; for review only.",
    ],
  },
  expiry: {
    title: "Expiry",
    body: [
      "Stock futures expire once a month. You can choose this month's, next month's or the far month's contract.",
      "Nearer expiries tie up money for fewer days; further ones usually have a bigger gap but a longer wait.",
    ],
  },
  live: {
    title: "Live status",
    body: [
      "LIVE — prices are fresh; the cloud scanner refreshes them every 30 seconds during market hours.",
      "STALE or OFFLINE — no fresh prices recently. Check Settings → Cloud scanner. Nothing is shown as profitable from old prices.",
      "MARKET CLOSED — outside 09:15–15:15 IST; you see closing prices for review.",
    ],
  },
};
