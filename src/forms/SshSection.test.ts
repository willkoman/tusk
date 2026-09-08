import { describe, expect, it } from "vitest";
import {
  SSH_DEFAULT_PORT,
  emptySshForm,
  sshFormFromProfile,
  sshNeedsSecret,
  sshPayload,
  validateSshForm,
  type SshFormState,
} from "./SshSection";

const enabled = (over: Partial<SshFormState> = {}): SshFormState => ({
  ...emptySshForm(),
  enabled: true,
  host: "bastion.example",
  user: "deploy",
  secret: "hunter2",
  ...over,
});

describe("sshPayload", () => {
  it("is null when the tunnel is off, so a direct connect sends no ssh block", () => {
    expect(sshPayload(emptySshForm(), true)).toBeNull();
    expect(sshPayload({ ...enabled(), enabled: false }, true)).toBeNull();
  });

  it("routes the typed secret to the field its auth method reads", () => {
    expect(sshPayload(enabled(), true)).toEqual({
      host: "bastion.example",
      port: SSH_DEFAULT_PORT,
      user: "deploy",
      auth: "password",
      key_path: null,
      ssh_password: "hunter2",
    });
    expect(sshPayload(enabled({ auth: "key", keyPath: "/k/id_ed25519" }), true)).toEqual({
      host: "bastion.example",
      port: SSH_DEFAULT_PORT,
      user: "deploy",
      auth: "key",
      key_path: "/k/id_ed25519",
      ssh_key_passphrase: "hunter2",
    });
  });

  it("never attaches a secret to agent auth", () => {
    const payload = sshPayload(enabled({ auth: "agent" }), true)!;
    expect(payload).not.toHaveProperty("ssh_password");
    expect(payload).not.toHaveProperty("ssh_key_passphrase");
    expect(sshNeedsSecret("agent")).toBe(false);
    expect(sshNeedsSecret("password")).toBe(true);
    expect(sshNeedsSecret("key")).toBe(true);
  });

  it("omits every secret from profile metadata, whichever method is selected", () => {
    for (const state of [
      enabled(),
      enabled({ auth: "key", keyPath: "/k" }),
      enabled({ auth: "agent" }),
    ]) {
      const metadata = sshPayload(state, false)!;
      expect(JSON.stringify(metadata)).not.toContain("hunter2");
      expect(metadata).not.toHaveProperty("ssh_password");
      expect(metadata).not.toHaveProperty("ssh_key_passphrase");
    }
  });

  it("drops a key path that no longer applies and trims stray whitespace", () => {
    // Switching back to password auth must not smuggle the old key path through.
    expect(sshPayload(enabled({ keyPath: "/left/over" }), true)!.key_path).toBeNull();
    const payload = sshPayload(enabled({ host: "  h  ", user: " u ", auth: "key", keyPath: " /k " }), true)!;
    expect(payload.host).toBe("h");
    expect(payload.user).toBe("u");
    expect(payload.key_path).toBe("/k");
  });
});

describe("validateSshForm", () => {
  it("passes a disabled tunnel regardless of its leftover fields", () => {
    expect(validateSshForm({ ...emptySshForm(), host: "", port: 0 })).toBe("");
  });

  it("requires a host, a user, a sane port, and a key file for key auth", () => {
    expect(validateSshForm(enabled())).toBe("");
    expect(validateSshForm(enabled({ host: "   " }))).toMatch(/host/);
    expect(validateSshForm(enabled({ user: "" }))).toMatch(/user/);
    expect(validateSshForm(enabled({ port: 0 }))).toMatch(/port/);
    expect(validateSshForm(enabled({ port: 70000 }))).toMatch(/port/);
    expect(validateSshForm(enabled({ port: 22.5 }))).toMatch(/port/);
    expect(validateSshForm(enabled({ auth: "key" }))).toMatch(/key file/);
    expect(validateSshForm(enabled({ auth: "key", keyPath: "/k" }))).toBe("");
    // Agent auth needs no secret and no key.
    expect(validateSshForm(enabled({ auth: "agent", secret: "" }))).toBe("");
  });
});

describe("sshFormFromProfile", () => {
  it("loads metadata with an empty secret box, since the secret lives in the keychain", () => {
    const state = sshFormFromProfile(
      { host: "bastion", port: 2222, user: "deploy", auth: "key", key_path: "/k" },
      true,
    );
    expect(state).toEqual({
      enabled: true,
      host: "bastion",
      port: 2222,
      user: "deploy",
      auth: "key",
      keyPath: "/k",
      secret: "",
      saveSecret: true,
    });
  });

  it("treats a missing tunnel as off", () => {
    expect(sshFormFromProfile(null, true)).toEqual(emptySshForm());
    expect(sshFormFromProfile(undefined, false)).toEqual(emptySshForm());
  });

  it("never claims a stored secret for agent auth", () => {
    const state = sshFormFromProfile({ host: "b", port: 22, user: "u", auth: "agent" }, true);
    expect(state.saveSecret).toBe(false);
  });

  it("falls back to sane values for metadata that is out of range or unrecognized", () => {
    const state = sshFormFromProfile(
      { host: "b", port: 0, user: "u", auth: "kerberos", key_path: null },
      true,
    );
    expect(state.port).toBe(SSH_DEFAULT_PORT);
    expect(state.auth).toBe("password");
    expect(state.keyPath).toBe("");
  });
});
