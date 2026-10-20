const nf1 = new Intl.NumberFormat("en-GB", { maximumFractionDigits: 1 });
const nf2 = new Intl.NumberFormat("en-GB", { maximumFractionDigits: 2 });
const nf0 = new Intl.NumberFormat("en-GB", { maximumFractionDigits: 0 });

export const fmtInt = (n: number) => nf0.format(n);

/** Deye station power values are in W. */
export function fmtPower(w: number | null | undefined): string {
  if (w == null) return "—";
  return Math.abs(w) >= 1000 ? `${nf2.format(w / 1000)} kW` : `${nf0.format(w)} W`;
}

/** Deye station energy values are in kWh. */
export function fmtEnergy(kwh: number | null | undefined): string {
  if (kwh == null) return "—";
  return Math.abs(kwh) >= 1000 ? `${nf2.format(kwh / 1000)} MWh` : `${nf1.format(kwh)} kWh`;
}

export function fmtDateTime(ts: number | null | undefined): string {
  if (!ts) return "—";
  return new Date(ts).toLocaleString("en-GB", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}

export function fmtAgo(ts: number | null | undefined, now = Date.now()): string {
  if (!ts) return "never";
  const s = Math.round((now - ts) / 1000);
  if (s < 0) return `in ${fmtDuration(-s * 1000)}`;
  if (s < 60) return `${s}s ago`;
  return `${fmtDuration(s * 1000)} ago`;
}

export function fmtDuration(ms: number): string {
  const m = Math.round(ms / 60_000);
  if (m < 60) return `${m} min`;
  const h = Math.round(m / 60);
  return h < 48 ? `${h} h` : `${Math.round(h / 24)} d`;
}
