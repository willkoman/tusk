import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ErrorBoundary, Show, createSignal, onCleanup, onMount, type JSX } from "solid-js";

const SUPPORT_EMAIL = "willko@willko.dev";
const MAX_REPORT_CHARS = 96_000;

function errorDetail(reason: unknown): string {
  if (reason instanceof Error) return reason.stack || `${reason.name}: ${reason.message}`;
  if (typeof reason === "string") return reason;
  try {
    return JSON.stringify(reason, null, 2);
  } catch {
    return String(reason);
  }
}

export function formatFrontendCrash(source: string, reason: unknown, version = "unknown"): string {
  const report = [
    "Tusk frontend crash report",
    `Version: ${version}`,
    `Time: ${new Date().toISOString()}`,
    `Platform: ${navigator.userAgent}`,
    `Source: ${source}`,
    "",
    errorDetail(reason),
  ].join("\n");
  return report.length <= MAX_REPORT_CHARS
    ? report
    : `${report.slice(0, MAX_REPORT_CHARS)}\n[report truncated]`;
}

function CrashPanel(props: { report: string; prior?: boolean; onContinue: () => void }) {
  const [status, setStatus] = createSignal("");

  async function copyReport(): Promise<boolean> {
    try {
      await navigator.clipboard.writeText(props.report);
      setStatus("Report copied");
      return true;
    } catch {
      setStatus("Clipboard unavailable; select report details below");
      return false;
    }
  }

  async function emailReport() {
    const copied = await copyReport();
    const subject = encodeURIComponent("Tusk crash report");
    const fallback = props.report.slice(0, 1800);
    const body = encodeURIComponent(
      copied
        ? "Tusk copied the crash report to the clipboard. Please paste it below before sending.\n\n"
        : `Crash report (truncated for email):\n\n${fallback}`,
    );
    try {
      await openUrl(`mailto:${SUPPORT_EMAIL}?subject=${subject}&body=${body}`);
      setStatus(copied ? "Email draft opened; paste the copied report" : "Email draft opened");
    } catch {
      setStatus(`Could not open email app. Send report to ${SUPPORT_EMAIL}.`);
    }
  }

  return (
    <div class="crash-overlay" role="alertdialog" aria-modal="true" aria-label="Tusk error report">
      <section class="crash-card">
        <div class="crash-mark">!</div>
        <div>
          <h1>{props.prior ? "Tusk stopped unexpectedly" : "Tusk hit an unexpected error"}</h1>
          <p>
            {props.prior
              ? "A local crash report was recovered from the previous run."
              : "The error was contained. You can report it, then try to continue."}
          </p>
        </div>
        <div class="crash-privacy">
          Nothing is sent automatically. Tusk does not intentionally collect connection settings, credentials, or query text, but exception messages can contain data. Review details before sending.
        </div>
        <details>
          <summary>Report details</summary>
          <pre>{props.report}</pre>
        </details>
        <Show when={status()}><div class="crash-status">{status()}</div></Show>
        <div class="crash-actions">
          <button class="ghost" onClick={() => void copyReport()}>Copy report</button>
          <button class="ghost" onClick={() => void emailReport()}>Email {SUPPORT_EMAIL}</button>
          <button class="run" onClick={props.onContinue}>{props.prior ? "Dismiss" : "Try to continue"}</button>
        </div>
      </section>
    </div>
  );
}

function CapturedCrash(props: { source: string; reason: unknown; prior?: boolean; onContinue: () => void }) {
  const [report, setReport] = createSignal(
    typeof props.reason === "string" && props.prior
      ? props.reason
      : formatFrontendCrash(props.source, props.reason),
  );

  onMount(() => {
    if (props.prior) return;
    void getVersion()
      .then((version) => {
        const next = formatFrontendCrash(props.source, props.reason, version);
        setReport(next);
        return invoke("crash_report_write", { report: next });
      })
      .catch(() => {
        void invoke("crash_report_write", { report: report() }).catch(() => undefined);
      });
  });

  return <CrashPanel report={report()} prior={props.prior} onContinue={props.onContinue} />;
}

export function CrashGuard(props: { children: JSX.Element }) {
  const [unexpected, setUnexpected] = createSignal<{ source: string; reason: unknown; prior?: boolean } | null>(null);

  const clear = (after?: () => void) => {
    setUnexpected(null);
    void invoke("crash_report_clear").catch(() => undefined);
    after?.();
  };

  onMount(() => {
    void invoke<string | null>("crash_report_get")
      .then((report) => {
        if (report && !unexpected()) setUnexpected({ source: "previous native run", reason: report, prior: true });
      })
      .catch(() => undefined);

    const onError = (event: ErrorEvent) => {
      setUnexpected({ source: `${event.filename || "window"}:${event.lineno || 0}`, reason: event.error ?? event.message });
    };
    const onRejection = (event: PromiseRejectionEvent) => {
      setUnexpected({ source: "unhandled promise rejection", reason: event.reason });
    };
    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);
    onCleanup(() => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    });
  });

  return (
    <>
      <ErrorBoundary
        fallback={(error, reset) => (
          <CapturedCrash source="Solid render boundary" reason={error} onContinue={() => clear(reset)} />
        )}
      >
        {props.children}
      </ErrorBoundary>
      <Show when={unexpected()}>
        {(failure) => (
          <CapturedCrash
            source={failure().source}
            reason={failure().reason}
            prior={failure().prior}
            onContinue={() => clear()}
          />
        )}
      </Show>
    </>
  );
}
