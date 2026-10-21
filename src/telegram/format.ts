import { parseDeyeTime } from "@/lib/dates";
import { fmtEnergy, fmtPower } from "@/lib/format";
import {
  getDaily,
  getDevices,
  getGridStatus,
  getLatest,
  getOutages,
  outageMinutes,
  signedBatteryPower,
  signedGridPower,
} from "@/lib/readModel";

// Telegram messages (HTML parse mode). Everything is read from SQLite: no Deye API calls.

export const esc = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export const hhmm = (ts: number) => new Date(ts).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
const dayHhmm = (ts: number, now = Date.now()) =>
  new Date(ts).toDateString() === new Date(now).toDateString()
    ? hhmm(ts)
    : new Date(ts).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

export function hm(ms: number): string {
  const m = Math.max(0, Math.round(ms / 60_000));
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
}

const LEVEL = ["Notice", "Warning", "Failure"];
const IMPACT = ["no impact", "affects production", "affects safety", "affects production & safety"];

interface Live {
  soc: number | null;
  load: number | null;
  pv: number | null;
  grid: number | null;
  battery: number | null;
  /** Energy left in the battery (kWh) and hours at the current load, when the inverter reports capacity. */
  storedKwh: number | null;
  hoursLeft: number | null;
  at: number | null;
}

const point = (list: { key: string; value?: string | number | null }[], re: RegExp) => {
  const v = list.find((p) => re.test(p.key))?.value;
  const n = v === null || v === undefined || v === "" ? NaN : Number(v);
  return Number.isFinite(n) ? n : null; // Deye sometimes sends "null" or "--" as a value
};

/** Freshest values: the inverter's 2-min sample, falling back to the 5-min station summary. */
export function liveValues(): Live {
  const inverter = getDevices()?.devices.find((d) => d.deviceType === "INVERTER" && d.latest);
  const list = inverter?.latest?.data.dataList ?? [];
  const st = getLatest()?.data;
  const soc = point(list, /^SOC$/i) ?? st?.batterySOC ?? null;
  const load = point(list, /^TotalConsumptionPower$/i) ?? st?.consumptionPower ?? null;
  const ah = point(list, /^BatteryRatedCapacity$/i);
  const volts = point(list, /^BatteryVoltage$/i);
  const storedKwh = ah && volts && soc !== null ? (ah * volts * soc) / 100 / 1000 : null;
  return {
    soc,
    load,
    pv: point(list, /^TotalDCInputPower$/i) ?? st?.generationPower ?? null,
    grid: point(list, /^TotalGridPower$/i) ?? (st ? signedGridPower(st) : null),
    battery: point(list, /^BatteryPower$/i) ?? (st ? signedBatteryPower(st) : null),
    storedKwh,
    hoursLeft: storedKwh && load && load > 50 ? (storedKwh * 1000) / load : null,
    at: parseDeyeTime(inverter?.latest?.data.collectionTime) ?? getLatest()?.ts ?? null,
  };
}

function batteryLine(l: Live, withLoad = true): string {
  if (l.soc === null) return "";
  const parts = [`🔋 Battery <b>${l.soc}%</b>`];
  if (l.storedKwh) parts.push(`≈ ${l.storedKwh.toFixed(1)} kWh`);
  if (withLoad && l.load !== null) parts.push(`load ${fmtPower(l.load)}`);
  let line = parts.join(" · ");
  if (l.hoursLeft) line += `\n⏳ ≈ ${hm(l.hoursLeft * 3_600_000)} to empty at this load <i>(rough estimate)</i>`;
  return line;
}

export interface EventRow {
  id: number;
  ts: number;
  type: string;
  payload: string;
}

