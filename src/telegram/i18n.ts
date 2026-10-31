// Telegram bot texts in Ukrainian and English. Units and number formats follow the language
// (uk: "1,77 кВт", "13,7 кВт·год"; en: "1.77 kW", "13.7 kWh").

export const LANGS = ["uk", "en"] as const;
export type Lang = (typeof LANGS)[number];

export const isLang = (v: unknown): v is Lang => typeof v === "string" && (LANGS as readonly string[]).includes(v);

const LOCALE: Record<Lang, string> = { uk: "uk-UA", en: "en-GB" };

const nf = (lang: Lang, max: number) => new Intl.NumberFormat(LOCALE[lang], { maximumFractionDigits: max });

export function num(v: number, lang: Lang, maxDigits = 1): string {
  return nf(lang, maxDigits).format(v);
}

export function power(w: number | null | undefined, lang: Lang): string {
  if (w == null) return "—";
  const [W, kW] = lang === "uk" ? ["Вт", "кВт"] : ["W", "kW"];
  return Math.abs(w) >= 1000 ? `${nf(lang, 2).format(w / 1000)} ${kW}` : `${nf(lang, 0).format(w)} ${W}`;
}

export function energy(kwh: number | null | undefined, lang: Lang): string {
  if (kwh == null) return "—";
  const [kWh, MWh] = lang === "uk" ? ["кВт·год", "МВт·год"] : ["kWh", "MWh"];
  return Math.abs(kwh) >= 1000 ? `${nf(lang, 2).format(kwh / 1000)} ${MWh}` : `${nf(lang, 1).format(kwh)} ${kWh}`;
}

/** "1 h 5 min" / "1 год 5 хв" */
export function hm(ms: number, lang: Lang = "en"): string {
  const m = Math.max(0, Math.round(ms / 60_000));
  const [h, min] = lang === "uk" ? ["год", "хв"] : ["h", "min"];
  return m < 60 ? `${m} ${min}` : `${Math.floor(m / 60)} ${h} ${m % 60} ${min}`;
}

export const hhmm = (ts: number, lang: Lang = "en") => new Date(ts).toLocaleTimeString(LOCALE[lang], { hour: "2-digit", minute: "2-digit" });

/** Time only for today, date + time otherwise. */
export const when = (ts: number, now: number, lang: Lang) =>
  new Date(ts).toDateString() === new Date(now).toDateString()
    ? hhmm(ts, lang)
    : new Date(ts).toLocaleString(LOCALE[lang], { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });

