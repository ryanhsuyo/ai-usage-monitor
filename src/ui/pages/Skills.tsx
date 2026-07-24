import { useEffect, useMemo, useState } from "react";
import {
  clearSkillMonitorCache,
  readSkillMonitor,
  type SkillMonitorSnapshot,
  type SkillPlatform,
} from "@/adapters/platform/skillMonitor";
import { SETTINGS_KEYS, settingBool } from "@/services/settingsKeys";
import { Badge } from "../components/atoms";
import { getAppServices } from "../appServices";
import { useAppStore } from "../state/store";

type Filter = "all" | SkillPlatform;

const SOURCE_LABELS: Record<string, string> = {
  personal: "個人安裝",
  shared: "共用目錄",
  plugin: "Plugin",
};

function dateLabel(value?: string) {
  if (!value) return "尚無紀錄";
  return new Intl.DateTimeFormat("zh-TW", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}

export function SkillsPage() {
  const store = useAppStore();
  const enabled = settingBool(store.settings[SETTINGS_KEYS.skillsInsightsEnabled], false);
  const [snapshot, setSnapshot] = useState<SkillMonitorSnapshot>();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>();
  const [filter, setFilter] = useState<Filter>("all");
  const [query, setQuery] = useState("");

  const refresh = async (force = false) => {
    setLoading(true);
    setError(undefined);
    try {
      setSnapshot(await readSkillMonitor(force));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setLoading(false);
    }
  };

  const setEnabled = async (next: boolean) => {
    const services = await getAppServices();
    await services.settingsRepo.set(SETTINGS_KEYS.skillsInsightsEnabled, String(next));
    if (!next) {
      clearSkillMonitorCache();
      setSnapshot(undefined);
    }
    await store.refresh();
  };

  useEffect(() => {
    if (enabled) void refresh();
  // Enabling is the only automatic scan. Further scans are explicitly requested.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  const rows = useMemo(() => {
    if (!snapshot) return [];
    const usage = new Map(snapshot.usage.map((item) => [item.key, item]));
    return snapshot.inventory
      .map((skill) => ({ ...skill, usage: usage.get(skill.key) }))
      .filter((skill) => filter === "all" || skill.platform === filter)
      .filter((skill) => `${skill.name} ${skill.description} ${skill.source}`.toLowerCase().includes(query.toLowerCase()))
      .sort((a, b) => {
        const callsA = (a.usage?.confirmed30d ?? 0) + (a.usage?.probable30d ?? 0);
        const callsB = (b.usage?.confirmed30d ?? 0) + (b.usage?.probable30d ?? 0);
        return callsB - callsA || a.name.localeCompare(b.name);
      });
  }, [filter, query, snapshot]);

  if (!enabled) {
    return (
      <>
        <header>
          <div>
            <h1>Skills Insights</h1>
            <p>了解 Codex 與 Claude Code 使用了哪些本機能力</p>
          </div>
        </header>
        <section className="skill-consent" aria-labelledby="skill-consent-title">
          <div className="skill-consent-icon" aria-hidden>✦</div>
          <div>
            <Badge tone="accent">選用功能</Badge>
            <h2 id="skill-consent-title">啟用本機 Skills 分析？</h2>
            <p>
              啟用後，App 會在這台裝置上掃描 Codex、Claude Code 與共用 Skills 目錄，
              並處理本機工作紀錄以辨識 Skill 事件。
            </p>
            <ul>
              <li>分析全部在本機完成，不會上傳對話、Prompt 或 Skill 內容。</li>
              <li>介面不顯示使用者名稱、專案名稱或完整檔案路徑。</li>
              <li>這項功能不會建立額外的對話副本；可隨時停用。</li>
            </ul>
            <div className="row">
              <button className="btn primary" type="button" onClick={() => void setEnabled(true)}>啟用 Skills Insights</button>
              <span className="faint">預設關閉</span>
            </div>
          </div>
        </section>
      </>
    );
  }

  const confirmed30d = snapshot?.usage.reduce((sum, item) => sum + item.confirmed30d, 0) ?? 0;
  const probable30d = snapshot?.usage.reduce((sum, item) => sum + item.probable30d, 0) ?? 0;
  const used30d = snapshot?.usage.filter((item) => item.confirmed30d + item.probable30d > 0).length ?? 0;
  const codexDetected = snapshot?.inventory.some((item) => item.platform === "codex") ?? false;
  const claudeDetected = snapshot?.inventory.some((item) => item.platform === "claude") ?? false;

  return (
    <>
      <header>
        <div>
          <h1>Skills Insights</h1>
          <p>本機能力盤點與調用證據，不把推定紀錄當成精確計數</p>
        </div>
        <div className="row">
          <button className="btn ghost" type="button" onClick={() => void setEnabled(false)}>停用</button>
          <button className="btn primary" type="button" disabled={loading} onClick={() => void refresh(true)}>
            {loading ? "掃描中…" : "重新掃描"}
          </button>
        </div>
      </header>

      {error && <div className="banner error">掃描失敗：{error}</div>}

      <div className="stats">
        <article><label>偵測到的 Skills</label><strong>{snapshot?.inventory.length ?? "—"}</strong><small>Codex 與 Claude 安裝項目</small></article>
        <article><label>近 30 天有活動</label><strong>{used30d}</strong><small>確定或推定有觸發證據</small></article>
        <article><label>確定調用</label><strong>{confirmed30d}</strong><small>工具紀錄或明確 $skill</small></article>
        <article><label>推定調用</label><strong>{probable30d}</strong><small>Codex 讀取 SKILL.md</small></article>
      </div>

      <section className="skill-platforms" aria-label="支援平台狀態">
        <div><span className={`skill-dot ${codexDetected ? "detected" : ""}`} /><strong>Codex</strong><small>{codexDetected ? "已偵測" : "未偵測到 Skills"}</small></div>
        <div><span className={`skill-dot ${claudeDetected ? "detected" : ""}`} /><strong>Claude Code</strong><small>{claudeDetected ? "已偵測" : "未偵測到 Skills"}</small></div>
        <div className="spacer" />
        <small>最後掃描：{snapshot ? dateLabel(snapshot.capturedAt) : loading ? "掃描中…" : "—"}</small>
      </section>

      <section className="skill-evidence" aria-label="統計口徑">
        <strong>統計口徑</strong>
        <span>Claude 有可識別的 Skill 工具呼叫；Codex 目前沒有官方 invocation telemetry，因此分成「確定」與「推定」。</span>
      </section>

      <div className="skill-toolbar">
        <div className="skill-filters" aria-label="平台篩選">
          {(["all", "codex", "claude"] as const).map((value) => (
            <button key={value} type="button" className={filter === value ? "active" : ""} onClick={() => setFilter(value)}>
              {value === "all" ? "全部" : value === "codex" ? "Codex" : "Claude"}
            </button>
          ))}
        </div>
        <input aria-label="搜尋 Skills" placeholder="搜尋名稱、能力或來源" value={query} onChange={(event) => setQuery(event.target.value)} />
      </div>

      <div className="table-wrap">
        <table className="data skill-table">
          <thead><tr><th>Skill / 能力</th><th>平台</th><th>近 30 天</th><th>全部紀錄</th><th>最後使用</th><th>來源</th></tr></thead>
          <tbody>
            {rows.map((skill) => (
              <tr key={skill.key}>
                <td><strong>{skill.name}</strong><small>{skill.description || "未提供能力描述"}</small></td>
                <td><Badge tone={skill.platform === "codex" ? "accent" : "neutral"}>{skill.platform === "codex" ? "Codex" : "Claude"}</Badge></td>
                <td><strong>{skill.usage?.confirmed30d ?? 0}</strong> 確定{Boolean(skill.usage?.probable30d) && <small>＋ {skill.usage?.probable30d} 推定</small>}</td>
                <td>{skill.usage?.confirmedAllTime ?? 0} 確定{Boolean(skill.usage?.probableAllTime) && <small>＋ {skill.usage?.probableAllTime} 推定</small>}</td>
                <td className="faint">{dateLabel(skill.usage?.lastUsedAt)}</td>
                <td><span>{SOURCE_LABELS[skill.source] ?? "Plugin"}</span><small>{skill.version ?? "本機"}</small></td>
              </tr>
            ))}
            {!loading && rows.length === 0 && <tr><td colSpan={6} className="faint">找不到符合條件的 Skill。</td></tr>}
          </tbody>
        </table>
      </div>

      {snapshot?.warnings.map((warning) => <p className="hint" key={warning}>{warning}</p>)}
      <p className="hint">Skills Insights 不保存額外的對話副本；停用後不再掃描。原始 Codex／Claude 紀錄仍由各自的工具管理。</p>
    </>
  );
}
