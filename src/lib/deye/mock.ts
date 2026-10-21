import type { DeviceHistorySample, DeyeApi, DeviceLatestItem, Granularity, Station, StationAlert, StationDataItem, StationDevice, StationLatest } from "./types";

// Deterministic fake data for DEYE_MOCK=1: a ~10 kWp hybrid system with a battery.
// Lets the UI and worker run end-to-end without spending a single API call.

const STATION_ID = 1001;
// Like the real logger: one sample every 120 s, visible ~45 s later. A grid outage every day 08:20–09:05.
const SAMPLE_MS = 120_000;
const VISIBLE_MS = 45_000;
const latestSampleAt = (now: number) => Math.floor((now - VISIBLE_MS) / SAMPLE_MS) * SAMPLE_MS;

function gridAt(ts: number): { voltage: string; frequency: string } {
  const d = new Date(ts);
  const m = d.getHours() * 60 + d.getMinutes();
  return m >= 8 * 60 + 20 && m < 9 * 60 + 5 ? { voltage: "2.70", frequency: "0.00" } : { voltage: "229.40", frequency: "50.01" };
}
const PEAK_W = 8500;

function pvAt(ts: number): number {
  const d = new Date(ts);
  const h = d.getHours() + d.getMinutes() / 60;
  if (h < 6 || h > 20) return 0;
  const clouds = 0.8 + 0.2 * Math.sin(ts / 1_700_000);
  return Math.round(PEAK_W * Math.sin(((h - 6) / 14) * Math.PI) ** 1.6 * clouds);
}

function loadAt(ts: number): number {
  const h = new Date(ts).getHours();
  const base = h >= 18 && h <= 22 ? 1800 : h >= 7 && h <= 9 ? 1400 : 550;
  return Math.round(base + 250 * Math.sin(ts / 900_000));
}

function socAt(ts: number): number {
  const h = new Date(ts).getHours() + new Date(ts).getMinutes() / 60;
  if (h < 8) return Math.round(55 - (h / 8) * 30);
  if (h < 15) return Math.round(25 + ((h - 8) / 7) * 75);
  return Math.round(100 - ((h - 15) / 9) * 45);
}

function frame(ts: number): StationDataItem {
  const pv = pvAt(ts);
  const load = loadAt(ts);
  const soc = socAt(ts);
  const battery = soc >= 100 ? 0 : pv > load ? -(pv - load) * 0.7 : Math.min(load - pv, 3000) * 0.6; // + discharge, - charge
  const grid = load - pv - battery; // + import, - export
  return {
    generationPower: pv,
    consumptionPower: load,
    // Like the real API for hybrid inverters: signed grid power in wirePower, gridPower/purchasePower empty.
    gridPower: null,
    purchasePower: null,
    wirePower: Math.round(grid),
    batteryPower: Math.round(battery),
    chargePower: Math.max(0, Math.round(-battery)),
    dischargePower: Math.max(0, Math.round(battery)),
    batterySOC: soc,
    timeStamp: String(Math.floor(ts / 1000)),
  };
}

function dayEnergy(date: Date): StationDataItem {
  const seed = date.getFullYear() * 400 + date.getMonth() * 31 + date.getDate();
  const season = 0.55 + 0.45 * Math.sin(((date.getMonth() + 1 - 3) / 12) * 2 * Math.PI);
  const weather = 0.6 + 0.4 * Math.abs(Math.sin(seed * 12.9898));
  const gen = +(48 * season * weather).toFixed(1);
  const cons = +(19 + 6 * Math.abs(Math.cos(seed))).toFixed(1);
  const purchase = +Math.max(1.5, cons - gen * 0.55).toFixed(1);
  return {
    generationValue: gen,
    consumptionValue: cons,
    purchaseValue: purchase,
    gridValue: +Math.max(0, gen - cons + purchase - 4).toFixed(1),
    chargeValue: +(gen * 0.2).toFixed(1),
    dischargeValue: +(gen * 0.18).toFixed(1),
    year: date.getFullYear(),
    month: date.getMonth() + 1,
    day: date.getDate(),
  };
}

function sum(items: StationDataItem[], extra: Partial<StationDataItem>): StationDataItem {
  const keys = ["generationValue", "consumptionValue", "purchaseValue", "gridValue", "chargeValue", "dischargeValue"] as const;
  const out: StationDataItem = { ...extra };
  for (const k of keys) out[k] = +items.reduce((a, i) => a + (i[k] ?? 0), 0).toFixed(1);
  return out;
}

function daysOfMonth(year: number, month0: number, upTo: Date): StationDataItem[] {
  const out = [];
  for (let d = new Date(year, month0, 1); d.getMonth() === month0 && d <= upTo; d.setDate(d.getDate() + 1)) out.push(dayEnergy(new Date(d)));
  return out;
}

export class MockDeyeClient implements DeyeApi {
  constructor(private readonly now: () => number = Date.now) {}

  async stationList(): Promise<Station[]> {
    return [{ id: STATION_ID, name: "Demo Home (mock)", installedCapacity: 10.2, regionTimezone: "Europe/Kyiv", startOperatingTime: "1672531200" }];
  }

