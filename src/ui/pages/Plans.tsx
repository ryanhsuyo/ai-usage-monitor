// Plans (spec §16.5): provider accounts, subscription plans, usage limits — full CRUD.

import { useState } from "react";
import { CLAUDE_DEFAULT_PLANS } from "@/domain/constants";
import type { LimitType, ProviderId, SubscriptionPlan, UsageLimit } from "@/domain/types";
import { getAppServices } from "../appServices";
import { Badge, ConfirmDialog, EmptyState, Modal, Switch, toast } from "../components/atoms";
import { useAppStore } from "../state/store";
import { newId, nowIso } from "@/services/ids";

const PROVIDERS: Array<{ id: ProviderId; label: string }> = [
  { id: "claude", label: "Claude" },
  { id: "codex", label: "Codex" },
  { id: "chatgpt", label: "ChatGPT" },
  { id: "gemini", label: "Gemini" },
  { id: "cursor", label: "Cursor" },
  { id: "custom", label: "自訂" },
];

const LIMIT_TYPES: Array<{ id: LimitType; label: string }> = [
  { id: "rolling_session", label: "5-hour Session（滾動）" },
  { id: "weekly", label: "Weekly（全模型）" },
  { id: "weekly_model", label: "Weekly（特定模型）" },
  { id: "context", label: "Context Window" },
  { id: "credits", label: "Credits" },
  { id: "custom", label: "自訂滾動視窗" },
];

