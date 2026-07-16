// Usage History (spec §16.3): trend chart + snapshot list with filters and delete.

import { useMemo, useState } from "react";
import { getAppServices } from "../appServices";
import { Badge, ConfirmDialog, EmptyState, toast } from "../components/atoms";
import { formatDateTime, pct, SOURCE_LABELS } from "../components/format";
import { UsageLineChart } from "../components/LineChart";
import { useAppStore } from "../state/store";

const RANGE_OPTIONS = [
  { label: "最近 7 天", days: 7 },
  { label: "最近 14 天", days: 14 },
  { label: "最近 30 天", days: 30 },
  { label: "全部", days: 0 },
];

export function HistoryPage() {
  const store = useAppStore();
  const [rangeDays, setRangeDays] = useState(14);
  const [sourceFilter, setSourceFilter] = useState("");
  const [deleteTarget, setDeleteTarget] = useState<string | undefined>();

  const limit = store.limits.find((l) => l.id === store.selectedLimitId);
  const snapshotsByLimit = store.snapshotsByLimit;
  const snapshots = useMemo(
    () => (limit ? snapshotsByLimit[limit.id] ?? [] : []),
    [limit, snapshotsByLimit]
  );
  const resetEvents = store.resetEvents.filter((e) => e.limitId === limit?.id);

  const filtered = useMemo(() => {
    const cutoff = rangeDays > 0 ? Date.now() - rangeDays * 24 * 3600_000 : 0;
    return snapshots
      .filter((s) => Date.parse(s.capturedAt) >= cutoff)
      .filter((s) => (sourceFilter ? s.source === sourceFilter : true))
      .sort((a, b) => Date.parse(b.capturedAt) - Date.parse(a.capturedAt));
  }, [snapshots, rangeDays, sourceFilter]);

  async function deleteSnapshot(id: string) {
    const services = await getAppServices();
    await services.snapshotRepo.deleteById(id);
    await store.refresh();
    toast.success("已刪除快照");
    setDeleteTarget(undefined);
  }

  if (store.limits.length === 0) {
    return (
      <EmptyState
        icon="◷"
        title="還沒有歷史資料"
        body="建立額度限制並開始記錄用量之後，這裡會顯示趨勢圖與完整歷史。"
      />
    );
  }

  return (
    <>
      <header>
        <div>
          <h1>Usage History</h1>
          <p>{limit?.name ?? ""} 的快照歷史與趨勢</p>
        </div>
        <div className="row">
          <select
            className="input"
            style={{ width: "auto", padding: "8px 10px" }}
            value={store.selectedLimitId ?? ""}
            onChange={(e) => store.selectLimit(e.target.value)}
            aria-label="選擇額度限制"
          >
            {store.limits.map((l) => (
              <option key={l.id} value={l.id}>
                {l.name}
              </option>
            ))}
          </select>
          <select
            className="input"
            style={{ width: "auto", padding: "8px 10px" }}
            value={rangeDays}
            onChange={(e) => setRangeDays(Number(e.target.value))}
            aria-label="時間範圍"
          >
            {RANGE_OPTIONS.map((o) => (
              <option key={o.days} value={o.days}>
                {o.label}
              </option>
            ))}
          </select>
          <select
            className="input"
            style={{ width: "auto", padding: "8px 10px" }}
            value={sourceFilter}
            onChange={(e) => setSourceFilter(e.target.value)}
            aria-label="資料來源篩選"
          >
            <option value="">全部來源</option>
            {Object.entries(SOURCE_LABELS).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </div>
      </header>

      <div className="section">
        <UsageLineChart
          snapshots={filtered.slice().reverse()}
          resetEvents={resetEvents}
        />
      </div>

      {filtered.length === 0 ? (
        <EmptyState icon="◌" title="這個範圍內沒有快照" body="調整時間範圍或來源篩選，或新增一筆手動快照。" />
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>擷取時間</th>
                <th>已使用</th>
                <th>剩餘</th>
                <th>重置時間</th>
                <th>來源</th>
                <th>狀態</th>
                <th>備註</th>
                <th aria-label="操作" />
              </tr>
            </thead>
            <tbody>
              {filtered.map((s) => (
                <tr key={s.id}>
                  <td className="mono">{formatDateTime(s.capturedAt)}</td>
                  <td>
                    <strong>{s.valid ? pct(s.usedPercent, 1) : "—"}</strong>
                  </td>
                  <td>{s.valid ? pct(s.remainingPercent, 1) : "—"}</td>
                  <td className="mono">{s.resetAt ? formatDateTime(s.resetAt) : "—"}</td>
                  <td>{SOURCE_LABELS[s.source] ?? s.source}</td>
                  <td>
                    {s.valid ? (
                      <Badge tone="ok">有效</Badge>
                    ) : (
                      <Badge tone="danger">失敗{s.errorCode ? `：${s.errorCode}` : ""}</Badge>
                    )}
                  </td>
                  <td className="faint">{s.note ?? ""}</td>
                  <td>
                    <button type="button" className="btn ghost sm" onClick={() => setDeleteTarget(s.id)}>
                      刪除
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {deleteTarget && (
        <ConfirmDialog
          title="刪除這筆快照？"
          body="刪除後無法復原。歷史資料的刪除只影響這一筆紀錄，不會改動其他快照。"
          confirmLabel="刪除"
          danger
          onConfirm={() => void deleteSnapshot(deleteTarget)}
          onCancel={() => setDeleteTarget(undefined)}
        />
      )}
    </>
  );
}
