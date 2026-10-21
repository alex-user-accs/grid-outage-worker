import { AutoRefresh } from "@/components/AutoRefresh";
import { WorkerBanner } from "@/components/WorkerBanner";
import { EnergyBars } from "@/components/charts/EnergyBars";
import { TodayPowerChart } from "@/components/charts/TodayPowerChart";
import { parseDeyeTime } from "@/lib/dates";
import { fmtAgo, fmtDateTime, fmtDuration, fmtEnergy, fmtPower } from "@/lib/format";
import {
  getAlerts,
  getDaily,
  getGridStatus,
  getLatest,
  getLifetime,
  getMonthly,
  getOutages,
  getStation,
  getTodayCurve,
  getWorkerStatus,
  outageMinutes,
  signedBatteryPower,
  signedGridPower,
} from "@/lib/repo";

export const dynamic = "force-dynamic";

const LEVEL = ["Notice", "Warning", "Failure"] as const;
const LEVEL_CLASS = ["good", "warning", "critical"] as const;
const IMPACT = ["None", "Production", "Safety", "Production & safety"] as const;

function Tile({ label, value, note, color, children }: { label: string; value: string; note?: string; color?: string; children?: React.ReactNode }) {
  return (
    <div className="tile">
      <div className="tile-label">
        {color && <i className="swatch" style={{ background: color }} />}
        {label}
      </div>
      <div className="tile-value">{value}</div>
      {children}
      {note && <div className="tile-note">{note}</div>}
    </div>
  );
}

