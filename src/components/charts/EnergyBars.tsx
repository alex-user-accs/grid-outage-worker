"use client";

import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { fmtEnergy } from "@/lib/format";
import type { EnergyPoint } from "@/lib/repo";
import { AXIS_TICK, DataTable, Legend, type SeriesDef, makeTooltip } from "./common";

type Key = "generation" | "consumption" | "purchase" | "feedIn";
const ALL: Record<Key, SeriesDef<Key>> = {
  generation: { key: "generation", label: "Generation", color: "var(--series-1)", format: fmtEnergy },
  consumption: { key: "consumption", label: "Consumption", color: "var(--series-2)", format: fmtEnergy },
  purchase: { key: "purchase", label: "Grid purchase", color: "var(--series-3)", format: fmtEnergy },
  feedIn: { key: "feedIn", label: "Grid feed-in", color: "var(--series-3)", format: fmtEnergy },
};

const dayLabel = (v: unknown) => {
  const s = String(v);
  if (s.length === 7) return new Date(`${s}-01T00:00:00`).toLocaleDateString("en-GB", { month: "short", year: "2-digit" });
  return new Date(`${s}T00:00:00`).toLocaleDateString("en-GB", { day: "numeric", month: "short" });
};

export function EnergyBars({ data, keys, tableExtra = [] }: { data: EnergyPoint[]; keys: Key[]; tableExtra?: Key[] }) {
  if (!data.length) return <p className="empty">No energy history yet — the worker fetches it hourly.</p>;
  const series = keys.map((k) => ALL[k]);
  return (
    <>
      <Legend series={series} />
      <div className="chart">
        <ResponsiveContainer>
          <BarChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: 0 }} barGap={2} barCategoryGap="20%">
            <CartesianGrid stroke="var(--grid)" vertical={false} />
            <XAxis dataKey="label" tickFormatter={dayLabel} tick={AXIS_TICK} stroke="var(--axis)" minTickGap={16} />
            <YAxis tick={AXIS_TICK} stroke="var(--axis)" width={44} unit="" />
            <Tooltip content={makeTooltip([...series, ...tableExtra.map((k) => ALL[k])], dayLabel)} cursor={{ fill: "var(--surface-2)" }} />
            {series.map((s) => (
              <Bar key={s.key} dataKey={s.key} name={s.label} fill={s.color} radius={[4, 4, 0, 0]} isAnimationActive={false} maxBarSize={28} />
            ))}
          </BarChart>
        </ResponsiveContainer>
      </div>
      <div className="sub">Values in kWh.</div>
      <DataTable rows={data} series={[...series, ...tableExtra.map((k) => ALL[k])]} labelKey="label" labelHeader="Period" formatLabel={dayLabel} />
    </>
  );
}
