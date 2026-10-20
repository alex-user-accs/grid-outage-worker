"use client";

import { CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { fmtPower } from "@/lib/format";
import type { PowerPoint } from "@/lib/repo";
import { AXIS_TICK, DataTable, Legend, type SeriesDef, makeTooltip } from "./common";

const POWER: SeriesDef<"pv" | "load" | "grid" | "battery">[] = [
  { key: "pv", label: "Solar", color: "var(--series-1)", format: fmtPower },
  { key: "load", label: "Load", color: "var(--series-2)", format: fmtPower },
  { key: "grid", label: "Grid", color: "var(--series-3)", format: fmtPower },
  { key: "battery", label: "Battery", color: "var(--series-4)", format: fmtPower },
];
const SOC: SeriesDef<"soc">[] = [{ key: "soc", label: "Battery SOC", color: "var(--series-4)", format: (v) => (v == null ? "—" : `${v}%`) }];

const hhmm = (t: unknown) => new Date(Number(t)).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
const kw = (v: number) => (Math.abs(v) >= 1000 ? `${v / 1000}k` : String(v));

export function TodayPowerChart({ data }: { data: PowerPoint[] }) {
  if (!data.length) return <p className="empty">No intraday data yet — the worker fetches it every 10 minutes.</p>;
  const hasSoc = data.some((d) => d.soc != null);
  return (
    <>
      <Legend series={POWER} />
      <div className="chart">
        <ResponsiveContainer>
          <LineChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: 0 }}>
            <CartesianGrid stroke="var(--grid)" vertical={false} />
            <XAxis dataKey="t" type="number" scale="time" domain={["dataMin", "dataMax"]} tickFormatter={hhmm} tick={AXIS_TICK} stroke="var(--axis)" minTickGap={40} />
            <YAxis tickFormatter={kw} tick={AXIS_TICK} stroke="var(--axis)" width={56} unit="W" />
            <ReferenceLine y={0} stroke="var(--axis)" />
            <Tooltip content={makeTooltip(POWER, hhmm)} cursor={{ stroke: "var(--axis)" }} />
            {POWER.map((s) => (
              <Line key={s.key} dataKey={s.key} name={s.label} stroke={s.color} strokeWidth={2} dot={false} type="monotone" isAnimationActive={false} connectNulls />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
      {hasSoc && (
        <>
          <div className="sub">Battery state of charge (separate chart: different unit)</div>
          <div className="chart small">
            <ResponsiveContainer>
              <LineChart data={data} margin={{ top: 4, right: 12, bottom: 0, left: 0 }}>
                <CartesianGrid stroke="var(--grid)" vertical={false} />
                <XAxis dataKey="t" type="number" scale="time" domain={["dataMin", "dataMax"]} tickFormatter={hhmm} tick={AXIS_TICK} stroke="var(--axis)" minTickGap={40} />
                <YAxis domain={[0, 100]} ticks={[0, 50, 100]} tick={AXIS_TICK} stroke="var(--axis)" width={56} unit="%" />
                <Tooltip content={makeTooltip(SOC, hhmm)} cursor={{ stroke: "var(--axis)" }} />
                <Line dataKey="soc" stroke="var(--series-4)" strokeWidth={2} dot={false} type="monotone" isAnimationActive={false} connectNulls />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </>
      )}
      <DataTable rows={data} series={[...POWER, ...SOC]} labelKey="t" labelHeader="Time" formatLabel={hhmm} />
    </>
  );
}
