import type { Passkey } from "@kingdom-id/db";
import { type Scope } from "../oauth/scopes.js";
import { Icon, type IconName } from "./icons.js";
import { AuthLayout, CoBrand, FieldError, type AppIdentity, type Ui } from "./layout.js";

type Errors = Partial<Record<"form" | "name" | "email" | "password", string>>;

/** Shown wherever an app is about to receive an email address, once the relay exists. */
function TrustNote({ ui, app }: { ui: Ui; app?: AppIdentity | undefined }) {
  if (!ui.relay || !app) return null;
  return (
    <p class="trust">
      <Icon name="shield" />
      <span>
        {app.name} gets a <strong>private email address</strong>, never your real one.
      </span>
    </p>
  );
}

/** Where passkey.js reports a failed or cancelled ceremony. */
const PasskeyError = () => <p class="alert" role="alert" data-passkey-error hidden />;

export function LoginPage(props: {
  ui: Ui;
  csrf: string;
  passwordAction: string;
  signupHref: string;
  app?: AppIdentity | undefined;
  interactionId?: string | undefined;
  email?: string | undefined;
  error?: string | undefined;
  /** The app asked for a phishing-resistant sign-in (acr_values=phr). */
  stepUp?: boolean | undefined;
}) {
  const { app } = props;
  return (
    <AuthLayout title="Sign in" ui={props.ui}>
      <section class="card" aria-labelledby="title" data-csrf={props.csrf} data-interaction={props.interactionId}>
        <CoBrand app={app} />
        <h1 id="title">{app ? `Sign in to ${app.name}` : "Sign in to Kingdom"}</h1>
        <p class="lede">{app ? "with your Kingdom account" : "Welcome back."}</p>
        {props.stepUp && (
          <p class="notice">
            <Icon name="shield" />
            <span>{app?.name ?? "This app"} asks you to confirm it's you with a passkey.</span>
          </p>
        )}
        {props.error && (
          <p class="alert" role="alert">
            {props.error}
          </p>
        )}
        <PasskeyError />

        <button type="button" class="btn btn-primary btn-block" data-passkey="authenticate" hidden>
          <Icon name="passkey" />
          Continue with a passkey
        </button>

        {/* Open by default so it works without JavaScript; passkey.js folds it away when passkeys are available. */}
        <details class="fallback" data-passkey-fallback open>
          <summary>
            <span>Use email and password instead</span>
          </summary>
          <form method="post" action={props.passwordAction} class="fields" novalidate>
            <input type="hidden" name="csrf" value={props.csrf} />
            <label for="email">Email</label>
            <input id="email" name="email" type="email" autocomplete="username webauthn" required value={props.email ?? ""} />
            <label for="password">Password</label>
            <input id="password" name="password" type="password" autocomplete="current-password" required />
            <button id="password-submit" type="submit" class="btn btn-primary btn-block" data-fallback-submit>
              Sign in
            </button>
          </form>
        </details>

        <TrustNote ui={props.ui} app={app} />
        <p class="switch">
          New to Kingdom? <a href={props.signupHref}>Create an account</a>
        </p>
      </section>
    </AuthLayout>
  );
}

