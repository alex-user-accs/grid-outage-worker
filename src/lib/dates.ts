// Local-time date helpers in the formats Deye's history endpoints expect.

const pad = (n: number) => String(n).padStart(2, "0");

export const ymd = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const ym = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;

export const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
export const addMonths = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth() + n, 1);

/** Deye timestamps arrive as seconds or milliseconds, as numbers or numeric strings, or as date strings. */
export function parseDeyeTime(v: string | number | null | undefined): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : /^\d+$/.test(v) ? Number(v) : NaN;
  if (!Number.isNaN(n)) return n < 1e12 ? n * 1000 : n;
  const t = Date.parse(String(v));
  return Number.isNaN(t) ? null : t;
}
