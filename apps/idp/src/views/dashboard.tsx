import type { Client, Consent, Mask, Passkey, SecurityEvent } from "@kingdom-id/db";
import type { ComponentChildren } from "preact";
import type { SecurityEventType } from "../accounts/security-events.js";
import type { UnlockedPerk } from "../oauth/perks.js";
import { describeDevice, firstName, formatDate, formatDay, formatTime, relativeTime } from "./format.js";
import { Icon, type IconName } from "./icons.js";
import { Document, type Ui } from "./layout.js";

export type Section = "realms" | "treasury" | "masks" | "watchtower" | "keys";

const SECTIONS: { id: Section; href: string; label: string; icon: IconName; blurb: string }[] = [
  { id: "realms", href: "/account", label: "Realms", icon: "castle", blurb: "Apps connected to your Kingdom account" },
  { id: "treasury", href: "/account/treasury", label: "Treasury", icon: "crown", blurb: "Perks you've unlocked" },
  { id: "masks", href: "/account/masks", label: "Masks", icon: "mask", blurb: "Private email addresses, one per app" },
  { id: "watchtower", href: "/account/watchtower", label: "Watchtower", icon: "tower", blurb: "Recent activity on your account" },
  { id: "keys", href: "/account/keys", label: "Keys", icon: "key", blurb: "Passkeys and password" },
];

export interface ShellProps {
  ui: Ui;
  csrf: string;
  user: { name: string; email: string; isAdmin: boolean };
  stats: { realms: number; perks: number; keys: number };
  notice?: string | undefined;
  error?: string | undefined;
}

function Shell(props: ShellProps & { section: Section; children: ComponentChildren }) {
  const current = SECTIONS.find((s) => s.id === props.section)!;
  const { user, stats } = props;
  return (
    <Document title={`${current.label} · Your Kingdom`} ui={props.ui}>
      <a class="skip-link" href="#main">
        Skip to {current.label}
      </a>
      <header class="dash-header">
        <div class="aurora" aria-hidden="true">
          <span class="blob blob-a" />
          <span class="blob blob-b" />
          <span class="blob blob-d" />
          <span class="grid-lines" />
        </div>
        <div class="dash-bar">
          <a class="dash-brand" href="/account">
            <span class="cobrand-mark">
              <img src="/brand/kingdom-mark-white.png" alt="" width="44" height="24" />
            </span>
            <span>
              <strong>Your Kingdom</strong>
              <small>Kingdom ID</small>
            </span>
          </a>
          <div class="dash-user">
            {user.isAdmin && (
              <a class="dash-admin" href="/admin">
                Admin
              </a>
            )}
            <span class="avatar" aria-hidden="true">
              {user.name.slice(0, 1).toUpperCase()}
            </span>
            <span class="dash-user-text">
              <strong>{user.name}</strong>
              <span>{user.email}</span>
            </span>
            <form method="post" action="/logout">
              <input type="hidden" name="csrf" value={props.csrf} />
              <button type="submit" class="btn btn-ghost">
                Sign out
              </button>
            </form>
          </div>
        </div>
        <div class="dash-hero">
          <p class="dash-greeting">Welcome back, {firstName(user.name)}.</p>
          <ul class="dash-stats" aria-label="Your Kingdom at a glance">
            <li>
              <strong>{stats.realms}</strong> {stats.realms === 1 ? "realm" : "realms"}
            </li>
            <li>
              <strong>{stats.perks}</strong> {stats.perks === 1 ? "perk" : "perks"}
            </li>
            <li>
              <strong>{stats.keys}</strong> {stats.keys === 1 ? "passkey" : "passkeys"}
            </li>
          </ul>
        </div>
        <nav class="dash-nav" aria-label="Your Kingdom">
          {SECTIONS.map((s) => (
            <a href={s.href} aria-current={s.id === props.section ? "page" : undefined}>
              <Icon name={s.icon} />
              {s.label}
            </a>
          ))}
        </nav>
      </header>
      <main id="main" class="dash-main" data-csrf={props.csrf}>
        <div class="dash-section-head">
          <h1>{current.label}</h1>
          <p class="lede">{current.blurb}</p>
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
        {props.children}
      </main>
      <footer class="legal dash-legal">
        <span>
          Kingdom ID, by <a href="https://kingdomwebbuilders.com">Kingdom Web Builders</a>
        </span>
        <span class="legal-links">
          <a href="https://kingdomwebbuilders.com/privacy">Privacy</a>
          <a href="https://kingdomwebbuilders.com/terms">Terms</a>
        </span>
      </footer>
    </Document>
  );
}

