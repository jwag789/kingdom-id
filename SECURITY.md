# Security policy

Kingdom ID is an identity provider: it holds accounts, passkeys and signing keys for every app that signs in with it. Security reports are welcome and taken seriously.

## Reporting a vulnerability

**Please don't open a public issue, discussion or pull request for a vulnerability.**

Report it privately through GitHub: on this repository, go to **Security → Report a vulnerability** ([direct link](https://github.com/jwag789/kingdom-id/security/advisories/new)). Only the maintainers can see it.

A useful report includes:

- what an attacker can do, and what they need first (an account, a registered client, a position on the network);
- the steps or a proof of concept, against a local instance (see the [quick start](README.md#quick-start));
- the commit or release you tested.

## What to expect

- An acknowledgement within **3 business days**.
- An assessment, and a fix plan for anything confirmed, within **14 days**.
- A fix released and a [security advisory](https://github.com/jwag789/kingdom-id/security/advisories) published once deployments can update, crediting you unless you'd rather not be named.

## Scope

In scope: everything in this repository, including the provider (`apps/idp`), the `kingdom` CLI, the deployment layouts in `deploy/`, and the published container image. Particularly interesting:

- getting a token, code or session for an account that isn't yours;
- bypassing PKCE, redirect URI matching, consent, CSRF protection, or refresh token reuse detection;
- linking a user across third-party apps despite pairwise subjects and relay addresses;
- sending mail as a member through the relay, or learning a member's real address;
- reading or forging signing keys.

Out of scope:

- the live deployment at `id.kingdomwebbuilders.com` (please test against your own instance; don't run scanners or load tests against it);
- findings that need a compromised server, database or operator account;
- rate-limit tuning, missing best-practice headers with no demonstrated impact, and denial of service by volume;
- the example apps in `examples/` and `apps/demo-client`, except where they show a flaw in the provider.

## Supported versions

Fixes land on `main` and ship in the next release. Only the latest release is supported.

## Safe harbor

Research done in good faith, within this policy, against your own instance, is welcome. We won't pursue or support legal action over it.
