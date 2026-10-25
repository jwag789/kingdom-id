// Passkey ceremonies for Kingdom ID's sign-in pages.
//
// Progressive enhancement: every page works without this script (the email
// and password forms are open by default). When the browser supports
// WebAuthn, this reveals the passkey buttons, folds the password fallback
// away, and offers passkeys in the email field's autofill.

const supported =
  typeof window.PublicKeyCredential === "function" && typeof navigator.credentials?.create === "function";
const root = document.querySelector("[data-csrf]");

if (root && supported) init(root);

function init(root) {
  const csrf = root.dataset.csrf;
  const interaction = root.dataset.interaction || undefined;
  const errorBox = root.querySelector("[data-passkey-error]");
  const fallback = root.querySelector("[data-passkey-fallback]");
  let conditional;

  for (const button of root.querySelectorAll("[data-passkey]")) button.hidden = false;

  // Fold the password fallback unless the server just rejected something in it.
  const serverError = root.querySelector(".alert:not([data-passkey-error]), [aria-invalid='true'][name='password']");
  if (fallback && !serverError) fallback.open = false;
  // Once someone opens the email path, its submit is the action they chose.
  fallback?.addEventListener("toggle", () => {
    const submit = fallback.querySelector("[data-fallback-submit]");
    submit?.classList.toggle("btn-primary", fallback.open);
    submit?.classList.toggle("btn-secondary", !fallback.open);
  });

  const showError = (message) => {
    if (!errorBox) return;
    errorBox.textContent = message;
    errorBox.hidden = false;
  };
  const clearErrors = () => {
    if (errorBox) errorBox.hidden = true;
    for (const el of root.querySelectorAll(".field-error")) el.hidden = true;
    for (const el of root.querySelectorAll("[aria-invalid]")) el.removeAttribute("aria-invalid");
  };
  const busy = (button, on) => {
    button.disabled = on;
    button.setAttribute("aria-busy", String(on));
  };

  root.querySelector("[data-passkey='authenticate']")?.addEventListener("click", async (event) => {
    const button = event.currentTarget;
    conditional?.abort();
    clearErrors();
    busy(button, true);
    try {
      await signIn();
    } catch (err) {
      handle(err, "Passkey sign-in didn't finish.");
    } finally {
      busy(button, false);
    }
  });

  root.querySelector("[data-passkey='register']")?.addEventListener("click", async (event) => {
    const button = event.currentTarget;
    const form = button.form;
    clearErrors();
    busy(button, true);
    try {
      const options = await post("/passkeys/register/options", {
        csrf,
        mode: "signup",
        name: form.elements.name.value,
        email: form.elements.email.value,
        interaction,
      });
      await register(options);
    } catch (err) {
      handle(err, "Your passkey wasn't created.");
    } finally {
      busy(button, false);
    }
  });

  root.querySelector("[data-passkey='add']")?.addEventListener("click", async (event) => {
    const button = event.currentTarget;
    clearErrors();
    busy(button, true);
    try {
      await register(await post("/passkeys/register/options", { csrf, mode: "add" }));
    } catch (err) {
      handle(err, "Your passkey wasn't added.");
    } finally {
      busy(button, false);
    }
  });

  // Offer passkeys in the email field's autofill (conditional mediation).
  const emailField = root.querySelector("input[autocomplete~='webauthn']");
  if (emailField && PublicKeyCredential.isConditionalMediationAvailable) {
    PublicKeyCredential.isConditionalMediationAvailable().then((available) => {
      if (!available) return;
      conditional = new AbortController();
      signIn({ mediation: "conditional", signal: conditional.signal }).catch(() => {
        // Aborted (the user chose the button) or dismissed: nothing to report.
      });
    });
  }

  async function signIn(extra = {}) {
    const options = await post("/passkeys/authenticate/options", { csrf });
    const credential = await navigator.credentials.get({ publicKey: requestOptions(options), ...extra });
    const result = await post("/passkeys/authenticate", { csrf, interaction, response: credentialJSON(credential) });
    window.location.assign(result.redirect);
  }

  async function register(options) {
    const credential = await navigator.credentials.create({ publicKey: creationOptions(options) });
    const result = await post("/passkeys/register", { csrf, interaction, response: credentialJSON(credential) });
    window.location.assign(result.redirect);
  }

  function handle(err, fallbackMessage) {
    if (err?.fields) {
      for (const [name, message] of Object.entries(err.fields)) {
        const box = root.querySelector(`#${name}-error`);
        const input = root.querySelector(`[name='${name}']`);
        if (box) {
          box.textContent = message;
          box.hidden = false;
        }
        input?.setAttribute("aria-invalid", "true");
      }
      root.querySelector("[aria-invalid='true']")?.focus();
      return;
    }
    if (err?.name === "NotAllowedError" || err?.name === "AbortError") {
      showError(`${fallbackMessage} You can try again or use email instead.`);
    } else if (err?.name === "InvalidStateError") {
      showError("This device already has a passkey for your Kingdom account.");
    } else {
      showError(err?.message || fallbackMessage);
    }
    if (fallback) fallback.open = true;
  }
}

async function post(url, body) {
  const res = await fetch(url, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = new Error(data.error || "Something went wrong. Try again.");
    error.fields = data.fields;
    throw error;
  }
  return data;
}

// --- WebAuthn JSON <-> binary. Native helpers where the browser has them. ---

function fromB64url(value) {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0)).buffer;
}

function toB64url(buffer) {
  let binary = "";
  for (const byte of new Uint8Array(buffer)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const withIds = (list) => (list || []).map((c) => ({ ...c, id: fromB64url(c.id) }));

function creationOptions(o) {
  if (PublicKeyCredential.parseCreationOptionsFromJSON) return PublicKeyCredential.parseCreationOptionsFromJSON(o);
  return {
    ...o,
    challenge: fromB64url(o.challenge),
    user: { ...o.user, id: fromB64url(o.user.id) },
    excludeCredentials: withIds(o.excludeCredentials),
  };
}

function requestOptions(o) {
  if (PublicKeyCredential.parseRequestOptionsFromJSON) return PublicKeyCredential.parseRequestOptionsFromJSON(o);
  return { ...o, challenge: fromB64url(o.challenge), allowCredentials: withIds(o.allowCredentials) };
}

function credentialJSON(credential) {
  if (typeof credential.toJSON === "function") return credential.toJSON();
  const r = credential.response;
  const base = {
    id: credential.id,
    rawId: toB64url(credential.rawId),
    type: credential.type,
    authenticatorAttachment: credential.authenticatorAttachment ?? undefined,
    clientExtensionResults: credential.getClientExtensionResults(),
  };
  if (r.attestationObject) {
    return {
      ...base,
      response: {
        clientDataJSON: toB64url(r.clientDataJSON),
        attestationObject: toB64url(r.attestationObject),
        transports: r.getTransports?.() ?? [],
      },
    };
  }
  return {
    ...base,
    response: {
      clientDataJSON: toB64url(r.clientDataJSON),
      authenticatorData: toB64url(r.authenticatorData),
      signature: toB64url(r.signature),
      userHandle: r.userHandle ? toB64url(r.userHandle) : undefined,
    },
  };
}
