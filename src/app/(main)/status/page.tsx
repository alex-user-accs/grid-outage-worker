import { AutoRefresh } from "@/components/AutoRefresh";
import { WorkerBanner } from "@/components/WorkerBanner";
import { isMock } from "@/lib/env";
import { fmtAgo, fmtDateTime, fmtDuration, fmtInt } from "@/lib/format";
import { getRecentEvents, getUsage, getWorkerStatus } from "@/lib/repo";

export const dynamic = "force-dynamic";
export const metadata = { title: "API status · Deye Dashboard" };

function UsageTile({ label, used, cap, note }: { label: string; used: number; cap: number; note: string }) {
  const pct = Math.min(100, (used / cap) * 100);
  return (
    <div className="tile">
      <div className="tile-label">{label}</div>
      <div className="tile-value">
        {fmtInt(used)} <span className="sub">/ {fmtInt(cap)}</span>
      </div>
      <div className={`meter usage${pct > 80 ? " hot" : ""}`} role="meter" aria-valuenow={used} aria-valuemin={0} aria-valuemax={cap} aria-label={label}>
        <span style={{ width: `${pct}%` }} />
      </div>
      <div className="tile-note">{note}</div>
    </div>
  );
}

export default function StatusPage() {
  const u = getUsage();
  const w = getWorkerStatus();
  const events = getRecentEvents(15);
  return (
    <>
      <AutoRefresh everyMs={60_000} />
      <div className="page-head">
        <h1>API status</h1>
        <span className="sub">{isMock() ? "MOCK mode: no real calls are made" : "Live Deye OpenAPI (EU1)"}</span>
      </div>
      <WorkerBanner pause={w.pause} hasData />

      <section className="tiles">
        <UsageTile
          label="Calls today"
          used={u.today}
          cap={u.dailyCap}
          note={`expected ≈ ${fmtInt(u.expectedPerDay)}/day · slower ${u.night.startHour}:00–${u.night.endHour}:00`}
        />
        <UsageTile label="Calls this month" used={u.month} cap={u.monthlyCap} note="Deye base quota ≈ 100,000/month" />
        <div className="tile">
          <div className="tile-label">Last hour</div>
          <div className="tile-value">{fmtInt(u.lastHour)}</div>
          <div className="tile-note">client limit {u.qpm} req/min (Deye: 60)</div>
        </div>
        <div className="tile">
          <div className="tile-label">Access token</div>
          <div className="tile-value">{w.token ? fmtAgo(w.token).replace("in ", "") : "—"}</div>
          <div className="tile-note">{w.token ? `expires ${fmtDateTime(w.token)}` : "not obtained yet"}</div>
        </div>
      </section>

      <section className="card">
        <h2>Worker jobs</h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Job</th>
                <th>Every</th>
                <th>Last run</th>
                <th>Result</th>
                <th>What it does</th>
              </tr>
            </thead>
            <tbody>
              {w.jobs.map((j) => (
                <tr key={j.name}>
                  <td>{j.name}</td>
                  <td>
                    {j.name === "gridWatch" ? "each upload (~2 min)" : fmtDuration(j.intervalMs)}
                    {j.nightIntervalMs ? <span className="sub"> · night {fmtDuration(j.nightIntervalMs)}</span> : null}
                  </td>
                  <td>{fmtAgo(j.state?.lastRun)}</td>
                  <td>{!j.state ? "—" : j.state.ok ? <span className="badge good">OK</span> : <span className="badge critical" title={j.state.error}>{j.state.error?.slice(0, 60)}</span>}</td>
                  <td style={{ whiteSpace: "normal" }}>{j.description}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <div className="grid-2">
        <section className="card">
          <h2>Calls today by endpoint</h2>
          {u.perEndpoint.length === 0 ? (
            <p className="empty">No calls today.</p>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Endpoint</th>
                    <th className="num">Calls</th>
                    <th className="num">Errors</th>
                    <th>Last</th>
                  </tr>
                </thead>
                <tbody>
                  {u.perEndpoint.map((e) => (
                    <tr key={e.endpoint}>
                      <td><code>{e.endpoint}</code></td>
                      <td className="num">{e.today}</td>
                      <td className="num">{e.errors}</td>
                      <td>{fmtAgo(e.last)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
        <section className="card">
          <h2>Rate-limit headers</h2>
          {w.rateHeaders ? (
            <>
              <div className="sub">Seen {fmtAgo(w.rateHeaders.ts)} on the last response</div>
              <table>
                <tbody>
                  {Object.entries(w.rateHeaders.headers).map(([k, v]) => (
                    <tr key={k}>
                      <td><code>{k}</code></td>
                      <td>{v}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          ) : (
            <p className="empty">Deye has not sent rate-limit headers yet.</p>
          )}
        </section>
      </div>

      <div className="grid-2">
        <section className="card">
          <h2>Recent calls</h2>
          {u.recent.length === 0 ? (
            <p className="empty">No calls recorded yet.</p>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Endpoint</th>
                    <th className="num">HTTP</th>
                    <th>Code</th>
                    <th className="num">ms</th>
                  </tr>
                </thead>
                <tbody>
                  {u.recent.map((c, i) => (
                    <tr key={i}>
                      <td>{fmtAgo(c.ts)}</td>
                      <td><code>{c.endpoint.replace("/v1.0", "")}</code></td>
                      <td className="num">{c.http_status ?? "net"}</td>
                      <td>{c.code}</td>
                      <td className="num">{c.duration_ms}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
        <section className="card">
          <h2>Notification events</h2>
          <div className="sub">Queued for the future Telegram bot</div>
          {events.length === 0 ? (
            <p className="empty">No events yet.</p>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>When</th>
                    <th>Type</th>
                    <th>Details</th>
                    <th>Sent</th>
                  </tr>
                </thead>
                <tbody>
                  {events.map((e) => (
                    <tr key={e.id}>
                      <td>{fmtAgo(e.ts)}</td>
                      <td>{e.type}</td>
                      <td style={{ whiteSpace: "normal" }}><code>{e.payload}</code></td>
                      <td>{e.sent_at ? "yes" : "no"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </>
  );
}