export function SignupPage(props: {
  ui: Ui;
  csrf: string;
  passwordAction: string;
  loginHref: string;
  app?: AppIdentity | undefined;
  interactionId?: string | undefined;
  values?: { name?: string; email?: string } | undefined;
  errors?: Errors | undefined;
}) {
  const e = props.errors ?? {};
  const { app } = props;
  return (
    <AuthLayout title="Create your account" ui={props.ui}>
      <section class="card" aria-labelledby="title" data-csrf={props.csrf} data-interaction={props.interactionId}>
        <CoBrand app={app} />
        <h1 id="title">Create your Kingdom account</h1>
        <p class="lede">{app ? `One account for ${app.name} and every Kingdom app.` : "One account for every Kingdom app."}</p>
        {e.form && (
          <p class="alert" role="alert">
            {e.form}
          </p>
        )}
        <PasskeyError />

        <form method="post" action={props.passwordAction} class="fields" novalidate data-signup-form>
          <input type="hidden" name="csrf" value={props.csrf} />
          <label for="name">Name</label>
          <input id="name" name="name" autocomplete="name" required value={props.values?.name ?? ""}
            aria-invalid={e.name ? "true" : undefined} aria-describedby="name-error" />
          <FieldError id="name-error" message={e.name} />
          <label for="email">Email</label>
          <input id="email" name="email" type="email" autocomplete="email" required value={props.values?.email ?? ""}
            aria-invalid={e.email ? "true" : undefined} aria-describedby="email-error" />
          <FieldError id="email-error" message={e.email} />

          <button type="button" class="btn btn-primary btn-block" data-passkey="register" hidden>
            <Icon name="passkey" />
            Sign up with a passkey
          </button>

          {/* Open by default so it works without JavaScript; passkey.js folds it away when passkeys are available. */}
          <details class="fallback" data-passkey-fallback open>
            <summary>
              <span>Use a password instead</span>
            </summary>
            <div class="fields">
              <label for="password">Password</label>
              <input id="password" name="password" type="password" autocomplete="new-password" minLength={10}
                aria-invalid={e.password ? "true" : undefined} aria-describedby="password-hint password-error" />
              <p class="hint" id="password-hint">At least 10 characters. A passphrase works well.</p>
              <FieldError id="password-error" message={e.password} />
              <button id="password-submit" type="submit" class="btn btn-primary btn-block" data-fallback-submit>
                Create account
              </button>
            </div>
          </details>
        </form>

        <TrustNote ui={props.ui} app={app} />
        <p class="switch">
          Already have an account? <a href={props.loginHref}>Sign in</a>
        </p>
      </section>
    </AuthLayout>
  );
}

export function ConsentPage(props: {
  ui: Ui;
  action: string;
  csrf: string;
  app: AppIdentity;
  host: string;
  user: { name: string; email: string };
  scopes: readonly Scope[];
  /** Whether this app gets its own pairwise ID (third party) or the shared Kingdom ID (first party). */
  pairwise: boolean;
  switchHref: string;
}) {
  const { app, user, ui } = props;
  const items: { icon: IconName; title: string; detail?: string }[] = [
    props.pairwise
      ? { icon: "id", title: `A Kingdom ID just for ${app.name}`, detail: "Other apps can't use it to recognize you." }
      : { icon: "id", title: "Your Kingdom ID", detail: "Shared across Kingdom's own apps." },
  ];
  if (props.scopes.includes("profile")) items.push({ icon: "user", title: "Your name", detail: user.name });
  if (props.scopes.includes("email")) {
    items.push(
      ui.relay
        ? { icon: "mail", title: "A private email address", detail: `Forwards to you; ${app.name} never sees ${user.email}.` }
        : { icon: "mail", title: "Your email address", detail: user.email },
    );
  }
  if (props.scopes.includes("offline_access")) {
    items.push({ icon: "refresh", title: "Stay connected", detail: "Access while you're away, until you disconnect it." });
  }

  return (
    <AuthLayout title={`Continue to ${app.name}`} ui={ui}>
      <section class="card" aria-labelledby="title">
        <CoBrand app={app} />
        <h1 id="title">Continue to {app.name}?</h1>
        <div class="account-chip">
          <span class="avatar" aria-hidden="true">
            {user.name.slice(0, 1).toUpperCase()}
          </span>
          <span class="account-chip-text">
            <strong>{user.name}</strong>
            <span>{user.email}</span>
          </span>
          <a href={props.switchHref} class="account-chip-switch">
            Not you?
          </a>
        </div>

        <h2 class="subhead">{app.name} will receive</h2>
        <ul class="grants">
          {items.map((item) => (
            <li>
              <Icon name={item.icon} />
              <span>
                <strong>{item.title}</strong>
                {item.detail && <span>{item.detail}</span>}
              </span>
            </li>
          ))}
        </ul>

        <form method="post" action={props.action} class="actions">
          <input type="hidden" name="csrf" value={props.csrf} />
          <button type="submit" name="decision" value="deny" class="btn btn-secondary">
            Cancel
          </button>
          <button id="allow" type="submit" name="decision" value="allow" class="btn btn-primary">
            Allow
          </button>
        </form>
        <p class="footnote">
          You'll return to <strong>{props.host}</strong>. You can disconnect {app.name} from your Kingdom account at any
          time.
        </p>
      </section>
    </AuthLayout>
  );
}

