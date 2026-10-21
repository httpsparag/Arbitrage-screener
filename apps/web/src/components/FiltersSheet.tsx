"use client";

import { Check } from "lucide-react";
import { DEFAULT_FILTERS, SORT_LABEL, type Filters, type SortKey, type View } from "@/lib/view";
import { Chip, Sheet } from "./ui";

const VIEW_OPTIONS: { id: View; label: string; hint: string }[] = [
  { id: "profitable", label: "Profitable", hint: "Positive after every charge" },
  { id: "beats", label: "Beats my funding rate", hint: "Earns more than your FD / funding rate" },
  { id: "research", label: "Unprofitable", hint: "Charges are bigger than the gap" },
  { id: "excluded", label: "Excluded", hint: "Not usable now — tap a row to see why" },
  { id: "all", label: "Everything", hint: "All contracts" },
];

const SORTS: SortKey[] = ["yield", "netLot", "excess", "capYield", "capital", "quality", "days", "gross"];

/** Number of filters that differ from the defaults (shown as a badge). */
export function activeFilterCount(f: Filters): number {
  let n = 0;
  if (f.view !== DEFAULT_FILTERS.view) n++;
  if (f.expiry !== "all") n++;
  if (f.minYield !== null) n++;
  if (f.maxCapital !== null) n++;
  if (f.sort !== DEFAULT_FILTERS.sort) n++;
  return n;
}

export function FiltersSheet({
  filters,
  counts,
  resultCount,
  onChange,
  onClose,
}: {
  filters: Filters;
  counts: Partial<Record<View, number>>;
  resultCount: number;
  onChange: (patch: Partial<Filters>) => void;
  onClose: () => void;
}) {
  return (
    <Sheet
      label="Filters"
      title="Filter & sort"
      onClose={onClose}
      footer={
        <div className="flex gap-2">
          <button
            onClick={() => onChange({ ...DEFAULT_FILTERS, search: filters.search, watchOnly: filters.watchOnly })}
            className="rounded-2xl border border-line px-4 py-3 text-sm font-medium text-muted"
          >
            Reset
          </button>
          <button onClick={onClose} className="flex-1 rounded-2xl bg-accent px-4 py-3 text-sm font-semibold text-white">
            Show {resultCount} {resultCount === 1 ? "result" : "results"}
          </button>
        </div>
      }
    >
      <Group title="Show">
        <div className="space-y-1.5">
          {VIEW_OPTIONS.map((o) => (
            <button
              key={o.id}
              onClick={() => onChange({ view: o.id })}
              className={`flex w-full items-center gap-3 rounded-2xl border px-4 py-3 text-left transition ${
                filters.view === o.id ? "border-accent/60 bg-accent-bg" : "border-line bg-panel"
              }`}
              aria-pressed={filters.view === o.id}
            >
              <span className="flex-1">
                <span className="block text-[15px] font-medium">{o.label}</span>
                <span className="block text-xs text-muted">{o.hint}</span>
              </span>
              <span className="num text-sm text-muted">{counts[o.id] ?? 0}</span>
              {filters.view === o.id && <Check size={18} className="text-accent" />}
            </button>
          ))}
        </div>
      </Group>

      <Group title="Expiry">
        <div className="flex flex-wrap gap-2">
          {([
            ["all", "Any"],
            ["near", "This month"],
            ["next", "Next month"],
            ["far", "Far month"],
          ] as const).map(([id, label]) => (
            <Chip key={id} active={filters.expiry === id} onClick={() => onChange({ expiry: id })}>
              {label}
            </Chip>
          ))}
        </div>
      </Group>

      <Group title="Minimum yield (a year, after costs)">
        <div className="flex flex-wrap gap-2">
          {[null, 3, 5, 7, 10].map((v) => (
            <Chip key={String(v)} active={filters.minYield === v} onClick={() => onChange({ minYield: v })}>
              {v === null ? "Any" : `${v}%+`}
            </Chip>
          ))}
        </div>
      </Group>

      <Group title="Maximum money needed per trade">
        <div className="flex flex-wrap gap-2">
          {[null, 2e5, 5e5, 10e5, 25e5].map((v) => (
            <Chip key={String(v)} active={filters.maxCapital === v} onClick={() => onChange({ maxCapital: v })}>
              {v === null ? "Any" : `Up to ₹${v / 1e5} L`}
            </Chip>
          ))}
        </div>
      </Group>

      <Group title="Sort by">
        <div className="overflow-hidden rounded-2xl border border-line bg-panel">
          {SORTS.map((k) => (
            <button
              key={k}
              onClick={() => onChange({ sort: k })}
              className="flex w-full items-center border-b border-line px-4 py-3 text-left text-[15px] last:border-0"
              aria-pressed={filters.sort === k}
            >
              <span className="flex-1">{SORT_LABEL[k]}</span>
              {filters.sort === k && <Check size={18} className="text-accent" />}
            </button>
          ))}
        </div>
      </Group>
    </Sheet>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mt-5 first:mt-1">
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted">{title}</h3>
      {children}
    </section>
  );
}
