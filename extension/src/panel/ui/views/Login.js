import { html, useEffect, useState } from "../../../lib/preact.js";
import * as storage from "../../../storage.js";
import { changeServer, signIn } from "../../actions/session.js";
import { Banner, Button } from "../components.js";

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return url || "";
  }
}

function ServerField({ backendUrl }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(backendUrl);
  const [error, setError] = useState(null);
  useEffect(() => setValue(backendUrl), [backendUrl]);

  const save = async (e) => {
    e.preventDefault();
    const err = await changeServer(value.trim() || null);
    setError(err);
    if (!err) setEditing(false);
  };
  const reset = async () => {
    setError(await changeServer(null));
    setEditing(false);
  };

  if (!editing) {
    return html`<p class="login-server">
      Server <strong>${hostOf(backendUrl)}</strong>
      <button type="button" class="link" onClick=${() => setEditing(true)}>Change</button>
    </p>`;
  }
  return html`<form class="login-server-form" onSubmit=${save}>
    <label class="field">
      <span class="field-label">Server address</span>
      <input class="input" type="url" value=${value} placeholder="https://atomspace.it.com" onInput=${(e) => setValue(e.currentTarget.value)} />
    </label>
    ${error ? html`<p class="field-error">${error}</p>` : null}
    <div class="row-actions">
      <${Button} variant="ghost" size="sm" onClick=${reset}>Use default</${Button}>
      <${Button} variant="secondary" size="sm" type="submit">Save</${Button}>
    </div>
  </form>`;
}

export function LoginView({ s }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    storage.getRememberedEmail().then((saved) => {
      if (saved) setEmail(saved);
    });
  }, []);

  const submit = async (e) => {
    e.preventDefault();
    if (!email.trim() || !password) {
      setError("Enter your email and password.");
      return;
    }
    setBusy(true);
    setError(null);
    const err = await signIn({ email, password, remember });
    setBusy(false);
    if (err) setError(err);
  };

  return html`<div class="login">
    <div class="login-brand">
      <img src="icons/icon128.png" alt="" width="44" height="44" />
      <h1>Sign in to NAO</h1>
      <p>Apply faster with tailored resumes and autofill.</p>
    </div>
    <form class="login-form" onSubmit=${submit} noValidate>
      ${error ? html`<${Banner} tone="danger">${error}</${Banner}>` : null}
      <label class="field">
        <span class="field-label">Email</span>
        <input class="input" type="email" autocomplete="username" value=${email} onInput=${(e) => setEmail(e.currentTarget.value)} autofocus=${!email} />
      </label>
      <label class="field">
        <span class="field-label">Password</span>
        <input class="input" type="password" autocomplete="current-password" value=${password} onInput=${(e) => setPassword(e.currentTarget.value)} autofocus=${!!email} />
      </label>
      <label class="check">
        <input type="checkbox" checked=${remember} onChange=${(e) => setRemember(e.currentTarget.checked)} />
        <span>Remember my email</span>
      </label>
      <${Button} variant="primary" type="submit" busy=${busy} block>Sign in</${Button}>
    </form>
    <${ServerField} backendUrl=${s.backendUrl} />
  </div>`;
}
