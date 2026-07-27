import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ErrorBoundary, Show, createEffect, createSignal, onCleanup, onMount, type JSX } from "solid-js";
import { crashConsent, setCrashConsent } from "./store";

const SUPPORT_EMAIL = "willko@willko.dev";
const MAX_REPORT_BYTES = 96_000;
const REPORT_TRUNCATED = "\n[report truncated]";

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
  const bytes = new TextEncoder().encode(report);
  if (bytes.length <= MAX_REPORT_BYTES) return report;
  const suffix = new TextEncoder().encode(REPORT_TRUNCATED);
  // Leave room for a replacement code point if the byte cut splits UTF-8.
  const body = new TextDecoder().decode(bytes.slice(0, MAX_REPORT_BYTES - suffix.length - 3));
  return `${body}${REPORT_TRUNCATED}`;
}

function CrashPanel(props: { report: string; prior?: boolean; onContinue: () => void }) {
  const [status, setStatus] = createSignal("");
  const offerEmail = () => crashConsent() === "on";

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
          <Show when={offerEmail()}>
            <button class="ghost" onClick={() => void emailReport()}>Email {SUPPORT_EMAIL}</button>
          </Show>
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
    if (crashConsent() !== "on") {
      // Consent off/unset still shows the contained error, but retains no details on disk.
      void invoke("crash_report_clear").catch(() => undefined);
      return;
    }
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
  // Prior-run report held until consent is known ("unset" defers to the prompt's answer).
  const [priorReport, setPriorReport] = createSignal<string | null>(null);

  const clear = (after?: () => void) => {
    setUnexpected(null);
    void invoke("crash_report_clear").catch(() => undefined);
    after?.();
  };

  const discardPrior = () => {
    setPriorReport(null);
    void invoke("crash_report_clear").catch(() => undefined);
  };

  // Route a recovered prior-run report by consent: show it, or clear it quietly.
  const routePrior = (report: string) => {
    if (crashConsent() === "off") {
      void invoke("crash_report_clear").catch(() => undefined);
    } else if (crashConsent() === "on") {
      if (!unexpected()) setUnexpected({ source: "previous native run", reason: report, prior: true });
    } else {
      setPriorReport(report); // consent pending — the prompt's answer decides
    }
  };

  const answerConsent = (v: "on" | "off") => {
    setCrashConsent(v);
    const held = priorReport();
    if (held !== null) {
      setPriorReport(null);
      if (v === "on") routePrior(held);
      else discardPrior();
    }
  };

  createEffect(() => {
    if (crashConsent() !== "off") return;
    setPriorReport(null);
    if (unexpected()?.prior) setUnexpected(null);
    void invoke("crash_report_clear").catch(() => undefined);
  });

  onMount(() => {
    if (crashConsent() !== "off") {
      void invoke<string | null>("crash_report_get")
        .then((report) => {
          if (report) routePrior(report);
        })
        .catch(() => undefined);
    }

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
      <Show when={crashConsent() === "unset" && !unexpected()}>
        <ConsentGate onAnswer={answerConsent} />
      </Show>
    </>
  );
}

/** Thin wrapper so ConsentPrompt's buttons can hand the answer back to CrashGuard. */
function ConsentGate(props: { onAnswer: (v: "on" | "off") => void }) {
  return (
    <div class="crash-overlay" role="alertdialog" aria-modal="true" aria-label="Crash report preference">
      <section class="crash-card">
        <div class="crash-mark" aria-hidden="true">?</div>
        <div>
          <h1>Help improve Tusk?</h1>
          <p>
            If Tusk ever crashes, it can show the crash details on the next launch with a one-click
            option to email them to the developer. Nothing is ever sent automatically — you review
            and send each report yourself.
          </p>
        </div>
        <div class="crash-privacy">
          Reports contain the app version, platform, and the error message/stack — which can include
          fragments of whatever text triggered the error. They never intentionally include connection
          settings, credentials, or saved queries. You can change this any time in Settings → Privacy.
        </div>
        <div class="crash-actions">
          <button class="ghost" onClick={() => props.onAnswer("off")}>No, just recover quietly</button>
          <button class="run" onClick={() => props.onAnswer("on")}>Yes, offer crash reports</button>
        </div>
      </section>
    </div>
  );
}