export default function Dashboard() {
  const station = getStation();
  const latest = getLatest();
  const daily = getDaily(30);
  const monthly = getMonthly(12);
  const lifetime = getLifetime();
  const alerts = getAlerts(20);
  const { pause } = getWorkerStatus();
  const l = latest?.data;
  const today = daily.at(-1);
  const updated = parseDeyeTime(l?.lastUpdateTime) ?? latest?.ts ?? null;
  const openAlerts = alerts.filter((a) => a.status === 1);
  const now = Date.now();
  const gridStatus = getGridStatus();
  const outages = getOutages(30, now);
  const dayStart = new Date(now).setHours(0, 0, 0, 0);
  const todayOutages = outages.filter((o) => (o.end ?? now) >= dayStart);

  const grid = l ? signedGridPower(l) : null;
  const battery = l ? signedBatteryPower(l) : null;
  const gridNote = grid == null ? undefined : grid > 0 ? "importing" : grid < 0 ? "exporting" : "idle";
  const batteryNote = !battery ? "idle" : `${battery < 0 ? "charging" : "discharging"} ${fmtPower(Math.abs(battery))}`;

  return (
    <>
      <AutoRefresh everyMs={60_000} />
      <div className="page-head">
        <div>
          <h1>{station?.name ?? "Solar station"}</h1>
          <div className="sub">
            {station?.installedCapacity ? `${station.installedCapacity} kWp · ` : ""}
            Last update {fmtDateTime(updated)} ({fmtAgo(updated)})
          </div>
        </div>
        {openAlerts.length > 0 && <span className="badge critical">{openAlerts.length} open alert(s)</span>}
      </div>

      <WorkerBanner pause={pause} hasData={!!latest} />

      <GridBanner status={gridStatus} />

      <section className="tiles" aria-label="Live values">
        <Tile label="Solar" value={fmtPower(l?.generationPower)} color="var(--series-1)" note={station?.installedCapacity ? `of ${station.installedCapacity} kWp` : undefined} />
        <Tile label="Home load" value={fmtPower(l?.consumptionPower)} color="var(--series-2)" />
        <Tile label="Grid" value={fmtPower(grid == null ? null : Math.abs(grid))} color="var(--series-3)" note={gridNote} />
        <Tile label="Battery" value={l?.batterySOC != null ? `${l.batterySOC}%` : "—"} color="var(--series-4)" note={batteryNote}>
          {l?.batterySOC != null && (
            <div className="meter" role="meter" aria-valuenow={l.batterySOC} aria-valuemin={0} aria-valuemax={100} aria-label="Battery state of charge">
              <span style={{ width: `${Math.min(100, Math.max(0, l.batterySOC))}%` }} />
            </div>
          )}
        </Tile>
        <Tile label="Generated today" value={fmtEnergy(today?.generation)} note={today ? `used ${fmtEnergy(today.consumption)}` : undefined} />
        <Tile label="Lifetime generation" value={fmtEnergy(lifetime?.generation)} note={lifetime ? `over ${lifetime.years} year(s)` : undefined} />
      </section>

      <section className="card">
        <div className="card-head">
          <h2>Today’s power</h2>
          <span className="sub">5-min frames · refreshed every 10 min</span>
        </div>
        <TodayPowerChart data={getTodayCurve()} outages={todayOutages.map((o) => ({ start: Math.max(o.start, dayStart), end: o.end ?? now }))} />
      </section>

      <div className="grid-2">
        <section className="card">
          <div className="card-head">
            <h2>Last 30 days</h2>
            <span className="sub">daily energy</span>
          </div>
          <EnergyBars data={daily} keys={["generation", "consumption"]} tableExtra={["purchase", "feedIn"]} />
        </section>
        <section className="card">
          <div className="card-head">
            <h2>Last 12 months</h2>
            <span className="sub">monthly energy</span>
          </div>
          <EnergyBars data={monthly} keys={["generation", "consumption", "purchase"]} tableExtra={["feedIn"]} />
        </section>
      </div>

      {lifetime && (
        <section className="tiles" aria-label="Lifetime totals">
          <Tile label="Lifetime consumption" value={fmtEnergy(lifetime.consumption)} />
          <Tile label="Lifetime grid purchase" value={fmtEnergy(lifetime.purchase)} />
          <Tile label="Lifetime grid feed-in" value={fmtEnergy(lifetime.feedIn)} />
          <Tile
            label="Self-sufficiency"
            value={lifetime.consumption ? `${Math.round(Math.max(0, 1 - lifetime.purchase / lifetime.consumption) * 100)}%` : "—"}
            note="1 − purchase / consumption"
          />
        </section>
      )}

      <section className="card">
        <div className="card-head">
          <h2>Grid outages</h2>
          <span className="sub">from the inverter’s grid voltage · last 30 days</span>
        </div>
        <section className="tiles" aria-label="Outage summary">
          <Tile label="Outages today" value={String(todayOutages.length)} note={`${fmtDuration(outageMinutes(todayOutages, dayStart, now) * 60_000)} without grid`} />
          <Tile label="Last 7 days" value={String(outages.filter((o) => (o.end ?? now) >= now - 7 * 86_400_000).length)} note={`${fmtDuration(outageMinutes(outages, now - 7 * 86_400_000, now) * 60_000)} without grid`} />
          <Tile label="Last 30 days" value={String(outages.length)} note={`${fmtDuration(outageMinutes(outages, now - 30 * 86_400_000, now) * 60_000)} without grid`} />
        </section>
        {outages.length === 0 ? (
          <p className="empty">No outages recorded yet.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Grid lost</th>
                  <th>Restored</th>
                  <th className="num">Duration</th>
                  <th>Detected by</th>
                </tr>
              </thead>
              <tbody>
                {outages.slice(0, 30).map((o) => (
                  <tr key={o.id}>
                    <td>{fmtDateTime(o.start)}</td>
                    <td>{o.end ? fmtDateTime(o.end) : <span className="badge critical">ongoing</span>}</td>
                    <td className="num">{fmtDuration((o.end ?? now) - o.start)}</td>
                    <td>{o.source === "live" ? "live" : "history check"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="card">
        <div className="card-head">
          <h2>Alerts</h2>
          <span className="sub">last 7–30 days · checked every 10 min</span>
        </div>
        {alerts.length === 0 ? (
          <p className="empty">No alerts. 🎉</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Status</th>
                  <th>Level</th>
                  <th>Alert</th>
                  <th>Device</th>
                  <th>Impact</th>
                  <th>Started</th>
                  <th>Ended</th>
                </tr>
              </thead>
              <tbody>
                {alerts.map((a) => (
                  <tr key={a.alertId}>
                    <td>{a.status === 1 ? <span className="badge critical">Open</span> : <span className="badge">Closed</span>}</td>
                    <td>
                      <span className={`badge ${LEVEL_CLASS[a.level ?? 0] ?? ""}`}>{LEVEL[a.level ?? 0] ?? a.level}</span>
                    </td>
                    <td>{a.alertName ?? a.protocolName ?? a.alertCode}</td>
                    <td>{a.deviceSn}</td>
                    <td>{IMPACT[a.impact ?? 0] ?? a.impact}</td>
                    <td>{fmtDateTime(parseDeyeTime(a.alertStartTime))}</td>
                    <td>{fmtDateTime(parseDeyeTime(a.alertEndTime))}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}

function GridBanner({ status }: { status: ReturnType<typeof getGridStatus> }) {
  if (status.online === null) return null;
  const reading = [status.voltage != null ? `${status.voltage} V` : null, status.frequency != null ? `${status.frequency} Hz` : null].filter(Boolean).join(" · ");
  const checked = status.lastSampleAt ? `inverter sample ${fmtAgo(status.lastSampleAt)}` : "";
  return status.online ? (
    <div className="banner good" role="status">
      <span className="badge good">Grid online</span>
      <span className="sub">
        {reading}
        {status.since ? ` · since ${fmtDateTime(status.since)}` : ""} · {checked}
      </span>
    </div>
  ) : (
    <div className="banner crit" role="alert">
      <span className="badge critical">Grid OFF</span>
      <span>
        <strong>No grid since {fmtDateTime(status.since)}</strong> ({status.since ? fmtDuration(Date.now() - status.since) : "?"}) · running on battery/PV
      </span>
      <span className="sub">{checked}</span>
    </div>
  );
}
