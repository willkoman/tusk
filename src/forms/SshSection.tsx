import { Show } from "solid-js";
import { open as openDialog } from "@tauri-apps/plugin-dialog";

/** SSH tunnel metadata as it round-trips through profiles. Secrets never live here. */
export type SshMeta = {
  host: string;
  port: number;
  user: string;
  auth: string;
  key_path?: string | null;
};

export type SshAuthMethod = "password" | "key" | "agent";

export const SSH_DEFAULT_PORT = 22;

/** Agent auth has no secret to type, store, or re-enter. */
export const sshNeedsSecret = (auth: string) => auth === "password" || auth === "key";

export type SshFormState = {
  enabled: boolean;
  host: string;
  port: number;
  user: string;
  auth: SshAuthMethod;
  keyPath: string;
  /** Password (password auth) or key passphrase (key auth). Never populated from a profile. */
  secret: string;
  saveSecret: boolean;
};

export const emptySshForm = (): SshFormState => ({
  enabled: false,
  host: "",
  port: SSH_DEFAULT_PORT,
  user: "",
  auth: "password",
  keyPath: "",
  secret: "",
  saveSecret: false,
});

/** Load a saved profile's tunnel metadata into the form. The secret stays empty — it
 *  lives in the OS keychain and is only ever read server-side. */
export function sshFormFromProfile(ssh: SshMeta | null | undefined, saveSecret: boolean): SshFormState {
  if (!ssh) return emptySshForm();
  const auth: SshAuthMethod = ssh.auth === "key" || ssh.auth === "agent" ? ssh.auth : "password";
  return {
    enabled: true,
    host: ssh.host ?? "",
    port: Number.isInteger(ssh.port) && ssh.port > 0 ? ssh.port : SSH_DEFAULT_PORT,
    user: ssh.user ?? "",
    auth,
    keyPath: ssh.key_path ?? "",
    secret: "",
    saveSecret: saveSecret && sshNeedsSecret(auth),
  };
}

/** The `ssh` block for a connect payload or a saved profile, or null when disabled.
 *  `withSecret` is false for profile metadata so a secret can never reach disk twice. */
export function sshPayload(state: SshFormState, withSecret: boolean): (SshMeta & {
  ssh_password?: string;
  ssh_key_passphrase?: string;
}) | null {
  if (!state.enabled) return null;
  const base: SshMeta = {
    host: state.host.trim(),
    port: state.port,
    user: state.user.trim(),
    auth: state.auth,
    key_path: state.auth === "key" ? state.keyPath.trim() || null : null,
  };
  if (!withSecret || !sshNeedsSecret(state.auth)) return base;
  return state.auth === "password"
    ? { ...base, ssh_password: state.secret }
    : { ...base, ssh_key_passphrase: state.secret };
}

/** Client-side pre-flight so the obvious mistakes never reach the backend. */
export function validateSshForm(state: SshFormState): string {
  if (!state.enabled) return "";
  if (!state.host.trim()) return "SSH tunnel: enter the SSH host";
  if (!state.user.trim()) return "SSH tunnel: enter the SSH user";
  if (!Number.isInteger(state.port) || state.port < 1 || state.port > 65535) {
    return "SSH tunnel: port must be a whole number between 1 and 65535";
  }
  if (state.auth === "key" && !state.keyPath.trim()) {
    return "SSH tunnel: choose a private key file";
  }
  return "";
}

/**
 * The collapsible "SSH tunnel" block of the connect form. Kept out of App.tsx so the
 * connect card only wires state in and out.
 */
export function SshSection(props: {
  state: SshFormState;
  onChange: (patch: Partial<SshFormState>) => void;
  /** True when the profile being edited already has a secret in the keychain. */
  hasStoredSecret: boolean;
  onError: (message: string) => void;
}) {
  const auth = () => props.state.auth;
  const secretLabel = () => (auth() === "key" ? "Key passphrase" : "SSH password");

  const browseKey = async () => {
    try {
      const picked = await openDialog({ multiple: false, title: "Select an SSH private key" });
      if (typeof picked === "string") props.onChange({ keyPath: picked });
    } catch (e) {
      props.onError(e instanceof Error ? e.message : String(e));
    }
  };

  return (
    <div class="ssh-section">
      <label class="checkbox">
        <input
          type="checkbox"
          checked={props.state.enabled}
          onChange={(e) => props.onChange({ enabled: e.currentTarget.checked })}
        />
        Connect through an SSH tunnel
      </label>
      <Show when={props.state.enabled}>
        <div class="ssh-fields">
          <div class="empty-hint ssh-hint">
            Tusk opens the tunnel first, then reaches the database at the <b>Host</b> and <b>Port</b>{" "}
            above <i>as seen from the SSH server</i> — usually <code>localhost</code>. The first
            connection to a new SSH host asks you to confirm its key fingerprint.
          </div>
          <div class="field-row host-port">
            <label>
              SSH host
              <input
                value={props.state.host}
                onInput={(e) => props.onChange({ host: e.currentTarget.value })}
                placeholder="bastion.example.com"
              />
            </label>
            <label>
              Port
              <input
                type="number"
                min="1"
                max="65535"
                step="1"
                value={props.state.port}
                onInput={(e) => props.onChange({ port: Number(e.currentTarget.value) })}
              />
            </label>
          </div>
          <div class="field-row halves">
            <label>
              SSH user
              <input
                value={props.state.user}
                onInput={(e) => props.onChange({ user: e.currentTarget.value })}
                placeholder="deploy"
              />
            </label>
            <label>
              Authentication
              <select
                value={auth()}
                onChange={(e) => {
                  const next = e.currentTarget.value as SshAuthMethod;
                  // Switching method invalidates whatever secret was typed for the old one.
                  props.onChange({
                    auth: next,
                    secret: "",
                    saveSecret: sshNeedsSecret(next) ? props.state.saveSecret : false,
                  });
                }}
              >
                <option value="password">Password</option>
                <option value="key">Private key</option>
                <option value="agent">SSH agent</option>
              </select>
            </label>
          </div>
          <Show when={auth() === "key"}>
            <label>
              Private key
              <div class="file-row">
                <input
                  value={props.state.keyPath}
                  onInput={(e) => props.onChange({ keyPath: e.currentTarget.value })}
                  placeholder="~/.ssh/id_ed25519"
                />
                <button type="button" class="ghost" onClick={browseKey}>
                  Browse…
                </button>
              </div>
            </label>
          </Show>
          <Show
            when={sshNeedsSecret(auth())}
            fallback={
              <div class="empty-hint ssh-hint">
                Uses the running ssh-agent — <code>$SSH_AUTH_SOCK</code> on macOS and Linux, the
                OpenSSH agent pipe on Windows. Nothing is stored by Tusk.
              </div>
            }
          >
            <label>
              {secretLabel()}
              <input
                type="password"
                autocomplete="off"
                value={props.state.secret}
                onInput={(e) => props.onChange({ secret: e.currentTarget.value })}
                placeholder={props.hasStoredSecret ? "•••••• (stored)" : ""}
              />
            </label>
            <Show when={auth() === "key"}>
              <div class="empty-hint ssh-hint">Leave blank if the key has no passphrase.</div>
            </Show>
            <label class="checkbox">
              <input
                type="checkbox"
                checked={props.state.saveSecret}
                onChange={(e) => props.onChange({ saveSecret: e.currentTarget.checked })}
              />
              Save {auth() === "key" ? "passphrase" : "SSH password"} in the OS keychain
            </label>
          </Show>
        </div>
      </Show>
    </div>
  );
}