export function PlansPage() {
  const store = useAppStore();
  const [showAccountForm, setShowAccountForm] = useState(false);
  const [showPlanForm, setShowPlanForm] = useState<string | undefined>(); // accountId
  const [showLimitForm, setShowLimitForm] = useState<string | undefined>(); // planId
  const [deletePlan, setDeletePlan] = useState<SubscriptionPlan | undefined>();

  async function toggleLimit(limit: UsageLimit, patch: Partial<UsageLimit>) {
    const services = await getAppServices();
    await services.providerRepo.saveLimit({ ...limit, ...patch, updatedAt: nowIso() });
    await store.refresh();
  }

  return (
    <>
      <header>
        <div>
          <h1>Plans</h1>
          <p>Provider 帳號、訂閱方案與額度限制</p>
        </div>
        <button type="button" className="primary" onClick={() => setShowAccountForm(true)}>
          ＋ 新增 Provider 帳號
        </button>
      </header>

      {store.accounts.length === 0 ? (
        <EmptyState
          icon="◈"
          title="還沒有 Provider 帳號"
          body="先新增一個帳號（例如 Claude），再建立方案與額度限制。"
          action={
            <button type="button" className="primary" onClick={() => setShowAccountForm(true)}>
              ＋ 新增 Provider 帳號
            </button>
          }
        />
      ) : (
        store.accounts.map((account) => {
          const plans = store.plans.filter((p) => p.accountId === account.id);
          return (
            <div className="section" key={account.id}>
              <div className="section-title">
                <div>
                  <h2>
                    {account.displayName}{" "}
                    <span className="faint" style={{ fontWeight: 400 }}>
                      {PROVIDERS.find((p) => p.id === account.providerId)?.label}
                    </span>
                  </h2>
                </div>
                <button type="button" className="btn sm" onClick={() => setShowPlanForm(account.id)}>
                  ＋ 新增方案
                </button>
              </div>

              {plans.length === 0 && (
                <p className="muted" style={{ padding: "6px 0 14px" }}>
                  尚無方案。
                </p>
              )}

              {plans.map((plan) => {
                const limits = store.limits.filter((l) => l.planId === plan.id);
                return (
                  <div className="card" key={plan.id} style={{ marginBottom: 13 }}>
                    <div className="card-title" style={{ marginBottom: 6 }}>
                      <div className="row">
                        <h3 style={{ textTransform: "none", fontSize: 14, color: "inherit" }}>{plan.name}</h3>
                        {plan.active ? <Badge tone="ok">使用中</Badge> : <Badge>停用</Badge>}
                        {plan.relativeCapacity !== undefined && (
                          <Badge tone="accent">容量 {plan.relativeCapacity}x</Badge>
                        )}
                      </div>
                      <div className="row">
                        <span className="muted">
                          {plan.currency} {plan.monthlyPrice}/月
                        </span>
                        <button type="button" className="btn sm" onClick={() => setShowLimitForm(plan.id)}>
                          ＋ 額度限制
                        </button>
                        <button type="button" className="btn ghost sm" onClick={() => setDeletePlan(plan)}>
                          刪除
                        </button>
                      </div>
                    </div>

                    {limits.length === 0 ? (
                      <p className="faint">尚無額度限制。新增例如「Weekly」或「5-hour Session」。</p>
                    ) : (
                      limits.map((limit) => (
                        <div className="switch-row" key={limit.id}>
                          <div>
                            <div className="switch-label">
                              {limit.name}{" "}
                              <span className="faint">
                                {LIMIT_TYPES.find((t) => t.id === limit.type)?.label}
                                {limit.model ? ` · ${limit.model}` : ""}
                              </span>
                            </div>
                            <div className="switch-desc">時區 {limit.timezone}</div>
                          </div>
                          <div className="row">
                            <label className="faint" style={{ display: "flex", alignItems: "center", gap: 5 }}>
                              監控
                              <button
                                type="button"
                                role="switch"
                                aria-checked={limit.monitoringEnabled}
                                aria-label={`監控 ${limit.name}`}
                                className="switch"
                                onClick={() => void toggleLimit(limit, { monitoringEnabled: !limit.monitoringEnabled })}
                              />
                            </label>
                            <label className="faint" style={{ display: "flex", alignItems: "center", gap: 5 }}>
                              通知
                              <button
                                type="button"
                                role="switch"
                                aria-checked={limit.notifyEnabled}
                                aria-label={`通知 ${limit.name}`}
                                className="switch"
                                onClick={() => void toggleLimit(limit, { notifyEnabled: !limit.notifyEnabled })}
                              />
                            </label>
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                );
              })}
            </div>
          );
        })
      )}

      {showAccountForm && <AccountFormModal onClose={() => setShowAccountForm(false)} />}
      {showPlanForm && <PlanFormModal accountId={showPlanForm} onClose={() => setShowPlanForm(undefined)} />}
      {showLimitForm && <LimitFormModal planId={showLimitForm} onClose={() => setShowLimitForm(undefined)} />}
      {deletePlan && (
        <ConfirmDialog
          title={`刪除方案「${deletePlan.name}」？`}
          body="會一併刪除底下的額度限制與其歷史快照。此動作無法復原。"
          confirmLabel="刪除方案"
          danger
          onConfirm={() =>
            void (async () => {
              const services = await getAppServices();
              await services.providerRepo.deletePlan(deletePlan.id);
              await store.refresh();
              toast.success("已刪除方案");
              setDeletePlan(undefined);
            })()
          }
          onCancel={() => setDeletePlan(undefined)}
        />
      )}
    </>
  );
}

// ---------- modals ----------

function AccountFormModal(props: { onClose: () => void }) {
  const store = useAppStore();
  const [providerId, setProviderId] = useState<ProviderId>("claude");
  const [name, setName] = useState("");

  async function save() {
    if (!name.trim()) {
      toast.error("請輸入帳號顯示名稱");
      return;
    }
    const services = await getAppServices();
    const now = nowIso();
    await services.providerRepo.saveAccount({
      id: newId("acc"),
      providerId,
      displayName: name.trim(),
      active: true,
      createdAt: now,
      updatedAt: now,
    });
    await store.refresh();
    toast.success("已新增帳號");
    props.onClose();
  }

  return (
    <Modal title="新增 Provider 帳號" onClose={props.onClose}>
      <label className="field">
        Provider
        <select value={providerId} onChange={(e) => setProviderId(e.target.value as ProviderId)}>
          {PROVIDERS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.label}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        帳號顯示名稱
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="例如 個人 Claude 帳號" autoFocus />
      </label>
      <div className="modal-actions">
        <span />
        <button type="button" onClick={props.onClose}>
          取消
        </button>
        <button type="button" className="primary" onClick={() => void save()}>
          新增
        </button>
      </div>
    </Modal>
  );
}

function PlanFormModal(props: { accountId: string; onClose: () => void }) {
  const store = useAppStore();
  const account = store.accounts.find((a) => a.id === props.accountId)!;
  const [template, setTemplate] = useState(account.providerId === "claude" ? "Max 5x" : "Custom");
  const preset = CLAUDE_DEFAULT_PLANS.find((p) => p.name === template);
  const [name, setName] = useState(preset?.name ?? "");
  const [price, setPrice] = useState(String(preset?.monthlyPrice ?? 0));
  const [currency, setCurrency] = useState(preset?.currency ?? "USD");
  const [capacity, setCapacity] = useState(String(preset?.relativeCapacity ?? 1));

  function applyTemplate(t: string) {
    setTemplate(t);
    const p = CLAUDE_DEFAULT_PLANS.find((x) => x.name === t);
    if (p) {
      setName(p.name);
      setPrice(String(p.monthlyPrice));
      setCurrency(p.currency);
      setCapacity(String(p.relativeCapacity));
    }
  }

  async function save() {
    if (!name.trim()) {
      toast.error("請輸入方案名稱");
      return;
    }
    const services = await getAppServices();
    const now = nowIso();
    await services.providerRepo.savePlan({
      id: newId("plan"),
      providerId: account.providerId,
      accountId: account.id,
      name: name.trim(),
      monthlyPrice: Number(price) || 0,
      currency: currency.trim() || "USD",
      relativeCapacity: Number(capacity) || undefined,
      active: true,
      startedAt: now,
      createdAt: now,
      updatedAt: now,
    });
    await store.refresh();
    toast.success("已新增方案");
    props.onClose();
  }

  return (
    <Modal title="新增方案" subtitle="預設值僅供參考，價格與容量都可修改" onClose={props.onClose}>
      {account.providerId === "claude" && (
        <label className="field">
          範本
          <select value={template} onChange={(e) => applyTemplate(e.target.value)}>
            {CLAUDE_DEFAULT_PLANS.map((p) => (
              <option key={p.name} value={p.name}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
      )}
      <label className="field">
        方案名稱
        <input value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      <div className="form-row-3">
        <label className="field">
          月費
          <input type="number" min={0} value={price} onChange={(e) => setPrice(e.target.value)} />
        </label>
        <label className="field">
          幣別
          <input value={currency} onChange={(e) => setCurrency(e.target.value)} />
        </label>
        <label className="field">
          相對容量
          <input type="number" min={0} step={0.5} value={capacity} onChange={(e) => setCapacity(e.target.value)} />
        </label>
      </div>
      <div className="modal-actions">
        <span />
        <button type="button" onClick={props.onClose}>
          取消
        </button>
        <button type="button" className="primary" onClick={() => void save()}>
          新增
        </button>
      </div>
    </Modal>
  );
}

function LimitFormModal(props: { planId: string; onClose: () => void }) {
  const store = useAppStore();
  const [type, setType] = useState<LimitType>("weekly");
  const [name, setName] = useState("Weekly（全模型）");
  const [model, setModel] = useState("");
  const [timezone, setTimezone] = useState(Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");
  const [monitoring, setMonitoring] = useState(true);
  const [notify, setNotify] = useState(true);

  async function save() {
    if (!name.trim()) {
      toast.error("請輸入額度名稱");
      return;
    }
    const services = await getAppServices();
    const now = nowIso();
    await services.providerRepo.saveLimit({
      id: newId("lim"),
      planId: props.planId,
      name: name.trim(),
      type,
      model: type === "weekly_model" ? model.trim() || undefined : undefined,
      windowHours: type === "rolling_session" ? 5 : undefined,
      timezone,
      active: true,
      monitoringEnabled: monitoring,
      notifyEnabled: notify,
      createdAt: now,
      updatedAt: now,
    });
    await store.refresh();
    toast.success("已新增額度限制");
    props.onClose();
  }

  return (
    <Modal title="新增額度限制" onClose={props.onClose}>
      <label className="field">
        類型
        <select
          value={type}
          onChange={(e) => {
            const t = e.target.value as LimitType;
            setType(t);
            setName(LIMIT_TYPES.find((x) => x.id === t)?.label ?? "");
          }}
        >
          {LIMIT_TYPES.map((t) => (
            <option key={t.id} value={t.id}>
              {t.label}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        名稱
        <input value={name} onChange={(e) => setName(e.target.value)} />
      </label>
      {type === "weekly_model" && (
        <label className="field">
          模型
          <input value={model} onChange={(e) => setModel(e.target.value)} placeholder="例如 opus" />
        </label>
      )}
      <label className="field">
        時區
        <input value={timezone} onChange={(e) => setTimezone(e.target.value)} />
        <span className="hint">重置時間會以此時區解讀與顯示。</span>
      </label>
      <Switch checked={monitoring} onChange={setMonitoring} label="啟用監控" description="納入每小時背景檢查" />
      <Switch checked={notify} onChange={setNotify} label="啟用通知" description="此額度的事件會發送通知" />
      <div className="modal-actions">
        <span />
        <button type="button" onClick={props.onClose}>
          取消
        </button>
        <button type="button" className="primary" onClick={() => void save()}>
          新增
        </button>
      </div>
    </Modal>
  );
}