export function MessagePage(props: { ui: Ui; title: string; message: string; tone?: "error" | "info" }) {
  return (
    <AuthLayout title={props.title} ui={props.ui}>
      <section class="card" aria-labelledby="title">
        <CoBrand />
        <div class={props.tone === "error" ? "message message-error" : "message"}>
          <Icon name={props.tone === "error" ? "alert" : "check"} />
          <h1 id="title">{props.title}</h1>
        </div>
        <p class="lede">{props.message}</p>
      </section>
    </AuthLayout>
  );
}

export function LogoutPage(props: {
  ui: Ui;
  csrf: string;
  email: string;
  appName?: string | undefined;
  hidden: Record<string, string | undefined>;
}) {
  return (
    <AuthLayout title="Sign out" ui={props.ui}>
      <section class="card" aria-labelledby="title">
        <CoBrand />
        <h1 id="title">Sign out of Kingdom?</h1>
        <p class="lede">
          {props.appName ? `${props.appName} asked to sign you out. ` : ""}You're signed in as <strong>{props.email}</strong>.
        </p>
        <form method="post" action="/end-session/confirm" class="actions">
          <input type="hidden" name="csrf" value={props.csrf} />
          {Object.entries(props.hidden).map(([name, value]) =>
            value !== undefined ? <input type="hidden" name={name} value={value} /> : null,
          )}
          <button type="submit" name="decision" value="stay" class="btn btn-secondary">
            Stay signed in
          </button>
          <button type="submit" name="decision" value="logout" class="btn btn-primary">
            Sign out
          </button>
        </form>
      </section>
    </AuthLayout>
  );
}

const date = (d: Date) => d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });

export function AccountPage(props: {
  ui: Ui;
  csrf: string;
  user: { name: string; email: string; emailVerified: boolean; hasPassword: boolean };
  passkeys: Passkey[];
  notice?: string | undefined;
  error?: string | undefined;
}) {
  const { user } = props;
  const canRemove = props.passkeys.length > 1 || user.hasPassword;
  return (
    <AuthLayout title="Your account" ui={props.ui}>
      <section class="card card-wide" aria-labelledby="title" data-csrf={props.csrf}>
        <CoBrand />
        <h1 id="title">Hi, {user.name}</h1>
        <p class="lede">
          {user.email} · {user.emailVerified ? "verified" : "not verified yet"}
        </p>
        {props.notice && (
          <p class="notice" role="status">
            <Icon name="check" />
            <span>{props.notice}</span>
          </p>
        )}
        {props.error && (
          <p class="alert" role="alert">
            {props.error}
          </p>
        )}
        <PasskeyError />

        <h2 class="subhead">Passkeys</h2>
        {props.passkeys.length === 0 ? (
          <p class="hint">
            You sign in with a password. Add a passkey to sign in with your face, fingerprint or device PIN instead.
          </p>
        ) : (
          <ul class="passkeys">
            {props.passkeys.map((p) => (
              <li>
                <Icon name="passkey" />
                <span class="passkey-text">
                  <strong>{p.name}</strong>
                  <span>
                    Added {date(p.createdAt)}
                    {p.lastUsedAt ? ` · last used ${date(p.lastUsedAt)}` : ""}
                    {p.backedUp ? " · synced" : ""}
                  </span>
                </span>
                {canRemove && (
                  <form method="post" action={`/account/passkeys/${p.id}/delete`}>
                    <input type="hidden" name="csrf" value={props.csrf} />
                    <button type="submit" class="btn-icon" aria-label={`Remove ${p.name}, added ${date(p.createdAt)}`}>
                      <Icon name="trash" />
                    </button>
                  </form>
                )}
              </li>
            ))}
          </ul>
        )}
        <button type="button" class="btn btn-secondary" data-passkey="add" hidden>
          <Icon name="passkey" />
          Add a passkey
        </button>

        <h2 class="subhead">Password</h2>
        <p class="hint">{user.hasPassword ? "A password is set as a fallback." : "No password. You sign in with passkeys only."}</p>

        <form method="post" action="/logout" class="signout">
          <input type="hidden" name="csrf" value={props.csrf} />
          <button type="submit" class="btn btn-secondary">
            Sign out
          </button>
        </form>
      </section>
    </AuthLayout>
  );
}
