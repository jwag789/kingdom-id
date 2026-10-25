# Cappuccino

A sample Next.js (App Router) app that signs in with Kingdom ID through Auth.js. It's the working code behind [docs/integrations/nextjs.md](../../docs/integrations/nextjs.md), and the browser e2e suite drives it on every CI run.

```bash
pnpm -s kingdom clients create --name Cappuccino --first-party \
  --redirect-uri http://localhost:4002/api/auth/callback/kingdom \
  --post-logout-uri http://localhost:4002/
cp .env.example .env.local   # fill in the client ID and secret
pnpm --filter @kingdom-id/example-cappuccino dev
```
