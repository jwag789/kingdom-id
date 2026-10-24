import type { ComponentChildren } from "preact";
import { renderToString } from "preact-render-to-string";
import type { FastifyReply } from "fastify";

export interface AppIdentity {
  name: string;
  logoUri: string | null;
}

export function Layout({ title, children }: { title: string; children: ComponentChildren }) {
  return (
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="robots" content="noindex" />
        <title>{`${title} · Kingdom ID`}</title>
        <link rel="icon" href="/brand/favicon.png" />
        <link rel="stylesheet" href="/brand/tokens.css" />
        <link rel="stylesheet" href="/assets/app.css" />
      </head>
      <body>
        <main class="shell">{children}</main>
        <footer class="footer">
          Kingdom ID, by <a href="https://kingdomwebbuilders.com">Kingdom Web Builders</a>
        </footer>
      </body>
    </html>
  );
}

/** Kingdom mark, optionally beside the requesting app's identity (co-branding). */
export function CardHeader({ app }: { app?: AppIdentity | undefined }) {
  return (
    <div class="card-header">
      <img class="mark" src="/brand/kingdom-mark.png" alt="Kingdom ID" width="56" height="30" />
      {app && (
        <>
          <span class="divider" aria-hidden="true" />
          {app.logoUri ? (
            <img class="app-logo" src={app.logoUri} alt="" width="32" height="32" />
          ) : (
            <span class="app-initial" aria-hidden="true">
              {app.name.slice(0, 1).toUpperCase()}
            </span>
          )}
          <span class="app-name">{app.name}</span>
        </>
      )}
    </div>
  );
}

export function FieldError({ id, message }: { id: string; message: string | undefined }) {
  return message ? (
    <p class="field-error" id={id}>
      {message}
    </p>
  ) : null;
}

export function sendPage(reply: FastifyReply, page: preact.VNode, status = 200) {
  return reply
    .status(status)
    .header("content-type", "text/html; charset=utf-8")
    .header("cache-control", "no-store")
    .send(`<!doctype html>${renderToString(page)}`);
}
