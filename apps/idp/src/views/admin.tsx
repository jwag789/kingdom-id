import type { Client, Perk } from "@kingdom-id/db";
import { Icon } from "./icons.js";
import { Document, FieldError, type Ui } from "./layout.js";

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
    <Document title="Perks admin" ui={props.ui}>
      <a class="skip-link" href="#main">
        Skip to perks
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
      </header>
      <main id="main" class="dash-main">
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
                      <button type="submit" class="btn btn-primary btn-small">
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
      </main>
    </Document>
  );
}
