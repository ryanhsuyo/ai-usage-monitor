// Manual usage snapshot entry (spec §8 flow 4). Validates through the domain validator; a
// rejected input never becomes a stored snapshot.

import { useState } from "react";
import { validateSnapshot } from "@/domain/snapshotValidation";
import type { UsageLimit } from "@/domain/types";
import { getAppServices } from "../appServices";
import { useAppStore } from "../state/store";
import { newId } from "@/services/ids";
import { Modal, toast } from "./atoms";

function toLocalInputValue(d: Date): string {
  const pad = (x: number) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function SnapshotFormModal(props: { limit: UsageLimit; onClose: () => void }) {
  const refresh = useAppStore((s) => s.refresh);
  const plans = useAppStore((s) => s.plans);
  const [used, setUsed] = useState("");
  const [capturedAt, setCapturedAt] = useState(toLocalInputValue(new Date()));
  const [resetAt, setResetAt] = useState("");
  const [note, setNote] = useState("");
  const [errors, setErrors] = useState<string[]>([]);
  const [saving, setSaving] = useState(false);

  const plan = plans.find((p) => p.id === props.limit.planId);

  async function save() {
    const usedNum = used.trim() === "" ? undefined : Number(used);
    const capturedIso = capturedAt ? new Date(capturedAt).toISOString() : undefined;
    const resetIso = resetAt ? new Date(resetAt).toISOString() : undefined;

    const validation = validateSnapshot({
      usedPercent: usedNum,
      capturedAt: capturedIso,
      resetAt: resetIso,
    });
    if (!validation.valid || !validation.normalized) {
      setErrors(validation.errors);
      return;
    }
    setSaving(true);
    try {
      const services = await getAppServices();
      await services.snapshotRepo.insert({
        id: newId("snap"),
        providerId: plan?.providerId ?? "custom",
        accountId: plan?.accountId ?? "",
        limitId: props.limit.id,
        usedPercent: validation.normalized.usedPercent,
        remainingPercent: validation.normalized.remainingPercent,
        resetAt: resetIso,
        capturedAt: capturedIso as string,
        source: "manual",
        valid: true,
        confidence: 1,
        note: note.trim() || undefined,
      });
      await refresh();
      toast.success("已新增用量快照");
      props.onClose();
    } catch (err) {
      setErrors([err instanceof Error ? err.message : String(err)]);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal title="新增用量快照" subtitle={`${props.limit.name} — 記錄目前的使用百分比`} onClose={props.onClose}>
      <label className="field">
        已使用百分比
        <div className="percent-input">
          <input
            type="number"
            min={0}
            max={100}
            step={0.1}
            value={used}
            onChange={(e) => setUsed(e.target.value)}
            placeholder="例如 42"
            aria-label="已使用百分比"
            autoFocus
          />
          <span>%</span>
        </div>
        <span className="hint">剩餘百分比會自動換算為 100 − 已使用。</span>
      </label>
      <label className="field">
        擷取時間
        <input
          type="datetime-local"
          value={capturedAt}
          onChange={(e) => setCapturedAt(e.target.value)}
          aria-label="擷取時間"
        />
      </label>
      <label className="field">
        下一次重置時間（選填）
        <input
          type="datetime-local"
          value={resetAt}
          onChange={(e) => setResetAt(e.target.value)}
          aria-label="下一次重置時間"
        />
      </label>
      <label className="field">
        備註（選填）
        <input value={note} onChange={(e) => setNote(e.target.value)} aria-label="備註" />
      </label>
      {errors.length > 0 && (
        <ul className="warn-list" role="alert">
          {errors.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      )}
      <div className="modal-actions">
        <span />
        <button type="button" onClick={props.onClose}>
          取消
        </button>
        <button type="button" className="primary" onClick={() => void save()} disabled={saving}>
          {saving ? "儲存中…" : "儲存快照"}
        </button>
      </div>
    </Modal>
  );
}
