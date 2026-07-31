async function exportPlatform(platform) {
  const status = document.getElementById("status");
  status.textContent = `Exporting ${platform}...`;
  const result = await chrome.runtime.sendMessage({ type: "export", platform });
  if (result && result.ok) {
    status.textContent = `Saved ${result.cookie_count} cookies for ${platform}.`;
  } else {
    status.textContent =
      (result && result.error) ||
      "Bridge not running. Start: python -m app.scraper.auth capture rrs";
  }
}

document.getElementById("rrs").addEventListener("click", () => exportPlatform("rrs"));
document.getElementById("jobright").addEventListener("click", () =>
  exportPlatform("jobright"),
);
