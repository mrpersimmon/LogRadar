import { useState } from "react";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { openFile, type OpenResponse } from "../lib/ipc";
import "./WelcomePage.css";

export function WelcomePage() {
  const [meta, setMeta] = useState<OpenResponse | null>(null);
  const [err, setErr] = useState<string | null>(null);
  async function onOpen() {
    try {
      const path = await openDialog({ multiple: false });
      if (typeof path !== "string") return;
      setMeta(await openFile(path));
      setErr(null);
    } catch (e) { setErr(String(e)); }
  }
  return (
    <div className="welcome">
      <div className="drop">拖拽日志到这里（③b 完整版）</div>
      <button onClick={onOpen}>Open file</button>
      {meta && <div className="meta">sessionId: {meta.sessionId} · lineCount: {meta.lineCount} · encoding: {meta.encoding} · isJson: {String(meta.isJson)} · timestampFmt: {meta.timestampFmt}</div>}
      {err && <div className="err">{err}</div>}
    </div>
  );
}
