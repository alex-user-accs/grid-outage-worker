import { AutoRefresh } from "@/components/AutoRefresh";
import { parseDeyeTime } from "@/lib/dates";
import { fmtAgo, fmtDateTime } from "@/lib/format";
import { getDevices } from "@/lib/repo";

export const dynamic = "force-dynamic";
export const metadata = { title: "Devices · Deye Dashboard" };

const CONNECT = { 0: ["Offline", "critical"], 1: ["Online", "good"], 2: ["Alert", "warning"] } as Record<number, [string, string]>;

export default function DevicesPage() {
  const res = getDevices();
  return (
    <>
      <AutoRefresh />
      <div className="page-head">
        <h1>Devices</h1>
        <span className="sub">List refreshed hourly{res ? ` (last ${fmtAgo(res.ts)})` : ""} · measure points every 5 min</span>
      </div>
      {!res?.devices.length && <p className="empty">No devices loaded yet.</p>}
      {res?.devices.map((d) => {
        const [label, cls] = CONNECT[d.connectStatus ?? -1] ?? ["Unknown", ""];
        const points = d.latest?.data.dataList ?? [];
        return (
          <section className="card" key={d.deviceSn}>
            <div className="card-head">
              <h2>
                {d.deviceType ?? "Device"} <code>{d.deviceSn}</code>
              </h2>
              <span className={`badge ${cls}`}>{label}</span>
            </div>
            <div className="sub">
              Data collected {fmtDateTime(parseDeyeTime(d.latest?.data.collectionTime ?? d.collectionTime))}
              {d.productId ? ` · product ${d.productId}` : ""}
            </div>
            {d.deviceType === "COLLECTOR" ? (
              <p className="sub">Data logger: it has no measure points of its own.</p>
            ) : points.length ? (
              <details open={points.length <= 20}>
                <summary>{points.length} measure points</summary>
                <div className="table-wrap">
                  <table>
                    <thead>
                      <tr>
                        <th>Measure point</th>
                        <th className="num">Value</th>
                        <th>Unit</th>
                      </tr>
                    </thead>
                    <tbody>
                      {points.map((p) => (
                        <tr key={p.key}>
                          <td>{p.key}</td>
                          <td className="num">{p.value ?? "—"}</td>
                          <td>{p.unit}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </details>
            ) : (
              <p className="sub">No measure points yet.</p>
            )}
          </section>
        );
      })}
    </>
  );
}
