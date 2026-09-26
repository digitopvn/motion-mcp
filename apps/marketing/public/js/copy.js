// Progressive enhancement: reveal copy buttons only when the Clipboard API exists.
(() => {
  if (!navigator.clipboard) return;
  for (const btn of document.querySelectorAll("[data-copy-target]")) {
    const source = document.getElementById(btn.dataset.copyTarget);
    const note = btn.closest(".code-card")?.querySelector(".code-note");
    if (!source) continue;
    btn.hidden = false;
    btn.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(source.textContent.trim());
        btn.textContent = "Copied";
        if (note) note.textContent = "Copied. Replace mmcp_YOUR_API_KEY with a key from the dashboard.";
      } catch {
        btn.textContent = "Copy failed";
      }
      setTimeout(() => {
        btn.textContent = "Copy";
      }, 2000);
    });
  }
})();
