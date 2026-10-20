"use client";

import type { TooltipContentProps } from "recharts";
import type { NameType, ValueType } from "recharts/types/component/DefaultTooltipContent";

export interface SeriesDef<K extends string = string> {
  key: K;
  label: string;
  color: string;
  format: (v: number | null | undefined) => string;
}

export const AXIS_TICK = { fill: "var(--muted)", fontSize: 12 };

export function Legend({ series }: { series: SeriesDef[] }) {
  return (
    <div className="legend">
      {series.map((s) => (
        <span key={s.key}>
          <i className="swatch" style={{ background: s.color }} />
          {s.label}
        </span>
      ))}
    </div>
  );
}

export function makeTooltip(series: SeriesDef[], title: (label: unknown) => string) {
  return function ChartTooltip({ active, payload, label }: TooltipContentProps<ValueType, NameType>) {
    if (!active || !payload?.length) return null;
    const row = payload[0].payload as Record<string, number | null>;
    return (
      <div className="tooltip">
        <div className="tooltip-title">{title(label)}</div>
        {series.map((s) => (
          <div className="tooltip-row" key={s.key}>
            <span>
              <i className="swatch" style={{ background: s.color }} /> {s.label}
            </span>
            <b>{s.format(row[s.key])}</b>
          </div>
        ))}
      </div>
    );
  };
}

/** Accessible table view of the same data as the chart. */
export function DataTable<T extends object>({
  rows,
  series,
  labelKey,
  labelHeader,
  formatLabel,
}: {
  rows: T[];
  series: SeriesDef[];
  labelKey: keyof T;
  labelHeader: string;
  formatLabel: (v: T[keyof T]) => string;
}) {
  return (
    <details>
      <summary>Show data table</summary>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>{labelHeader}</th>
              {series.map((s) => (
                <th key={s.key} className="num">{s.label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                <td>{formatLabel(r[labelKey])}</td>
                {series.map((s) => (
                  <td key={s.key} className="num">{s.format((r as Record<string, number | null>)[s.key])}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </details>
  );
}