/** Text for one queued event, or null if this type is not sent to Telegram. */
export function formatEvent(e: EventRow, now = Date.now(), live: Live = liveValues()): string | null {
  const p = JSON.parse(e.payload) as Record<string, any>;
  let text: string | null;
  switch (e.type) {
    case "grid_down":
      text = [
        `🔴 <b>Grid OFF</b> since ${dayHhmm(p.start, now)}`,
        batteryLine(live),
        p.monitoringStarted
          ? "<i>Was already off when monitoring started.</i>"
          : `<i>Noticed ${p.delaySec < 120 ? `${p.delaySec} s` : hm(p.delaySec * 1000)} after the inverter saw it.</i>`,
      ]
        .filter(Boolean)
        .join("\n");
      break;
    case "grid_up":
      text = [
        `🟢 <b>Grid is back</b> at ${dayHhmm(p.end, now)}`,
        `Outage lasted <b>${hm(p.end - p.start)}</b> (${dayHhmm(p.start, now)}–${hhmm(p.end)})`,
        live.soc !== null ? `🔋 Battery ${live.soc}%` : "",
      ]
        .filter(Boolean)
        .join("\n");
      break;
    case "grid_outage_missed":
      text = `🟡 <b>Short outage found</b> ${dayHhmm(p.start, now)}–${hhmm(p.end)} (${hm(p.end - p.start)})\n<i>It happened between live checks (night mode or a restart).</i>`;
      break;
    case "alert_opened":
      text = `⚠️ <b>Inverter alert:</b> ${esc(p.name ?? p.alertId)}\n${LEVEL[p.level] ?? "Level " + esc(p.level)} · ${IMPACT[p.impact] ?? ""}${p.deviceSn ? ` · device ${esc(p.deviceSn)}` : ""}`;
      break;
    case "alert_closed":
      text = `✅ Alert cleared: ${esc(p.name ?? p.alertId)}`;
      break;
    case "device_offline":
      text = `📡 <b>${esc(p.deviceType ?? "Device")} ${esc(p.deviceSn)} is offline</b>\nDeye gets no data from it. Check the logger's Wi-Fi and power.`;
      break;
    case "device_online":
      text = `📡 ${esc(p.deviceType ?? "Device")} ${esc(p.deviceSn)} is back online`;
      break;
    case "soc_low":
      text = `🪫 <b>Battery low: ${esc(p.soc)}%</b> (threshold ${esc(p.threshold)}%)`;
      break;
    case "soc_high":
      text = `🔋 Battery full: ${esc(p.soc)}%`;
      break;
    default:
      text = null;
  }
  if (text && now - e.ts > 10 * 60_000) text += `\n<i>(sent late; event at ${dayHhmm(e.ts, now)})</i>`;
  return text;
}

// ---------- command replies ----------

export function statusText(now = Date.now()): string {
  const g = getGridStatus();
  const l = liveValues();
  const gridLine =
    g.online === null
      ? "⚪️ Grid: unknown (no inverter data yet)"
      : g.online
        ? `🟢 Grid <b>online</b>${g.voltage ? ` · ${g.voltage} V` : ""}${g.since ? ` · since ${dayHhmm(g.since, now)}` : ""}`
        : `🔴 Grid <b>OFF</b> since ${g.since ? dayHhmm(g.since, now) : "?"} (${g.since ? hm(now - g.since) : "?"})`;
  const dir = (w: number | null, pos: string, neg: string) => (w === null ? "—" : w === 0 ? "idle" : `${w > 0 ? pos : neg} ${fmtPower(Math.abs(w))}`);
  return [
    gridLine,
    `☀️ Solar ${fmtPower(l.pv)} · 🏠 load ${fmtPower(l.load)}`,
    `🔌 Grid ${dir(l.grid, "import", "export")} · battery ${dir(l.battery, "discharging", "charging")}`,
    batteryLine(l, false), // load is already on the solar line
    l.at ? `<i>Inverter data from ${hhmm(l.at)}</i>` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export function outagesText(days = 7, now = Date.now()): string {
  const list = getOutages(days, now);
  if (!list.length) return `No grid outages in the last ${days} days. 🎉`;
  const total = outageMinutes(list, now - days * 86_400_000, now);
  const rows = list.slice(0, 20).map((o) => `• ${dayHhmm(o.start, now)} – ${o.end ? hhmm(o.end) : "<b>now</b>"} · ${hm((o.end ?? now) - o.start)}`);
  return [`<b>Grid outages, last ${days} days</b>: ${list.length}, ${hm(total * 60_000)} without grid`, ...rows].join("\n");
}

export function todayText(now = Date.now()): string {
  const d = getDaily(1, now).at(-1);
  const dayStart = new Date(now).setHours(0, 0, 0, 0);
  const outages = getOutages(1, now).filter((o) => (o.end ?? now) >= dayStart);
  return [
    "<b>Today</b>",
    `☀️ Generated ${fmtEnergy(d?.generation)}`,
    `🏠 Consumed ${fmtEnergy(d?.consumption)}`,
    `🔌 Bought ${fmtEnergy(d?.purchase)} · sold ${fmtEnergy(d?.feedIn)}`,
    `⚡️ Outages: ${outages.length}${outages.length ? `, ${hm(outageMinutes(outages, dayStart, now) * 60_000)} without grid` : ""}`,
  ].join("\n");
}

export const HELP_TEXT = [
  "<b>Deye station bot</b>",
  "/status: grid, solar, load, battery right now",
  "/outages: grid outages of the last 7 days",
  "/today: today's energy and outages",
  "",
  "You get a message when the grid goes off or comes back, on inverter alerts, devices going offline and battery thresholds. At night they arrive silently.",
].join("\n");
