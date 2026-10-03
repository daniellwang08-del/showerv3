import { html, useEffect, useRef, useState } from "../../lib/preact.js";
import * as storage from "../../storage.js";
import { ask, stopStreaming } from "../actions/job.js";
import { savePreference } from "../actions/session.js";
import { markdownToPlain, renderMarkdown } from "../format.js";
import { toast } from "../toast.js";
import { IconButton, Select } from "./components.js";
import { Icon } from "./icons.js";

export const CHAT_STYLES = [
  { value: "standard", label: "Balanced" },
  { value: "concise", label: "Short" },
  { value: "detailed", label: "Detailed" },
];

export const ANSWER_TYPES = [
  { value: "", label: "Any answer" },
  { value: "short_text", label: "One line" },
  { value: "textarea", label: "Paragraph" },
  { value: "yes_no", label: "Yes or no" },
  { value: "number", label: "Number" },
  { value: "cover_letter", label: "Cover letter" },
];

function copy(text) {
  navigator.clipboard.writeText(markdownToPlain(text)).then(
    () => toast("Copied.", "ok"),
    () => toast("Could not copy to the clipboard.", "danger"),
  );
}

function Message({ m }) {
  if (m.role === "user") return html`<div class="msg msg-user">${m.content}</div>`;
  return html`<div class=${`msg msg-assistant${m.error ? " is-error" : ""}`}>
    ${m.error && !m.content
      ? html`<p>${m.error}</p>`
      : html`<div class="md" dangerouslySetInnerHTML=${{ __html: renderMarkdown(m.content) }}></div>`}
    ${m.streaming ? html`<span class="caret" aria-hidden="true"></span>` : null}
    ${!m.streaming && m.content
      ? html`<div class="msg-tools">
          ${m.stopped ? html`<span class="muted small">Stopped</span>` : null}
          <${IconButton} icon="copy" size=${14} label="Copy answer" onClick=${() => copy(m.content)} />
        </div>`
      : null}
  </div>`;
}

export function Chat({ s }) {
  const [text, setText] = useState("");
  const listRef = useRef(null);
  const { messages, streaming } = s.chat;

  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const send = () => {
    const q = text.trim();
    if (!q || streaming) return;
    setText("");
    void ask(q);
  };
  const onKey = (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send();
    }
  };

  return html`<div class="card chat">
    ${messages.length
      ? html`<div class="chat-thread" ref=${listRef}>${messages.map((m, i) => html`<${Message} key=${i} m=${m} />`)}</div>`
      : html`<p class="chat-empty">
          Ask about an application question, or select one on the page and press
          <kbd>${storage.formatAskHotkey(s.askHotkey)}</kbd>.
        </p>`}
    <div class="composer">
      <textarea
        class="input"
        rows="2"
        placeholder="Ask about this application"
        value=${text}
        onInput=${(e) => setText(e.currentTarget.value)}
        onKeyDown=${onKey}
        aria-label="Question for the assistant"
      ></textarea>
      ${streaming
        ? html`<button type="button" class="composer-send is-stop" onClick=${stopStreaming} aria-label="Stop"><${Icon} name="stop" size=${14} /></button>`
        : html`<button type="button" class="composer-send" onClick=${send} disabled=${!text.trim()} aria-label="Send"><${Icon} name="send" size=${15} /></button>`}
    </div>
    <div class="chat-options">
      <${Select} label="Answer length" value=${s.chatStyle} options=${CHAT_STYLES} onChange=${(v) => savePreference("chatStyle", v)} />
      <${Select} label="Answer format" value=${s.answerType} options=${ANSWER_TYPES} onChange=${(v) => savePreference("answerType", v)} />
    </div>
  </div>`;
}
