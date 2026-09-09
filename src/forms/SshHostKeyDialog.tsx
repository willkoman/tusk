import { createSignal } from "solid-js";
import { Dialog } from "../Dialog";

/** The structured payload a connect failure carries when the SSH host key is unknown. */
export type SshHostKeyPrompt = {
  host: string;
  port: number;
  algorithm: string;
  fingerprint: string;
};

/**
 * First-contact prompt for an SSH host key Tusk has never seen. Shown only for the
 * *unknown* case — a host key that CHANGED surfaces as an ordinary error with no
 * accept path, because there is no safe one-click answer to it.
 */
export function SshHostKeyDialog(props: {
  prompt: SshHostKeyPrompt;
  onTrust: () => Promise<void>;
  onCancel: () => void;
}) {
  const [busy, setBusy] = createSignal(false);
  const trust = async () => {
    setBusy(true);
    try {
      await props.onTrust();
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog
      title="Unknown SSH host key"
      subtitle={`${props.prompt.host}:${props.prompt.port}`}
      size="md"
      onClose={props.onCancel}
      dismissable={!busy()}
      noAutoFocus
      footer={
        <div class="form-actions">
          <button type="button" class="ghost" onClick={props.onCancel} disabled={busy()}>
            Cancel
          </button>
          <button type="button" class="run" onClick={trust} disabled={busy()}>
            {busy() ? "Connecting…" : "Trust and connect"}
          </button>
        </div>
      }
    >
      <p class="ssh-hostkey-lead">
        Tusk has not connected to this host before. Confirm the fingerprint matches the server.
        Accepting the wrong key hands your session to whoever answered.
      </p>
      <div class="ssh-hostkey-fp">
        <div class="ssh-hostkey-alg">{props.prompt.algorithm}</div>
        <code>{props.prompt.fingerprint}</code>
      </div>
      <p class="ssh-hostkey-note">
        On the server, <code>ssh-keygen -lf /etc/ssh/ssh_host_{"<type>"}_key.pub</code> prints the
        same value. Trusting records it in Tusk's SSH trust store; your{" "}
        <code>~/.ssh/known_hosts</code> is read but never modified.
      </p>
    </Dialog>
  );
}
