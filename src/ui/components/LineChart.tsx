// Lightweight SVG usage trend chart — no external charting library (spec §19).
// Plots usedPercent over time, marks reset events and failed captures.

import { useMemo } from "react";
import type { ResetEvent, UsageSnapshot } from "@/domain/types";

const PAD = { top: 14, right: 14, bottom: 26, left: 38 } as const;

export function UsageLineChart(props: {
  snapshots: UsageSnapshot[];
  resetEvents?: ResetEvent[];
  height?: number;
}) {
  const W = 760;
  const H = props.height ?? 220;

  const model = useMemo(() => {
    const valid = props.snapshots
      .filter((s) => s.valid)
      .slice()
      .sort((a, b) => Date.parse(a.capturedAt) - Date.parse(b.capturedAt));
    const failed = props.snapshots.filter((s) => !s.valid);
    if (valid.length === 0) return undefined;

    const t0 = Date.parse(valid[0]!.capturedAt);
    const t1 = Date.parse(valid[valid.length - 1]!.capturedAt);
    const span = Math.max(t1 - t0, 3600_000);

    const x = (iso: string) =>
      PAD.left + ((Date.parse(iso) - t0) / span) * (W - PAD.left - PAD.right);
    const y = (used: number) => PAD.top + ((100 - used) / 100) * (H - PAD.top - PAD.bottom);

    // Break the line at usage drops (resets) so cycles are visually separate.
    const segments: string[] = [];
    let d = "";
    for (let i = 0; i < valid.length; i++) {
      const s = valid[i]!;
      const prev = valid[i - 1];
      const drop = prev && s.usedPercent < prev.usedPercent - 15;
      if (i === 0 || drop) {
        if (d) segments.push(d);
        d = `M ${x(s.capturedAt).toFixed(1)} ${y(s.usedPercent).toFixed(1)}`;
      } else {
        d += ` L ${x(s.capturedAt).toFixed(1)} ${y(s.usedPercent).toFixed(1)}`;
      }
    }
    if (d) segments.push(d);

    const resets = (props.resetEvents ?? [])
      .filter((e) => {
        const t = Date.parse(e.detectedAt);
        return t >= t0 && t <= t1;
      })
      .map((e) => ({ x: x(e.detectedAt), confirmed: e.detectionMethod !== "expected_time_reached" }));

    const failures = failed
      .filter((s) => {
        const t = Date.parse(s.capturedAt);
        return t >= t0 && t <= t1;
      })
      .map((s) => ({ x: x(s.capturedAt) }));

    const last = valid[valid.length - 1]!;
    return { segments, resets, failures, lastPoint: { x: x(last.capturedAt), y: y(last.usedPercent) } };
  }, [props.snapshots, props.resetEvents, H]);

  if (!model) {
    return (
      <div className="chart-box faint" style={{ textAlign: "center", padding: 40 }}>
        尚無足夠的有效快照可繪製趨勢圖
      </div>
    );
  }

  const gridY = [0, 25, 50, 75, 100];
  const yFor = (used: number) => PAD.top + ((100 - used) / 100) * (H - PAD.top - PAD.bottom);

  return (
    <div className="chart-box">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="用量趨勢圖">
        {gridY.map((g) => (
          <g key={g}>
            <line
              x1={PAD.left}
              x2={W - PAD.right}
              y1={yFor(g)}
              y2={yFor(g)}
              stroke="currentColor"
              opacity={0.12}
              strokeDasharray="3 4"
            />
            <text x={PAD.left - 8} y={yFor(g) + 3.5} fontSize={10} textAnchor="end" fill="currentColor" opacity={0.5}>
              {g}%
            </text>
          </g>
        ))}
        {model.resets.map((r, i) => (
          <g key={`reset-${i}`}>
            <line
              x1={r.x}
              x2={r.x}
              y1={PAD.top}
              y2={H - PAD.bottom}
              stroke={r.confirmed ? "#2f8577" : "#cf9f4d"}
              strokeWidth={1.5}
              strokeDasharray={r.confirmed ? undefined : "4 4"}
              opacity={0.75}
            />
            <text x={r.x + 4} y={PAD.top + 9} fontSize={9} fill={r.confirmed ? "#2f8577" : "#cf9f4d"}>
              {r.confirmed ? "重置" : "預計重置"}
            </text>
          </g>
        ))}
        {model.failures.map((f, i) => (
          <text key={`fail-${i}`} x={f.x} y={H - PAD.bottom + 14} fontSize={10} textAnchor="middle" fill="#b64c47">
            ✕
          </text>
        ))}
        {model.segments.map((d, i) => (
          <path key={i} d={d} fill="none" stroke="#3f8f83" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" />
        ))}
        <circle cx={model.lastPoint.x} cy={model.lastPoint.y} r={4} fill="#3f8f83" />
      </svg>
      <div className="row faint" style={{ marginTop: 8, gap: 16 }}>
        <span>— 已用百分比</span>
        <span style={{ color: "#2f8577" }}>│ 確認重置</span>
        <span style={{ color: "#cf9f4d" }}>┆ 預計重置</span>
        <span style={{ color: "#b64c47" }}>✕ 擷取失敗</span>
      </div>
    </div>
  );
}
