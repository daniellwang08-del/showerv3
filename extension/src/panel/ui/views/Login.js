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
      <input class="input" type="url" value=${value} placeholder="https://nao.it.com" onInput=${(e) => setValue(e.currentTarget.value)} />
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
  const [websiteOpened, setWebsiteOpened] = useState(false);

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

  const signInOnWebsite = () => {
    setWebsiteOpened(true);
    chrome.tabs.create({ url: `${s.backendUrl.replace(/\/+$/, "")}/extension/connect`, active: true }).catch(() => {});
  };

  return html`<div class="login">
    <div class="login-brand">
      <img src="icons/icon128.png" alt="" width="44" height="44" />
      <h1>Sign in to NAO</h1>
      <p>Apply faster with tailored resumes and autofill.</p>
    </div>
    <div class="login-form">
      <${Button} variant="primary" block onClick=${signInOnWebsite}>Sign in with ${hostOf(s.backendUrl)}</${Button}>
      <p class="muted small">
        ${websiteOpened
          ? "Finish signing in on the website tab. This panel updates on its own."
          : "Uses your browser's saved password on the NAO website."}
      </p>
    </div>
    <p class="login-divider"><span>or use your email</span></p>
    <form class="login-form" onSubmit=${submit} noValidate>
      ${error ? html`<${Banner} tone="danger">${error}</${Banner}>` : null}
      <label class="field">
        <span class="field-label">Email</span>
        <input class="input" id="nao-login-email" name="email" type="email" inputmode="email" autocomplete="username" value=${email} onInput=${(e) => setEmail(e.currentTarget.value)} />
      </label>
      <label class="field">
        <span class="field-label">Password</span>
        <input class="input" id="nao-login-password" name="password" type="password" autocomplete="current-password" value=${password} onInput=${(e) => setPassword(e.currentTarget.value)} />
      </label>
      <label class="check">
        <input type="checkbox" checked=${remember} onChange=${(e) => setRemember(e.currentTarget.checked)} />
        <span>Remember my email</span>
      </label>
      <${Button} variant="secondary" type="submit" busy=${busy} block>Sign in</${Button}>
    </form>
    <${ServerField} backendUrl=${s.backendUrl} />
  </div>`;
}