const UK = {
  battery: (soc: number) => `🔋 Батарея <b>${soc}%</b>`,
  load: (p: string) => `навантаження ${p}`,
  runtime: (d: string) => `⏳ ≈ ${d} до розряду при такому навантаженні <i>(приблизно)</i>`,

  gridDown: (at: string) => `🔴 <b>Світло зникло</b> о ${at}`,
  alreadyOff: "<i>Світла вже не було, коли запустився моніторинг.</i>",
  noticed: (d: string) => `<i>Помічено через ${d} після того, як це зафіксував інвертор.</i>`,
  seconds: (s: number) => `${s} с`,
  gridUp: (at: string) => `🟢 <b>Світло повернулося</b> о ${at}`,
  lasted: (d: string, from: string, to: string) => `Без світла: <b>${d}</b> (${from}–${to})`,
  batteryShort: (soc: number) => `🔋 Батарея ${soc}%`,
  missed: (from: string, to: string, d: string) =>
    `🟡 <b>Виявлено коротке відключення</b> ${from}–${to} (${d})\n<i>Воно сталося між перевірками (нічний режим або перезапуск сервера).</i>`,
  alert: (name: string) => `⚠️ <b>Помилка інвертора:</b> ${name}`,
  levels: ["Сповіщення", "Попередження", "Збій"],
  impacts: ["без впливу", "впливає на генерацію", "впливає на безпеку", "впливає на генерацію та безпеку"],
  device: (sn: string) => `пристрій ${sn}`,
  alertCleared: (name: string) => `✅ Помилку усунено: ${name}`,
  offline: (dev: string) => `📡 <b>${dev} не на зв'язку</b>\nDeye не отримує від нього даних. Перевірте Wi-Fi та живлення логера.`,
  online: (dev: string) => `📡 ${dev} знову на зв'язку`,
  deviceName: "Пристрій",
  socLow: (soc: string, thr: string) => `🪫 <b>Низький заряд батареї: ${soc}%</b> (поріг ${thr}%)`,
  socHigh: (soc: string) => `🔋 Батарея заряджена: ${soc}%`,
  resumed: (d: string, at: string) =>
    `🔄 <b>Моніторинг відновлено</b> після перерви ${d} (зупинився о ${at})\n<i>Сервер спав, був вимкнений або перезапускався. Відключення за цей час буде знайдено в історії протягом години.</i>`,
  late: (at: string) => `<i>(надіслано із затримкою; подія о ${at})</i>`,

  gridUnknown: "⚪️ Світло: невідомо (ще немає даних інвертора)",
  gridOn: (v: string, since: string) => `🟢 Світло <b>є</b>${v}${since ? ` · з ${since}` : ""}`,
  gridOff: (since: string, d: string) => `🔴 Світла <b>немає</b> з ${since} (${d})`,
  volts: (v: string) => ` · ${v} В`,
  solarLoad: (pv: string, load: string) => `☀️ Сонце ${pv} · 🏠 споживання ${load}`,
  flows: (grid: string, batt: string) => `🔌 Мережа: ${grid} · батарея: ${batt}`,
  imp: "імпорт",
  exp: "експорт",
  dis: "розряд",
  chg: "заряд",
  idle: "0",
  dataAt: (t: string) => `<i>Дані інвертора о ${t}</i>`,

  noOutages: (days: number) => `Відключень за останні ${days} днів не було. 🎉`,
  outagesHead: (days: number, n: number, d: string) => `<b>Відключення за ${days} днів</b>: ${n}, без світла ${d}`,
  now: "<b>зараз</b>",

  today: "<b>Сьогодні</b>",
  generated: (e: string) => `☀️ Згенеровано ${e}`,
  consumed: (e: string) => `🏠 Спожито ${e}`,
  traded: (b: string, s: string) => `🔌 Куплено ${b} · продано ${s}`,
  outagesToday: (n: number, d: string) => `⚡️ Відключення: ${n}${d ? `, без світла ${d}` : ""}`,

  help: [
    "<b>Бот сонячної станції Deye</b>",
    "/status — світло, сонце, споживання, батарея зараз",
    "/outages — відключення за останні 7 днів",
    "/today — енергія та відключення за сьогодні",
    "/lang — мова: українська / English",
    "",
    "Повідомлення приходять, коли світло зникає або повертається, про помилки інвертора, втрату зв'язку з пристроями та рівень заряду батареї. Вночі — без звуку.",
  ].join("\n"),
  welcome: "👋 <b>Вітаю!</b> Цей чат підключено до сповіщень сонячної станції. Відтепер повідомлення приходитимуть сюди.",
  stranger: (chat: string) =>
    `Це приватний бот.\nВаш chat id: <code>${chat}</code>.\nЩоб отримувати сповіщення, додайте його в <code>TELEGRAM_CHAT_IDS</code> у файлі .env на сервері.`,
  langSet: "Мову змінено: українська 🇺🇦\n/lang en — switch to English",
  commands: {
    status: "Світло, сонце, споживання, батарея зараз",
    outages: "Відключення за 7 днів",
    today: "Енергія та відключення сьогодні",
    lang: "Мова / Language",
    help: "Що вміє бот",
  },
};

export type Texts = typeof UK;

