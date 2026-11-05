import { parseDeyeTime } from "@/lib/dates";
import {
  dataPoint,
  getDevices,
  getGridStatus,
  getLatest,
  getOutages,
  getTodayEnergy,
  outageMinutes,
  signedBatteryPower,
  signedGridPower,
} from "@/lib/readModel";
import { type Lang, T, energy, hhmm, hm, num, power, when } from "./i18n";

// Telegram messages (HTML parse mode) in the chat's language. Everything is read from SQLite: no Deye API calls.

export { hm } from "./i18n";

export const esc = (s: unknown) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export interface Live {
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

const point = dataPoint;

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

function batteryLine(l: Live, lang: Lang, withLoad = true): string {
  if (l.soc === null) return "";
  const t = T[lang];
  const parts = [t.battery(l.soc)];
  if (l.storedKwh) parts.push(`≈ ${energy(l.storedKwh, lang)}`);
  if (withLoad && l.load !== null) parts.push(t.load(power(l.load, lang)));
  let line = parts.join(" · ");
  if (l.hoursLeft) line += `\n${t.runtime(hm(l.hoursLeft * 3_600_000, lang))}`;
  return line;
}

export interface EventRow {
  id: number;
  ts: number;
  type: string;
  payload: string;
}

/** Text for one queued event, or null if this type is not sent to Telegram. */
export function formatEvent(e: EventRow, now = Date.now(), live: Live = liveValues(), lang: Lang = "en"): string | null {
  const t = T[lang];
  const p = JSON.parse(e.payload) as Record<string, any>;
  const at = (ts: number) => when(ts, now, lang);
  const dev = () => `${esc(p.deviceType ?? t.deviceName)} ${esc(p.deviceSn)}`;
  let text: string | null;
  switch (e.type) {
    case "grid_down":
      text = [
        t.gridDown(at(p.start)),
        batteryLine(live, lang),
        p.monitoringStarted ? t.alreadyOff : t.noticed(p.delaySec < 120 ? t.seconds(p.delaySec) : hm(p.delaySec * 1000, lang)),
      ]
        .filter(Boolean)
        .join("\n");
      break;
    case "grid_up":
      text = [t.gridUp(at(p.end)), t.lasted(hm(p.end - p.start, lang), at(p.start), hhmm(p.end, lang)), live.soc !== null ? t.batteryShort(live.soc) : ""]
        .filter(Boolean)
        .join("\n");
      break;
    case "grid_outage_missed":
      text = t.missed(at(p.start), hhmm(p.end, lang), hm(p.end - p.start, lang));
      break;
    case "alert_opened":
      text = `${t.alert(esc(p.name ?? p.alertId))}\n${t.levels[p.level] ?? esc(p.level)} · ${t.impacts[p.impact] ?? ""}${p.deviceSn ? ` · ${t.device(esc(p.deviceSn))}` : ""}`;
      break;
    case "alert_closed":
      text = t.alertCleared(esc(p.name ?? p.alertId));
      break;
    case "device_offline":
      text = t.offline(dev());
      break;
    case "device_online":
      text = t.online(dev());
      break;
    case "soc_low":
      text = t.socLow(esc(p.soc), esc(p.threshold));
      break;
    case "soc_high":
      text = t.socHigh(esc(p.soc));
      break;
    case "monitoring_resumed":
      text = t.resumed(hm(p.downMin * 60_000, lang), at(p.downSince));
      break;
    default:
      text = null;
  }
  if (text && now - e.ts > 10 * 60_000) text += `\n${t.late(at(e.ts))}`;
  return text;
}

// ---------- command replies ----------

export function statusText(now = Date.now(), lang: Lang = "en"): string {
  const t = T[lang];
  const g = getGridStatus();
  const l = liveValues();
  const gridLine =
    g.online === null
      ? t.gridUnknown
      : g.online
        ? t.gridOn(g.voltage ? t.volts(num(g.voltage, lang)) : "", g.since ? when(g.since, now, lang) : "")
        : t.gridOff(g.since ? when(g.since, now, lang) : "?", g.since ? hm(now - g.since, lang) : "?");
  const dir = (w: number | null, pos: string, neg: string) => (w === null ? "—" : w === 0 ? t.idle : `${w > 0 ? pos : neg} ${power(Math.abs(w), lang)}`);
  return [
    gridLine,
    t.solarLoad(power(l.pv, lang), power(l.load, lang)),
    t.flows(dir(l.grid, t.imp, t.exp), dir(l.battery, t.dis, t.chg)),
    batteryLine(l, lang, false), // load is already on the solar line
    l.at ? t.dataAt(hhmm(l.at, lang)) : "",
  ]
    .filter(Boolean)
    .join("\n");
}

export function outagesText(days = 7, now = Date.now(), lang: Lang = "en"): string {
  const t = T[lang];
  const list = getOutages(days, now);
  if (!list.length) return t.noOutages(days);
  const total = outageMinutes(list, now - days * 86_400_000, now);
  const rows = list.slice(0, 20).map((o) => `• ${when(o.start, now, lang)} – ${o.end ? hhmm(o.end, lang) : t.now} · ${hm((o.end ?? now) - o.start, lang)}`);
  return [t.outagesHead(days, list.length, hm(total * 60_000, lang)), ...rows].join("\n");
}

export function todayText(now = Date.now(), lang: Lang = "en"): string {
  const t = T[lang];
  const d = getTodayEnergy(now);
  const dayStart = new Date(now).setHours(0, 0, 0, 0);
  const outages = getOutages(1, now).filter((o) => (o.end ?? now) >= dayStart);
  return [
    t.today,
    t.generated(energy(d?.generation, lang)),
    t.consumed(energy(d?.consumption, lang)),
    t.traded(energy(d?.purchase, lang), energy(d?.feedIn, lang)),
    t.outagesToday(outages.length, outages.length ? hm(outageMinutes(outages, dayStart, now) * 60_000, lang) : ""),
  ].join("\n");
}

export const helpText = (lang: Lang = "en") => T[lang].help;
