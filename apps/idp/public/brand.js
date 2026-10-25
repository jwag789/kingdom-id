// The button builder (/brand). Without this script the builder still works:
// the form submits with "Update preview", and the code can be selected by hand.
// With it, a change re-renders only the preview and code, from the server, so
// the markup has one source and focus stays on the option just picked.
const form = document.querySelector("[data-builder]");

function enableCopy(root) {
  if (!navigator.clipboard) return;
  for (const button of root.querySelectorAll("[data-copy]")) {
    button.hidden = false;
    button.addEventListener("click", async () => {
      const code = document.getElementById(button.dataset.copy);
      try {
        await navigator.clipboard.writeText(code.textContent);
        button.textContent = "Copied";
      } catch {
        button.textContent = "Select and copy";
      }
      setTimeout(() => (button.textContent = "Copy"), 2000);
    });
  }
}

if (form) {
  form.querySelector("[data-builder-submit]").hidden = true;
  form.addEventListener("change", async () => {
    const url = `${form.action}?${new URLSearchParams(new FormData(form))}`;
    try {
      const res = await fetch(url, { headers: { accept: "text/html" } });
      if (!res.ok) throw new Error(String(res.status));
      const next = new DOMParser().parseFromString(await res.text(), "text/html").querySelector("[data-builder-result]");
      const current = form.querySelector("[data-builder-result]");
      current.replaceWith(next);
      enableCopy(next);
      history.replaceState(null, "", url);
    } catch {
      form.submit();
    }
  });
}

enableCopy(document);