function AppTile({ client }: { client: Pick<Client, "name" | "logoUri"> }) {
  return client.logoUri ? (
    <img class="cobrand-app" src={client.logoUri} alt="" width="44" height="44" />
  ) : (
    <span class="cobrand-app cobrand-initial" aria-hidden="true">
      {client.name.slice(0, 1).toUpperCase()}
    </span>
  );
}

function Empty({ icon, title, children }: { icon: IconName; title: string; children: ComponentChildren }) {
  return (
    <div class="empty">
      <Icon name={icon} />
      <h2>{title}</h2>
      <p>{children}</p>
    </div>
  );
}

// ------------------------------------------------------------------
// Realms
// ------------------------------------------------------------------

export interface Realm {
  client: Client;
  consent: Consent;
  /** The private address this app received, when the relay is on. */
  maskAddress?: string | undefined;
}

function claimsReceived(realm: Realm, user: { name: string; email: string }) {
  const { scopes, subject } = realm.consent;
  const pairwise = realm.client.subjectType === "pairwise" && !realm.client.firstParty;
  const items: { label: string; value: string }[] = [
    { label: pairwise ? "Kingdom ID for this app" : "Kingdom ID", value: `${subject.slice(0, 10)}…` },
  ];
  if (scopes.includes("profile")) items.push({ label: "Name", value: user.name });
  if (scopes.includes("email")) items.push({ label: realm.maskAddress ? "Private email" : "Email", value: realm.maskAddress ?? user.email });
  if (scopes.includes("perks")) items.push({ label: "Perks", value: "Your unlocked perks" });
  if (scopes.includes("offline_access")) items.push({ label: "Access", value: "Stays connected while you're away" });
  return items;
}

export function RealmsPage(props: ShellProps & { realms: Realm[] }) {
  return (
    <Shell {...props} section="realms">
      {props.realms.length === 0 ? (
        <Empty icon="castle" title="No realms yet">
          When you sign in to an app with Kingdom ID, it appears here with exactly what it can see.
        </Empty>
      ) : (
        <ul class="realms">
          {props.realms.map((realm) => {
            const { client, consent } = realm;
            const lastUsed = consent.lastUsedAt ?? consent.createdAt;
            return (
              <li class="panel realm">
                <div class="realm-head">
                  <AppTile client={client} />
                  <div class="realm-title">
                    <h2>{client.name}</h2>
                    <p>
                      {client.firstParty ? <span class="badge">Kingdom app</span> : null}
                      <span>Connected {formatDate(consent.createdAt)}</span>
                    </p>
                  </div>
                </div>
                <p class="realm-used">
                  <Icon name="clock" />
                  <span>
                    Last used <time datetime={lastUsed.toISOString()}>{relativeTime(lastUsed)}</time>
                  </span>
                </p>
                <h3 class="subhead">What {client.name} received</h3>
                <dl class="claims">
                  {claimsReceived(realm, props.user).map((c) => (
                    <div>
                      <dt>{c.label}</dt>
                      <dd>{c.value}</dd>
                    </div>
                  ))}
                </dl>
                <form method="post" action={`/account/realms/${encodeURIComponent(client.id)}/disconnect`} class="realm-actions">
                  <input type="hidden" name="csrf" value={props.csrf} />
                  <button type="submit" class="btn btn-danger">
                    <Icon name="plug" />
                    Disconnect {client.name}
                  </button>
                </form>
              </li>
            );
          })}
        </ul>
      )}
      <p class="footnote">
        Disconnecting ends the app's access immediately, including anything it was allowed to do while you're away. Signing in
        to it again will ask you to approve it again.
      </p>
    </Shell>
  );
}

// ------------------------------------------------------------------
// Treasury
// ------------------------------------------------------------------

export interface LockedPerk extends UnlockedPerk {
  hint: string;
}

