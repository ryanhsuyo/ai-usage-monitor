// Activity Tracking (spec §16.4): start/finish/cancel tasks, manual history, per-type stats.

import { useMemo, useState } from "react";
import type { TaskType, UsageActivity } from "@/domain/types";
import { getAppServices } from "../appServices";
import { Badge, EmptyState, Modal, toast } from "../components/atoms";
import { formatDateTime, pct, TASK_TYPE_LABELS } from "../components/format";
import { latestValid } from "../derive";
import { newId, nowIso } from "@/services/ids";
import { useAppStore } from "../state/store";

const TASK_TYPES: TaskType[] = [
  "short_chat",
  "general_chat",
  "coding",
  "large_context",
  "research",
  "custom",
];

export function ActivityPage() {
  const store = useAppStore();
  const [showStart, setShowStart] = useState(false);
  const [showManual, setShowManual] = useState(false);
  const [finishTarget, setFinishTarget] = useState<UsageActivity | undefined>();

  const limit = store.limits.find((l) => l.id === store.selectedLimitId);
  const activities = useMemo(
    () =>
      store.activities
        .filter((a) => a.limitId === limit?.id)
        .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt)),
    [store.activities, limit?.id]
  );
  const inProgress = activities.filter((a) => a.status === "in_progress");

  const stats = useMemo(() => {
    const byType = new Map<string, { count: number; totalDelta: number }>();
    for (const a of activities) {
      if (a.status !== "completed" || !a.usageDelta || a.usageDelta <= 0) continue;
      const cur = byType.get(a.taskType) ?? { count: 0, totalDelta: 0 };
      cur.count += 1;
      cur.totalDelta += a.usageDelta;
      byType.set(a.taskType, cur);
    }
    return [...byType.entries()].map(([type, v]) => ({
      type,
      count: v.count,
      avg: v.totalDelta / v.count,
    }));
  }, [activities]);

  async function cancelActivity(a: UsageActivity) {
    const services = await getAppServices();
    await services.activityRepo.update({ ...a, status: "cancelled", endedAt: nowIso() });
    await store.refresh();
    toast.info("已取消任務");
  }

  if (store.limits.length === 0) {
    return (
      <EmptyState
        icon="▷"
        title="還不能記錄任務"
        body="先在 Plans 頁建立方案與額度限制，就可以開始記錄每次任務的用量差異。"
      />
    );
  }

  return (
    <>
      <header>
        <div>
          <h1>Activity Tracking</h1>
          <p>記錄任務前後的用量，累積「還能做幾次」的估算基礎</p>
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
          <button type="button" className="btn" onClick={() => setShowManual(true)}>
            補記歷史任務
          </button>
          <button type="button" className="primary" onClick={() => setShowStart(true)}>
            ▶ 開始任務
          </button>
        </div>
      </header>

      {inProgress.length > 0 && (
        <div className="section">
          <div className="section-title">
            <h2>進行中</h2>
          </div>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>任務類型</th>
                  <th>專案</th>
                  <th>模型</th>
                  <th>開始時間</th>
                  <th>開始前用量</th>
                  <th aria-label="操作" />
                </tr>
              </thead>
              <tbody>
                {inProgress.map((a) => (
                  <tr key={a.id}>
                    <td>{TASK_TYPE_LABELS[a.taskType]}</td>
                    <td>{a.projectName ?? "—"}</td>
                    <td>{a.model ?? "—"}</td>
                    <td className="mono">{formatDateTime(a.startedAt)}</td>
                    <td>{pct(a.usageBefore, 1)}</td>
                    <td>
                      <div className="row" style={{ justifyContent: "flex-end" }}>
                        <button type="button" className="primary" style={{ padding: "6px 12px" }} onClick={() => setFinishTarget(a)}>
                          完成
                        </button>
                        <button type="button" className="btn ghost sm" onClick={() => void cancelActivity(a)}>
                          取消
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {stats.length > 0 && (
        <div className="stats">
          {stats.slice(0, 3).map((s) => (
            <article key={s.type}>
              <label>{TASK_TYPE_LABELS[s.type]}</label>
              <strong>
                {s.avg.toFixed(1)}
                <em>% / 次</em>
              </strong>
              <small>{s.count} 筆完成紀錄的平均用量</small>
            </article>
          ))}
        </div>
      )}

      <div className="section-title">
        <h2>活動紀錄</h2>
        <span>{activities.length} 筆</span>
      </div>
      {activities.length === 0 ? (
        <EmptyState
          icon="▷"
          title="還沒有活動紀錄"
          body="開始一個任務（會記下目前用量），完成時再記一次，就能得到單次任務的真實消耗。"
          action={
            <button type="button" className="primary" onClick={() => setShowStart(true)}>
              ▶ 開始第一個任務
            </button>
          }
        />
      ) : (
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>類型</th>
                <th>專案</th>
                <th>模型</th>
                <th>開始</th>
                <th>結束</th>
                <th>用量差異</th>
                <th>狀態</th>
              </tr>
            </thead>
            <tbody>
              {activities.map((a) => (
                <tr key={a.id}>
                  <td>{TASK_TYPE_LABELS[a.taskType]}</td>
                  <td>{a.projectName ?? "—"}</td>
                  <td>{a.model ?? "—"}</td>
                  <td className="mono">{formatDateTime(a.startedAt)}</td>
                  <td className="mono">{a.endedAt ? formatDateTime(a.endedAt) : "—"}</td>
                  <td>
                    <strong>{a.usageDelta !== undefined ? `${a.usageDelta.toFixed(1)}%` : "—"}</strong>
                  </td>
                  <td>
                    {a.status === "completed" && <Badge tone="ok">完成</Badge>}
                    {a.status === "in_progress" && <Badge tone="accent">進行中</Badge>}
                    {a.status === "cancelled" && <Badge tone="neutral">已取消</Badge>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showStart && limit && <StartActivityModal onClose={() => setShowStart(false)} />}
      {showManual && limit && <ManualActivityModal onClose={() => setShowManual(false)} />}
      {finishTarget && (
        <FinishActivityModal activity={finishTarget} onClose={() => setFinishTarget(undefined)} />
      )}
    </>
  );
}

// ---------- Modals ----------

function ActivityFields(props: {
  taskType: TaskType;
  setTaskType: (t: TaskType) => void;
  project: string;
  setProject: (v: string) => void;
  model: string;
  setModel: (v: string) => void;
}) {
  return (
    <>
      <label className="field">
        任務類型
        <select value={props.taskType} onChange={(e) => props.setTaskType(e.target.value as TaskType)}>
          {TASK_TYPES.map((t) => (
            <option key={t} value={t}>
              {TASK_TYPE_LABELS[t]}
            </option>
          ))}
        </select>
      </label>
      <div className="form-row">
        <label className="field">
          專案名稱（選填）
          <input value={props.project} onChange={(e) => props.setProject(e.target.value)} />
        </label>
        <label className="field">
          模型（選填）
          <input value={props.model} onChange={(e) => props.setModel(e.target.value)} placeholder="例如 opus" />
        </label>
      </div>
    </>
  );
}

function StartActivityModal(props: { onClose: () => void }) {
  const store = useAppStore();
  const limit = store.limits.find((l) => l.id === store.selectedLimitId)!;
  const plan = store.plans.find((p) => p.id === limit.planId);
  const latest = latestValid(store.snapshotsByLimit[limit.id] ?? []);
  const [taskType, setTaskType] = useState<TaskType>("coding");
  const [project, setProject] = useState("");
  const [model, setModel] = useState("");
  const [usageBefore, setUsageBefore] = useState(
    latest ? String(latest.usedPercent) : ""
  );

  async function start() {
    const before = usageBefore.trim() === "" ? undefined : Number(usageBefore);
    if (before !== undefined && (!Number.isFinite(before) || before < 0 || before > 100)) {
      toast.error("開始前用量必須介於 0～100");
      return;
    }
    const services = await getAppServices();
    await services.activityRepo.insert({
      id: newId("act"),
      providerId: plan?.providerId ?? "custom",
      accountId: plan?.accountId ?? "",
      limitId: limit.id,
      taskType,
      projectName: project.trim() || undefined,
      model: model.trim() || undefined,
      startedAt: nowIso(),
      usageBefore: before,
      status: "in_progress",
    });
    await store.refresh();
    toast.success("任務已開始");
    props.onClose();
  }

  return (
    <Modal title="開始任務" subtitle="記下開始前的用量，完成時會計算差異" onClose={props.onClose}>
      <ActivityFields {...{ taskType, setTaskType, project, setProject, model, setModel }} />
      <label className="field">
        開始前用量（%）
        <div className="percent-input">
          <input
            type="number"
            min={0}
            max={100}
            step={0.1}
            value={usageBefore}
            onChange={(e) => setUsageBefore(e.target.value)}
          />
          <span>%</span>
        </div>
        <span className="hint">預填為最近一筆快照的數值，可修改。</span>
      </label>
      <div className="modal-actions">
        <span />
        <button type="button" onClick={props.onClose}>
          取消
        </button>
        <button type="button" className="primary" onClick={() => void start()}>
          開始
        </button>
      </div>
    </Modal>
  );
}

function FinishActivityModal(props: { activity: UsageActivity; onClose: () => void }) {
  const store = useAppStore();
  const [usageAfter, setUsageAfter] = useState("");

  async function finish() {
    const after = Number(usageAfter);
    if (!Number.isFinite(after) || after < 0 || after > 100) {
      toast.error("結束後用量必須介於 0～100");
      return;
    }
    const before = props.activity.usageBefore;
    const delta = before !== undefined ? Math.round((after - before) * 10) / 10 : undefined;
    const services = await getAppServices();
    await services.activityRepo.update({
      ...props.activity,
      endedAt: nowIso(),
      usageAfter: after,
      usageDelta: delta,
      status: "completed",
    });
    await store.refresh();
    toast.success(delta !== undefined ? `任務完成，本次消耗約 ${delta}%` : "任務完成");
    props.onClose();
  }

  return (
    <Modal
      title="完成任務"
      subtitle={`開始前用量 ${pct(props.activity.usageBefore, 1)} — 輸入目前用量以計算差異`}
      onClose={props.onClose}
    >
      <label className="field">
        結束後用量（%）
        <div className="percent-input">
          <input
            type="number"
            min={0}
            max={100}
            step={0.1}
            value={usageAfter}
            onChange={(e) => setUsageAfter(e.target.value)}
            autoFocus
          />
          <span>%</span>
        </div>
      </label>
      <div className="modal-actions">
        <span />
        <button type="button" onClick={props.onClose}>
          取消
        </button>
        <button type="button" className="primary" onClick={() => void finish()}>
          完成任務
        </button>
      </div>
    </Modal>
  );
}

function ManualActivityModal(props: { onClose: () => void }) {
  const store = useAppStore();
  const limit = store.limits.find((l) => l.id === store.selectedLimitId)!;
  const plan = store.plans.find((p) => p.id === limit.planId);
  const [taskType, setTaskType] = useState<TaskType>("coding");
  const [project, setProject] = useState("");
  const [model, setModel] = useState("");
  const [delta, setDelta] = useState("");

  async function save() {
    const d = Number(delta);
    if (!Number.isFinite(d) || d <= 0 || d > 100) {
      toast.error("用量差異必須是 0～100 之間的正數");
      return;
    }
    const services = await getAppServices();
    const now = nowIso();
    await services.activityRepo.insert({
      id: newId("act"),
      providerId: plan?.providerId ?? "custom",
      accountId: plan?.accountId ?? "",
      limitId: limit.id,
      taskType,
      projectName: project.trim() || undefined,
      model: model.trim() || undefined,
      startedAt: now,
      endedAt: now,
      usageDelta: d,
      status: "completed",
      note: "手動補記",
    });
    await store.refresh();
    toast.success("已補記歷史任務");
    props.onClose();
  }

  return (
    <Modal title="補記歷史任務" subtitle="直接輸入單次任務的用量差異" onClose={props.onClose}>
      <ActivityFields {...{ taskType, setTaskType, project, setProject, model, setModel }} />
      <label className="field">
        用量差異（%）
        <div className="percent-input">
          <input type="number" min={0} max={100} step={0.1} value={delta} onChange={(e) => setDelta(e.target.value)} />
          <span>%</span>
        </div>
      </label>
      <div className="modal-actions">
        <span />
        <button type="button" onClick={props.onClose}>
          取消
        </button>
        <button type="button" className="primary" onClick={() => void save()}>
          儲存
        </button>
      </div>
    </Modal>
  );
}
