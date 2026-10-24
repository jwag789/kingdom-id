import { CardHeader, FieldError, Layout, type AppIdentity } from "./layout.js";
import { SCOPE_DESCRIPTIONS, type Scope } from "../oauth/scopes.js";

type Errors = Partial<Record<"form" | "name" | "email" | "password", string>>;

export function LoginPage(props: {
  action: string;
  signupHref: string;
  csrf: string;
  app?: AppIdentity | undefined;
  email?: string | undefined;
  error?: string | undefined;
}) {
  return (
    <Layout title="Sign in">
      <section class="card" aria-labelledby="title">
        <CardHeader app={props.app} />
        <h1 id="title">Sign in</h1>
        <p class="lede">{props.app ? `to continue to ${props.app.name}` : "to your Kingdom account"}</p>
        {props.error && (
          <p class="alert" role="alert">
            {props.error}
          </p>
        )}
        <form method="post" action={props.action} novalidate>
          <input type="hidden" name="csrf" value={props.csrf} />
          <label for="email">Email</label>
          <input id="email" name="email" type="email" autocomplete="username webauthn" required value={props.email ?? ""} />
          <label for="password">Password</label>
          <input id="password" name="password" type="password" autocomplete="current-password" required />
          <button type="submit" class="primary">
            Sign in
          </button>
        </form>
        <p class="switch">
          New to Kingdom? <a href={props.signupHref}>Create an account</a>
        </p>
      </section>
    </Layout>
  );
}

export function SignupPage(props: {
  action: string;
  loginHref: string;
  csrf: string;
  app?: AppIdentity | undefined;
  values?: { name?: string; email?: string } | undefined;
  errors?: Errors | undefined;
}) {
  const e = props.errors ?? {};
  return (
    <Layout title="Create your account">
      <section class="card" aria-labelledby="title">
        <CardHeader app={props.app} />
        <h1 id="title">Create your Kingdom account</h1>
        <p class="lede">One account for every Kingdom app.</p>
        {e.form && (
          <p class="alert" role="alert">
            {e.form}
          </p>
        )}
        <form method="post" action={props.action} novalidate>
          <input type="hidden" name="csrf" value={props.csrf} />
          <label for="name">Name</label>
          <input id="name" name="name" autocomplete="name" required value={props.values?.name ?? ""}
            aria-invalid={e.name ? "true" : undefined} aria-describedby={e.name ? "name-error" : undefined} />
          <FieldError id="name-error" message={e.name} />
          <label for="email">Email</label>
          <input id="email" name="email" type="email" autocomplete="email" required value={props.values?.email ?? ""}
            aria-invalid={e.email ? "true" : undefined} aria-describedby={e.email ? "email-error" : undefined} />
          <FieldError id="email-error" message={e.email} />
          <label for="password">Password</label>
          <input id="password" name="password" type="password" autocomplete="new-password" required minLength={10}
            aria-invalid={e.password ? "true" : undefined} aria-describedby="password-hint" />
          <p class="hint" id="password-hint">At least 10 characters. A passphrase works well.</p>
          <FieldError id="password-error" message={e.password} />
          <button type="submit" class="primary">
            Create account
          </button>
        </form>
        <p class="switch">
          Already have an account? <a href={props.loginHref}>Sign in</a>
        </p>
      </section>
    </Layout>
  );
}

export function ConsentPage(props: {
  action: string;
  csrf: string;
  app: AppIdentity;
  host: string;
  userEmail: string;
  scopes: Scope[];
  switchHref: string;
}) {
  const items = props.scopes.map((s) => SCOPE_DESCRIPTIONS[s]).filter((d): d is string => !!d);
  return (
    <Layout title={`Continue to ${props.app.name}`}>
      <section class="card" aria-labelledby="title">
        <CardHeader app={props.app} />
        <h1 id="title">Continue to {props.app.name}?</h1>
        <p class="lede">
          Signed in as <strong>{props.userEmail}</strong>. <a href={props.switchHref}>Not you?</a>
        </p>
        <h2 class="subhead">{props.app.name} will receive</h2>
        <ul class="scopes">
          <li>A Kingdom ID unique to this app</li>
          {items.map((d) => (
            <li>{d}</li>
          ))}
        </ul>
        <p class="hint">
          You'll return to <strong>{props.host}</strong>. You can disconnect this app from your Kingdom account at any time.
        </p>
        <form method="post" action={props.action} class="actions">
          <input type="hidden" name="csrf" value={props.csrf} />
          <button type="submit" name="decision" value="deny" class="secondary">
            Cancel
          </button>
          <button type="submit" name="decision" value="allow" class="primary">
            Allow
          </button>
        </form>
      </section>
    </Layout>
  );
}

export function MessagePage(props: { title: string; message: string; tone?: "error" | "info" }) {
  return (
    <Layout title={props.title}>
      <section class="card" aria-labelledby="title">
        <CardHeader />
        <h1 id="title">{props.title}</h1>
        <p class={props.tone === "error" ? "lede error" : "lede"}>{props.message}</p>
      </section>
    </Layout>
  );
}

export function AccountPage(props: { name: string; email: string; emailVerified: boolean; csrf: string }) {
  return (
    <Layout title="Your account">
      <section class="card" aria-labelledby="title">
        <CardHeader />
        <h1 id="title">Hi, {props.name}</h1>
        <p class="lede">
          {props.email} · {props.emailVerified ? "verified" : "not verified yet"}
        </p>
        <p class="hint">Your Kingdom dashboard arrives in a later release.</p>
        <form method="post" action="/logout">
          <input type="hidden" name="csrf" value={props.csrf} />
          <button type="submit" class="secondary">
            Sign out
          </button>
        </form>
      </section>
    </Layout>
  );
}