const EN: Texts = {
  battery: (soc) => `🔋 Battery <b>${soc}%</b>`,
  load: (p) => `load ${p}`,
  runtime: (d) => `⏳ ≈ ${d} to empty at this load <i>(rough estimate)</i>`,

  gridDown: (at) => `🔴 <b>Grid OFF</b> since ${at}`,
  alreadyOff: "<i>Was already off when monitoring started.</i>",
  noticed: (d) => `<i>Noticed ${d} after the inverter saw it.</i>`,
  seconds: (s) => `${s} s`,
  gridUp: (at) => `🟢 <b>Grid is back</b> at ${at}`,
  lasted: (d, from, to) => `Outage lasted <b>${d}</b> (${from}–${to})`,
  batteryShort: (soc) => `🔋 Battery ${soc}%`,
  missed: (from, to, d) => `🟡 <b>Short outage found</b> ${from}–${to} (${d})\n<i>It happened between live checks (night mode or a restart).</i>`,
  alert: (name) => `⚠️ <b>Inverter alert:</b> ${name}`,
  levels: ["Notice", "Warning", "Failure"],
  impacts: ["no impact", "affects production", "affects safety", "affects production & safety"],
  device: (sn) => `device ${sn}`,
  alertCleared: (name) => `✅ Alert cleared: ${name}`,
  offline: (dev) => `📡 <b>${dev} is offline</b>\nDeye gets no data from it. Check the logger's Wi-Fi and power.`,
  online: (dev) => `📡 ${dev} is back online`,
  deviceName: "Device",
  socLow: (soc, thr) => `🪫 <b>Battery low: ${soc}%</b> (threshold ${thr}%)`,
  socHigh: (soc) => `🔋 Battery full: ${soc}%`,
  resumed: (d, at) =>
    `🔄 <b>Monitoring resumed</b> after ${d} (stopped at ${at})\n<i>The server was asleep, off or restarting. Outages in that gap are recovered from history within the hour.</i>`,
  late: (at) => `<i>(sent late; event at ${at})</i>`,

  gridUnknown: "⚪️ Grid: unknown (no inverter data yet)",
  gridOn: (v, since) => `🟢 Grid <b>online</b>${v}${since ? ` · since ${since}` : ""}`,
  gridOff: (since, d) => `🔴 Grid <b>OFF</b> since ${since} (${d})`,
  volts: (v) => ` · ${v} V`,
  solarLoad: (pv, load) => `☀️ Solar ${pv} · 🏠 load ${load}`,
  flows: (grid, batt) => `🔌 Grid ${grid} · battery ${batt}`,
  imp: "import",
  exp: "export",
  dis: "discharging",
  chg: "charging",
  idle: "idle",
  dataAt: (t) => `<i>Inverter data from ${t}</i>`,

  noOutages: (days) => `No grid outages in the last ${days} days. 🎉`,
  outagesHead: (days, n, d) => `<b>Grid outages, last ${days} days</b>: ${n}, ${d} without grid`,
  now: "<b>now</b>",

  today: "<b>Today</b>",
  generated: (e) => `☀️ Generated ${e}`,
  consumed: (e) => `🏠 Consumed ${e}`,
  traded: (b, s) => `🔌 Bought ${b} · sold ${s}`,
  outagesToday: (n, d) => `⚡️ Outages: ${n}${d ? `, ${d} without grid` : ""}`,

  help: [
    "<b>Deye station bot</b>",
    "/status: grid, solar, load, battery right now",
    "/outages: grid outages of the last 7 days",
    "/today: today's energy and outages",
    "/lang: language, Українська / English",
    "",
    "You get a message when the grid goes off or comes back, on inverter alerts, devices going offline and battery thresholds. At night they arrive silently.",
  ].join("\n"),
  welcome: "👋 <b>Welcome!</b> This chat is now connected to the solar station notifications. Messages will arrive here from now on.",
  stranger: (chat) =>
    `This is a private bot.\nYour chat id is <code>${chat}</code>.\nTo receive notifications, add it to <code>TELEGRAM_CHAT_IDS</code> in the server's .env.`,
  langSet: "Language set: English 🇬🇧\n/lang uk — українською",
  commands: {
    status: "Grid, solar, load and battery now",
    outages: "Grid outages, last 7 days",
    today: "Today's energy and outages",
    lang: "Language / Мова",
    help: "What this bot does",
  },
};

export const T: Record<Lang, Texts> = { uk: UK, en: EN };
