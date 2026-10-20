import { GENERAL_LIMITS } from "@docs/annotations";
import { buildAnnotatedSpec, specStats, usageByPath } from "@/lib/apiDocs";
import { fmtInt } from "@/lib/format";
import { getTodayCallsByEndpoint, getUsage } from "@/lib/repo";
import { SwaggerView } from "./SwaggerView";

export const dynamic = "force-dynamic";
export const metadata = { title: "API docs · Deye Dashboard" };

export default function ApiDocsPage() {
  const today = getTodayCallsByEndpoint();
  const usage = [...usageByPath(today).values()];
  const totalMonth = usage.reduce((n, u) => n + u.jobs.reduce((m, j) => m + j.perMonth, 0), 0);
  const u = getUsage();
  const stats = specStats();

  return (
    <>
      <div className="page-head">
        <h1>Deye Cloud API: our reference</h1>
        <span className="sub">
          {stats.total} endpoints · {stats.write} write · {stats.deviceRead} device-read · spec <code>docs/deye-openapi.json</code>
        </span>
      </div>

      <section className="card doc-prose">
        <h2>1. Authentication</h2>
        <ol>
          <li>
            <code>POST /v1.0/account/token?appId=&lt;appId&gt;</code> with body <code>{"{ appSecret, email, password }"}</code>, where{" "}
            <code>password</code> = SHA-256 hex of the account password.
          </li>
          <li>
            Response: <code>accessToken</code> (already prefixed <code>Bearer </code>) and <code>expiresIn</code> ≈ 60 days. No refresh endpoint exists.
          </li>
          <li>
            Every other call: <code>POST</code> + JSON body + header <code>Authorization: &lt;accessToken&gt;</code>. Host must match the data center of the
            account (ours: <code>eu1-developer.deyecloud.com</code>).
          </li>
          <li>
            Success is <code>"code": "1000000"</code> and <code>"success": true</code>. Anything else is an error, even with HTTP 200.
          </li>
        </ol>
        <p className="sub">
          In this app only the worker process holds credentials. The browser never sees the token, appSecret or password hash.
        </p>
      </section>

      <section className="card doc-prose">
        <h2>2. Limits (from Deye’s Best Practices)</h2>
        <ul>
          <li>
            <b>{GENERAL_LIMITS.qpm} requests / minute</b> per application. Exceeding it returns <b>HTTP 429</b> with no data. We self-limit to{" "}
            <b>{u.qpm}/min</b>, evenly spaced.
          </li>
          <li>
            Base quota <b>≈ {fmtInt(GENERAL_LIMITS.monthlyQuota)} calls / month</b> (Deye marks the figures as preliminary; metering is being introduced). Our local
            caps: <b>{fmtInt(u.dailyCap)}/day</b> and <b>{fmtInt(u.monthlyCap)}/month</b>. The worker pauses itself when it hits one.
          </li>
          <li>
            Recommended polling: <b>{GENERAL_LIMITS.pollIntervalMin}</b> for live views, 5 min in the background. Loggers upload every 1–5 min; plant summaries
            refresh at most every 5 min.
          </li>
          <li>On 429/5xx: exponential backoff (we use 1 s → 2 s → 4 s with jitter, max 3 retries, plus a cooldown for all requests after a 429).</li>
          <li>Batch where possible: <code>/device/latest</code> takes 10 SNs, <code>/station/device</code> takes 10 stations.</li>
          <li>Control commands: one command per device at a time. A second command while one runs is rejected and discarded.</li>
        </ul>
        <p className="sub">Source: {GENERAL_LIMITS.source}.</p>
      </section>

      <section className="card doc-prose">
        <h2>3. Our call budget</h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Endpoint</th>
                <th>Job · interval</th>
                <th className="num">≈ calls / month</th>
                <th className="num">Calls today</th>
              </tr>
            </thead>
            <tbody>
              {usage.map((e) => (
                <tr key={e.path}>
                  <td><code>{e.path}</code></td>
                  <td>{e.jobs.map((j) => `${j.name} · ${j.every}`).join(", ")}</td>
                  <td className="num">{fmtInt(e.jobs.reduce((m, j) => m + j.perMonth, 0))}</td>
                  <td className="num">{fmtInt(e.today)}</td>
                </tr>
              ))}
              <tr>
                <td><b>Total</b></td>
                <td />
                <td className="num"><b>{fmtInt(totalMonth)}</b> ({Math.round((totalMonth / GENERAL_LIMITS.monthlyQuota) * 100)}% of quota)</td>
                <td className="num"><b>{fmtInt(u.today)}</b></td>
              </tr>
            </tbody>
          </table>
        </div>
        <p className="sub">Page views cost zero calls: pages read from the local SQLite cache that the worker fills.</p>
      </section>

      <section className="card doc-prose">
        <h2>4. Conventions</h2>
        <ul>
          <li>
            History <code>granularity</code>: 1 = intraday frames (<code>yyyy-MM-dd</code>), 2 = days (≤ 31, <code>endAt</code> exclusive), 3 = months
            (<code>yyyy-MM</code>, ≤ 12), 4 = years (<code>yyyy</code>).
          </li>
          <li>Timestamps in alert / raw-history requests are 10-digit Unix <b>seconds</b>.</li>
          <li>Station power fields are W, energy fields (<code>*Value</code>) kWh. Device measure points carry their own <code>unit</code>.</li>
          <li>
            Endpoints marked <b>⚠️ WRITE</b> change inverter settings (work mode, TOU, battery, export limits…). This dashboard never calls them.
          </li>
        </ul>
      </section>

      <section className="card">
        <h2>5. Endpoint reference</h2>
        <p className="sub">✅ = used by this app · ⚠️ = write operation · “Try it out” is disabled.</p>
        <SwaggerView spec={buildAnnotatedSpec(today)} />
      </section>
    </>
  );
}
