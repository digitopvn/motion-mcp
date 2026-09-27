// Progressive enhancement for the marketing page. Without this script every film keeps its native
// controls and the page stays fully readable.
(() => {
  // Header hairline once the page scrolls.
  const header = document.querySelector("[data-header]");
  if (header) {
    const onScroll = () => header.classList.toggle("is-scrolled", window.scrollY > 8);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
  }

  // Films: play while on screen, pause when off screen. Reduced motion keeps native controls and no autoplay.
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const films = [...document.querySelectorAll("video.film")];
  if (!reduceMotion && "IntersectionObserver" in window) {
    const pausedByUser = new WeakSet();
    const setLabel = (btn, playing) => {
      btn.textContent = playing ? "Pause" : "Play";
      btn.setAttribute("aria-label", playing ? "Pause video" : "Play video");
      btn.setAttribute("aria-pressed", String(!playing));
    };
    const observer = new IntersectionObserver(
      (entries) => {
        for (const { target, isIntersecting } of entries) {
          if (isIntersecting && !pausedByUser.has(target)) target.play().catch(() => {});
          else if (!isIntersecting) target.pause();
        }
      },
      { threshold: 0.35 },
    );
    for (const film of films) {
      const btn = film.parentElement.querySelector(".film-toggle");
      film.controls = false;
      film.preload = "metadata";
      if (btn) {
        btn.hidden = false;
        setLabel(btn, true);
        film.addEventListener("play", () => setLabel(btn, true));
        film.addEventListener("pause", () => setLabel(btn, false));
        btn.addEventListener("click", () => {
          if (film.paused) {
            pausedByUser.delete(film);
            film.play().catch(() => {});
          } else {
            pausedByUser.add(film);
            film.pause();
          }
        });
      }
      observer.observe(film);
    }
  }

  // Copy button for the config block, shown only when the Clipboard API exists.
  if (navigator.clipboard) {
    for (const btn of document.querySelectorAll("[data-copy-target]")) {
      const source = document.getElementById(btn.dataset.copyTarget);
      const note = btn.closest(".code-card")?.querySelector(".code-note");
      if (!source) continue;
      btn.hidden = false;
      btn.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(source.textContent.trim());
          btn.textContent = "Copied";
          btn.dataset.state = "done";
          if (note) note.textContent = "Copied. Replace mmcp_YOUR_API_KEY with a key from the dashboard.";
        } catch {
          btn.textContent = "Copy failed";
          if (note) note.textContent = "Your browser blocked the clipboard. Select the text and copy it by hand.";
        }
        setTimeout(() => {
          btn.textContent = "Copy";
          delete btn.dataset.state;
        }, 2000);
      });
    }
  }
})();
