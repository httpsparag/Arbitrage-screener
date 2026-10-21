"use client";

import { GLOSSARY, type Term } from "@/lib/glossary";
import { Disclosure, Sheet } from "./ui";

const STEPS = [
  { n: "1", title: "Buy the stock", body: "Buy the shares in the cash market at the current selling price (ask)." },
  { n: "2", title: "Sell its future", body: "At the same time, sell one lot of that stock's futures contract at the current buying price (bid). It is usually a little higher." },
  { n: "3", title: "Wait for expiry", body: "On expiry day the two prices meet. Whether the market rises or falls, the gain on one side cancels the loss on the other." },
  { n: "4", title: "Keep the gap", body: "You keep the price gap you locked in, minus all charges. The screener shows that net amount up front." },
];

const TERMS: Term[] = ["yield", "netPerLot", "vsFunding", "capital", "quality", "status", "live", "closing", "expiry", "gross"];

export function HelpSheet({ onClose }: { onClose: () => void }) {
  return (
    <Sheet label="How it works" title="How it works" subtitle="Cash–futures arbitrage in 4 steps" onClose={onClose}>
      <ol className="space-y-3">
        {STEPS.map((s) => (
          <li key={s.n} className="flex gap-3 rounded-2xl border border-line bg-panel p-4">
            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-accent-bg text-sm font-semibold text-accent">
              {s.n}
            </span>
            <div>
              <p className="font-medium">{s.title}</p>
              <p className="mt-0.5 text-sm leading-relaxed text-muted">{s.body}</p>
            </div>
          </li>
        ))}
      </ol>

      <h3 className="mt-6 mb-2 text-xs font-semibold uppercase tracking-wider text-muted">What the numbers mean</h3>
      <div className="space-y-2">
        {TERMS.map((t) => (
          <Disclosure key={t} title={GLOSSARY[t].title}>
            <div className="space-y-2 text-sm leading-relaxed text-text/90">
              {GLOSSARY[t].body.map((p, i) => (
                <p key={i}>{p}</p>
              ))}
            </div>
          </Disclosure>
        ))}
      </div>

      <p className="mt-6 rounded-2xl bg-panel-2 p-4 text-xs leading-relaxed text-muted">
        All figures are estimates, not guaranteed returns. Prices can be missed, orders can fill partly, and margins can
        change. Always check prices and charges in your broker app before placing a trade.
      </p>
    </Sheet>
  );
}
