import type { Alert, Client, Perk } from "@kingdom-id/db";
import type { ComponentChildren } from "preact";
import { formatDate, formatTime, relativeTime } from "./format.js";
import { Icon } from "./icons.js";
import { Document, FieldError, type Ui } from "./layout.js";

function AdminShell(props: { title: string; section: "perks" | "alerts"; ui: Ui; user: { name: string }; children: ComponentChildren }) {
  return (
    <Document title={`${props.title} · Admin`} ui={props.ui}>
      <a class="skip-link" href="#main">
        Skip to {props.title}
      </a>
      <header class="dash-header dash-header-compact">
        <div class="dash-bar">
          <a class="dash-brand" href="/account">
            <span class="cobrand-mark">
              <img src="/brand/kingdom-mark-white.png" alt="" width="44" height="24" />
            </span>
            <span>
              <strong>Kingdom ID admin</strong>
              <small>Signed in as {props.user.name}</small>
            </span>
          </a>
          <a class="dash-admin" href="/account">
            Back to Your Kingdom
          </a>
        </div>
        <nav class="dash-nav" aria-label="Admin">
          <a href="/admin" aria-current={props.section === "perks" ? "page" : undefined}>
            <Icon name="crown" />
            Perks
          </a>
          <a href="/admin/alerts" aria-current={props.section === "alerts" ? "page" : undefined}>
            <Icon name="tower" />
            Alerts
          </a>
        </nav>
      </header>
      <main id="main" class="dash-main">
        {props.children}
      </main>
    </Document>
  );
}

const RULES: { value: Perk["rule"]; label: string }[] = [
  { value: "connected", label: "Connected the app" },
  { value: "connected_days", label: "Connected for N days" },
  { value: "connected_apps", label: "Connected N Kingdom apps" },
  { value: "manual", label: "Granted by hand" },
];

const ruleText = (perk: Perk) =>
  perk.rule === "connected"
    ? "Unlocks on connecting the app"
    : perk.rule === "connected_days"
      ? `Unlocks after ${perk.threshold} days connected`
      : perk.rule === "connected_apps"
        ? `Unlocks at ${perk.threshold} connected Kingdom apps`
        : "Granted by hand";

export interface AdminPageProps {
  ui: Ui;
  csrf: string;
  user: { name: string };
  clients: Client[];
  perks: { perk: Perk; client: Client }[];
  notice?: string | undefined;
  error?: string | undefined;
  values?: Record<string, string> | undefined;
  errors?: Record<string, string> | undefined;
}

export function AdminPage(props: AdminPageProps) {
  const v = props.values ?? {};
  const e = props.errors ?? {};
  return (
    <AdminShell title="Perks" section="perks" ui={props.ui} user={props.user}>
        <div class="dash-section-head">
          <h1>Perks</h1>
          <p class="lede">
            What each app offers, and the rule that unlocks it. Unlocked perks reach first-party apps as the <code class="mono">perks</code>{" "}
            claim.
          </p>
        </div>
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

        {props.perks.length === 0 ? (
          <p class="hint">No perks yet. Create the first one below.</p>
        ) : (
          <ul class="admin-perks">
            {props.perks.map(({ perk, client }) => (
              <li class={perk.active ? "panel admin-perk" : "panel admin-perk admin-perk-off"}>
                <div class="admin-perk-head">
                  <div>
                    <h2>{perk.name}</h2>
                    <p class="mono">{perk.slug}</p>
                  </div>
                  <span class="badge">{perk.active ? "Active" : "Paused"}</span>
                </div>
                <p>{perk.description}</p>
                <p class="hint">
                  {client.name} · {ruleText(perk)}
                </p>
                <div class="admin-perk-actions">
                  <form method="post" action={`/admin/perks/${perk.id}/toggle`}>
                    <input type="hidden" name="csrf" value={props.csrf} />
                    <button type="submit" class="btn btn-secondary btn-small">
                      {perk.active ? "Pause" : "Resume"} {perk.name}
                    </button>
                  </form>
                  <form method="post" action={`/admin/perks/${perk.id}/delete`}>
                    <input type="hidden" name="csrf" value={props.csrf} />
                    <button type="submit" class="btn btn-danger btn-small">
                      Delete {perk.name}
                    </button>
                  </form>
                </div>
                {perk.rule === "manual" && (
                  <form method="post" action={`/admin/perks/${perk.id}/grant`} class="admin-grant">
                    <input type="hidden" name="csrf" value={props.csrf} />
                    <label for={`grant-${perk.id}`}>Grant {perk.name} to</label>
                    <div class="inline-field">
                      <input id={`grant-${perk.id}`} name="email" type="email" placeholder="member@example.com" required />
                      <button type="submit" class="btn btn-primary btn-small" aria-label={`Grant ${perk.name}`}>
                        Grant
                      </button>
                    </div>
                  </form>
                )}
              </li>
            ))}
          </ul>
        )}

        <form method="post" action="/admin/perks" class="panel fields admin-create" novalidate>
          <h2 class="panel-title">Create a perk</h2>
          <input type="hidden" name="csrf" value={props.csrf} />
          <label for="clientId">Offered by</label>
          <select id="clientId" name="clientId" required>
            {props.clients.map((c) => (
              <option value={c.id} selected={v.clientId === c.id}>
                {c.name}
                {c.firstParty ? "" : " (third party)"}
              </option>
            ))}
          </select>
          <label for="slug">Perk ID</label>
          <input id="slug" name="slug" required value={v.slug ?? ""} placeholder="cappuccino.early-supporter"
            aria-invalid={e.slug ? "true" : undefined} aria-describedby="slug-hint slug-error" />
          <p class="hint" id="slug-hint">Apps key on this. It can't change later.</p>
          <FieldError id="slug-error" message={e.slug} />
          <label for="name">Name</label>
          <input id="name" name="name" required value={v.name ?? ""} aria-invalid={e.name ? "true" : undefined} aria-describedby="name-error" />
          <FieldError id="name-error" message={e.name} />
          <label for="description">What it gives</label>
          <input id="description" name="description" required value={v.description ?? ""}
            aria-invalid={e.description ? "true" : undefined} aria-describedby="description-error" />
          <FieldError id="description-error" message={e.description} />
          <label for="rule">Unlocks when</label>
          <select id="rule" name="rule">
            {RULES.map((r) => (
              <option value={r.value} selected={v.rule === r.value}>
                {r.label}
              </option>
            ))}
          </select>
          <label for="threshold">N (days or apps)</label>
          <input id="threshold" name="threshold" type="number" min="1" value={v.threshold ?? ""}
            aria-invalid={e.threshold ? "true" : undefined} aria-describedby="threshold-hint threshold-error" />
          <p class="hint" id="threshold-hint">Only for the "N days" and "N apps" rules.</p>
          <FieldError id="threshold-error" message={e.threshold} />
          <button type="submit" class="btn btn-primary">
            Create perk
          </button>
        </form>
    </AdminShell>
  );
}