  async stationLatest(): Promise<StationLatest> {
    const now = this.now();
    return { code: "1000000", msg: "success", success: true, ...frame(now), lastUpdateTime: String(Math.floor(now / 1000)) } as StationLatest;
  }

  async stationHistory(_id: number, g: Granularity, startAt: string, endAt?: string): Promise<StationDataItem[]> {
    const now = new Date(this.now());
    if (g === 1) {
      const [y, m, d] = startAt.split("-").map(Number);
      const out = [];
      for (let ts = new Date(y, m - 1, d).getTime(); ts < new Date(y, m - 1, d + 1).getTime() && ts <= now.getTime(); ts += 5 * 60_000) out.push(frame(ts));
      return out;
    }
    if (g === 2) {
      const start = new Date(startAt + "T00:00:00");
      const end = new Date((endAt ?? startAt) + "T00:00:00");
      const out = [];
      for (const d = new Date(start); d < end && d <= now; d.setDate(d.getDate() + 1)) out.push(dayEnergy(new Date(d)));
      return out;
    }
    if (g === 3) {
      const [y, m0] = startAt.split("-").map(Number);
      const [, m1] = (endAt ?? startAt).split("-").map(Number);
      const out = [];
      for (let m = m0; m <= m1; m++) {
        if (new Date(y, m - 1, 1) > now) break;
        out.push(sum(daysOfMonth(y, m - 1, now), { year: y, month: m }));
      }
      return out;
    }
    const out = [];
    for (let y = Number(startAt); y <= Number(endAt ?? startAt) && y <= now.getFullYear(); y++) {
      const months = [];
      for (let m = 0; m < 12; m++) months.push(sum(daysOfMonth(y, m, now), {}));
      out.push(sum(months, { year: y }));
    }
    return out;
  }

  async stationDevices(): Promise<StationDevice[]> {
    const t = Math.floor(this.now() / 1000);
    return [
      { deviceSn: "MOCK-INV-0001", deviceType: "INVERTER", stationId: STATION_ID, productId: "0_5407_1", connectStatus: 1, collectionTime: t },
      { deviceSn: "MOCK-LOG-0001", deviceType: "COLLECTOR", stationId: STATION_ID, connectStatus: 1, collectionTime: t },
      { deviceSn: "MOCK-BAT-0001", deviceType: "BATTERY", stationId: STATION_ID, connectStatus: 1, collectionTime: t },
    ];
  }

  async deviceLatest(sns: string[]): Promise<DeviceLatestItem[]> {
    const sampleAt = latestSampleAt(this.now());
    const f = frame(sampleAt);
    const g = gridAt(sampleAt);
    const t = Math.floor(sampleAt / 1000);
    return sns.map((deviceSn) => ({
      deviceSn,
      deviceType: deviceSn.includes("BAT") ? "BATTERY" : "INVERTER",
      deviceState: 1,
      collectionTime: t,
      dataList: deviceSn.includes("BAT")
        ? [
            { key: "SOC", value: String(f.batterySOC), unit: "%" },
            { key: "BatteryVoltage", value: "52.4", unit: "V" },
            { key: "BatteryPower", value: String(f.batteryPower), unit: "W" },
            { key: "BatteryTemperature", value: "24.0", unit: "℃" },
          ]
        : [
            { key: "TotalSolarPower", value: String(f.generationPower), unit: "W" },
            { key: "TotalConsumptionPower", value: String(f.consumptionPower), unit: "W" },
            { key: "TotalGridPower", value: String(f.gridPower), unit: "W" },
            { key: "GridVoltageL1L2", value: g.voltage, unit: "V" },
            { key: "GridFrequency", value: g.frequency, unit: "Hz" },
            { key: "DCTemperature", value: "41.5", unit: "℃" },
            { key: "DailyActiveProduction", value: "21.4", unit: "kWh" },
          ],
    }));
  }

  async stationAlerts(): Promise<StationAlert[]> {
    const t = Math.floor(this.now() / 1000);
    return [
      { alertId: "mock-1", alertName: "Grid voltage high (mock)", alertCode: "W12", protocolName: "W12", deviceSn: "MOCK-INV-0001", level: 1, impact: 1, status: 0, alertStartTime: t - 86400 * 2, alertEndTime: t - 86400 * 2 + 1200 },
    ];
  }

  async deviceHistoryDay(_sn: string, day: string, measurePoints: string[]): Promise<DeviceHistorySample[]> {
    const [y, m, d] = day.split("-").map(Number);
    const end = Math.min(new Date(y, m - 1, d + 1).getTime(), latestSampleAt(this.now()) + 1);
    const out: DeviceHistorySample[] = [];
    for (let ts = new Date(y, m - 1, d).getTime(); ts < end; ts += SAMPLE_MS) {
      const g = gridAt(ts);
      out.push({
        time: String(Math.floor(ts / 1000)),
        itemList: measurePoints.map((key) => ({ key, value: /Frequency/i.test(key) ? g.frequency : g.voltage, unit: /Frequency/i.test(key) ? "Hz" : "V" })),
      });
    }
    return out;
  }
}