export function TreasuryPage(props: ShellProps & { unlocked: UnlockedPerk[]; locked: LockedPerk[] }) {
  return (
    <Shell {...props} section="treasury">
      {props.unlocked.length === 0 ? (
        <Empty icon="crown" title="Your treasury is empty, for now">
          Kingdom apps offer perks for being a member. Once you unlock one, every Kingdom app you allow can honor it.
        </Empty>
      ) : (
        <ul class="perks">
          {props.unlocked.map(({ perk, appName }) => (
            <li class="panel perk perk-unlocked">
              <Icon name="sparkle" />
              <div>
                <h2>{perk.name}</h2>
                <p>{perk.description}</p>
                <p class="perk-from">From {appName}</p>
              </div>
            </li>
          ))}
        </ul>
      )}
      {props.locked.length > 0 && (
        <>
          <h2 class="subhead">Within reach</h2>
          <ul class="perks perks-locked">
            {props.locked.map(({ perk, appName, hint }) => (
              <li class="panel perk">
                <Icon name="lock" />
                <div>
                  <h3>{perk.name}</h3>
                  <p>{perk.description}</p>
                  <p class="perk-from">
                    {hint} · From {appName}
                  </p>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
      <p class="footnote">
        Kingdom's own apps can see your unlocked perks when you allow it. Other apps can't, because perks reveal which Kingdom
        apps you use.
      </p>
    </Shell>
  );
}

// ------------------------------------------------------------------
// Masks
// ------------------------------------------------------------------

export interface MaskRow {
  mask: Mask;
  clientName: string;
  clientLogo: string | null;
}

export function MasksPage(props: ShellProps & { masks: MaskRow[]; withoutEmail: Realm[]; emailVerified: boolean }) {
  const { ui, masks, user } = props;
  if (!ui.relay) {
    return (
      <Shell {...props} section="masks">
        <div class="panel panel-callout">
          <Icon name="mask" />
          <div>
            <h2>Private addresses are switched off</h2>
            <p>Apps that asked for your email have your real address, {user.email}.</p>
          </div>
        </div>
      </Shell>
    );
  }
  return (
    <Shell {...props} section="masks">
      {!props.emailVerified && (
        <div class="panel panel-callout panel-warning">
          <Icon name="alert" />
          <div>
            <h2>Verify your email to start receiving mail</h2>
            <p>
              Mail to your private addresses is held back until you confirm {user.email} is yours, so it can't be forwarded to
              someone else. Check your inbox for the verification link.
            </p>
          </div>
        </div>
      )}
      {masks.length === 0 ? (
        <Empty icon="mask" title="No private addresses yet">
          When an app asks for your email, it gets its own private address that forwards here. It never sees {user.email}.
        </Empty>
      ) : (
        <ul class="masks">
          {masks.map(({ mask, clientName, clientLogo }) => {
            const on = mask.status === "active";
            return (
              <li class="panel mask">
                <AppTile client={{ name: clientName, logoUri: clientLogo }} />
                <div class="mask-body">
                  <h2>
                    {clientName} <span class={on ? "badge" : "badge badge-muted"}>{on ? "Forwarding" : "Paused"}</span>
                  </h2>
                  <p class="mono mask-address">{mask.address}</p>
                  <p class="mask-stats">
                    {mask.forwardedCount} forwarded · {mask.blockedCount} blocked
                    {mask.lastForwardedAt ? ` · last ${relativeTime(mask.lastForwardedAt)}` : ""}
                  </p>
                </div>
                <div class="mask-actions">
                  <form method="post" action={`/account/masks/${mask.id}/${on ? "disable" : "enable"}`}>
                    <input type="hidden" name="csrf" value={props.csrf} />
                    <button type="submit" class="btn btn-secondary btn-small" aria-label={`${on ? "Pause" : "Resume"} forwarding for ${clientName}`}>
                      {on ? "Pause forwarding" : "Resume forwarding"}
                    </button>
                  </form>
                  <form method="post" action={`/account/masks/${mask.id}/delete`}>
                    <input type="hidden" name="csrf" value={props.csrf} />
                    <button type="submit" class="btn btn-danger btn-small" aria-label={`Delete ${clientName}'s address`}>
                      Delete address
                    </button>
                  </form>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {props.withoutEmail.length > 0 && (
        <p class="footnote">
          {props.withoutEmail.map((r) => r.client.name).join(", ")} {props.withoutEmail.length === 1 ? "doesn't" : "don't"} have
          an email address for you.
        </p>
      )}
      <p class="footnote">
        Pausing drops new mail to that address until you resume it. Deleting retires the address for good; the app gets a new one
        the next time it asks. Replies you send go out from the private address, never from {user.email}.
      </p>
    </Shell>
  );
}

// ------------------------------------------------------------------
// Watchtower
// ------------------------------------------------------------------

const EVENT_COPY: Record<SecurityEventType, { icon: IconName; title: (e: EventRow) => string; alert?: boolean }> = {
  sign_in: { icon: "key", title: (e) => `Signed in with ${e.event.details.method === "passkey" ? "a passkey" : "your password"}` },
  sign_in_failed: { icon: "alert", title: () => "Failed sign-in attempt", alert: true },
  signed_out: { icon: "arrow", title: () => "Signed out" },
  account_created: { icon: "sparkle", title: () => "Created your Kingdom account" },
  email_verified: { icon: "check", title: () => "Verified your email address" },
  passkey_added: { icon: "passkey", title: (e) => `Added a passkey${e.event.details.name ? ` (${String(e.event.details.name)})` : ""}` },
  passkey_removed: { icon: "trash", title: () => "Removed a passkey" },
  app_connected: { icon: "castle", title: (e) => `Allowed ${e.clientName ?? "an app"}` },
  app_disconnected: { icon: "plug", title: (e) => `Disconnected ${e.clientName ?? "an app"}` },
  refresh_token_reuse: {
    icon: "shield",
    title: (e) => `Blocked a copied token for ${e.clientName ?? "an app"}; its access was ended`,
    alert: true,
  },
  code_replay: { icon: "shield", title: (e) => `Blocked a replayed sign-in for ${e.clientName ?? "an app"}`, alert: true },
  mask_disabled: { icon: "mask", title: (e) => `Paused forwarding for ${e.clientName ?? "an app"}'s address` },
  mask_enabled: { icon: "mask", title: (e) => `Resumed forwarding for ${e.clientName ?? "an app"}'s address` },
  mask_deleted: { icon: "trash", title: (e) => `Deleted ${e.clientName ?? "an app"}'s address` },
  relay_spoof_blocked: {
    icon: "shield",
    title: () => "Blocked an email pretending to be you from going out through a private address",
    alert: true,
  },
};

interface EventRow {
  event: SecurityEvent & { details: Record<string, unknown> };
  clientName: string | null;
}

export function WatchtowerPage(props: ShellProps & { events: EventRow[] }) {
  const days = new Map<string, EventRow[]>();
  for (const row of props.events) {
    const day = formatDay(row.event.createdAt);
    days.set(day, [...(days.get(day) ?? []), row]);
  }
  return (
    <Shell {...props} section="watchtower">
      {props.events.length === 0 ? (
        <Empty icon="tower" title="All quiet">
          Sign-ins, new passkeys and connected apps will show up here.
        </Empty>
      ) : (
        [...days].map(([day, rows]) => (
          <section class="timeline-day" aria-label={day}>
            <h2 class="subhead">{day}</h2>
            <ol class="timeline">
              {rows.map((row) => {
                const copy = EVENT_COPY[row.event.type as SecurityEventType] ?? { icon: "clock" as const, title: () => row.event.type };
                return (
                  <li class={copy.alert ? "event event-alert" : "event"}>
                    <Icon name={copy.icon} />
                    <div>
                      <p class="event-title">{copy.title(row)}</p>
                      <p class="event-meta">
                        <time datetime={row.event.createdAt.toISOString()}>{formatTime(row.event.createdAt)}</time>
                        {" · "}
                        {describeDevice(row.event.userAgent)}
                        {row.event.ip ? ` · ${row.event.ip}` : ""}
                      </p>
                    </div>
                  </li>
                );
              })}
            </ol>
          </section>
        ))
      )}
      <p class="footnote">Don't recognize something? Remove unknown passkeys under Keys and disconnect any app you didn't allow.</p>
    </Shell>
  );
}

// ------------------------------------------------------------------
// Keys
// ------------------------------------------------------------------

export function KeysPage(props: ShellProps & { passkeys: Passkey[]; hasPassword: boolean; emailVerified: boolean }) {
  const canRemove = props.passkeys.length > 1 || props.hasPassword;
  return (
    <Shell {...props} section="keys">
      <div class="panel">
        <h2 class="panel-title">Passkeys</h2>
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
                    Added {formatDate(p.createdAt)}
                    {p.lastUsedAt ? ` · last used ${relativeTime(p.lastUsedAt)}` : ""}
                    {p.backedUp ? " · synced" : ""}
                  </span>
                </span>
                {canRemove && (
                  <form method="post" action={`/account/passkeys/${p.id}/delete`}>
                    <input type="hidden" name="csrf" value={props.csrf} />
                    <button type="submit" class="btn-icon" aria-label={`Remove ${p.name}, added ${formatDate(p.createdAt)}`}>
                      <Icon name="trash" />
                    </button>
                  </form>
                )}
              </li>
            ))}
          </ul>
        )}
        <p class="alert" role="alert" data-passkey-error hidden />
        <button type="button" class="btn btn-primary" data-passkey="add" hidden>
          <Icon name="passkey" />
          Add a passkey
        </button>
      </div>
      <div class="panel">
        <h2 class="panel-title">Password</h2>
        <p class="hint">{props.hasPassword ? "A password is set as a fallback." : "No password. You sign in with passkeys only."}</p>
      </div>
      <div class="panel">
        <h2 class="panel-title">Email</h2>
        <p class="hint">
          {props.user.email} · {props.emailVerified ? "verified" : "not verified yet"}
        </p>
      </div>
    </Shell>
  );
}