const RULE_NAMES: Record<string, string> = {
  failed_login_burst: "Failed sign-in burst",
  credential_stuffing: "Credential stuffing",
  refresh_token_reuse: "Refresh token reuse",
  code_replay: "Authorization code replay",
  relay_spoof: "Relay spoofing",
  new_network: "New network",
  new_country: "New country",
};

export interface AlertsPageProps {
  ui: Ui;
  csrf: string;
  user: { name: string };
  filter: "open" | "all";
  alerts: { alert: Alert; email: string | null }[];
  health: { length: number; pending: number; lag: number; deadLetters: number };
  notice?: string | undefined;
}

export function AlertsPage(props: AlertsPageProps) {
  const { health } = props;
  return (
    <AdminShell title="Alerts" section="alerts" ui={props.ui} user={props.user}>
      <div class="dash-section-head">
        <h1>Alerts</h1>
        <p class="lede">What the detection rules raised from the security event stream.</p>
      </div>
      {props.notice && (
        <p class="notice" role="status">
          <Icon name="check" />
          <span>{props.notice}</span>
        </p>
      )}
      <dl class="pipeline-health" aria-label="Event pipeline health">
        <div>
          <dt>Waiting</dt>
          <dd>{health.lag}</dd>
        </div>
        <div>
          <dt>In flight</dt>
          <dd>{health.pending}</dd>
        </div>
        <div class={health.deadLetters > 0 ? "health-bad" : undefined}>
          <dt>Dead letters</dt>
          <dd>{health.deadLetters}</dd>
        </div>
        <div>
          <dt>On stream</dt>
          <dd>{health.length}</dd>
        </div>
      </dl>
      <p class="filter-links">
        Show{" "}
        <a href="/admin/alerts" aria-current={props.filter === "open" ? "page" : undefined}>
          open
        </a>{" "}
        ·{" "}
        <a href="/admin/alerts?filter=all" aria-current={props.filter === "all" ? "page" : undefined}>
          all
        </a>
      </p>
      {props.alerts.length === 0 ? (
        <div class="empty">
          <Icon name="tower" />
          <h2>{props.filter === "open" ? "No open alerts" : "No alerts yet"}</h2>
          <p>Rules watch for failed sign-in bursts, credential stuffing, token reuse and sign-ins from new places.</p>
        </div>
      ) : (
        <ol class="admin-alerts">
          {props.alerts.map(({ alert, email }) => (
            <li class={`panel admin-alert severity-${alert.severity}`}>
              <div class="admin-alert-head">
                <span class={`severity severity-${alert.severity}`}>{alert.severity}</span>
                <strong>{RULE_NAMES[alert.rule] ?? alert.rule}</strong>
                <time datetime={alert.createdAt.toISOString()} title={`${formatDate(alert.createdAt)} ${formatTime(alert.createdAt)}`}>
                  {relativeTime(alert.createdAt)}
                </time>
              </div>
              <p>{alert.summary}</p>
              <p class="hint">
                {email ? `Account ${email}` : "No single account"}
                {alert.ip ? ` · IP ${alert.ip}` : ""}
                {alert.clientId ? ` · app ${alert.clientId}` : ""}
              </p>
              {alert.acknowledgedAt ? (
                <p class="hint">Acknowledged {relativeTime(alert.acknowledgedAt)}</p>
              ) : (
                <form method="post" action={`/admin/alerts/${alert.id}/ack`}>
                  <input type="hidden" name="csrf" value={props.csrf} />
                  <button type="submit" class="btn btn-secondary btn-small" aria-label={`Acknowledge ${RULE_NAMES[alert.rule] ?? alert.rule} alert from ${relativeTime(alert.createdAt)}`}>
                    Acknowledge
                  </button>
                </form>
              )}
            </li>
          ))}
        </ol>
      )}
    </AdminShell>
  );
}
