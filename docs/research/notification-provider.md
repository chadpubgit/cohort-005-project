# Research: which external notification provider should Cadence use?

Ticket: [chadpubgit/cohort-005-project#2](https://github.com/chadpubgit/cohort-005-project/issues/2) (parent map #1).
Checked on **2026-11-12**. Pricing, free-tier limits and package versions change often, so re-check them before you rely on them.

Scope: in-app notifications only (a bell and a feed). The provider is the source of truth for feed state. Cadence runs on `react-router` **8.3.0** and `react` **^19.2.7** (see `package.json`; the ticket says "React Router v7", but the repo is on v8). Shadcn uses the new-york style. Data lives in SQLite via Drizzle. The session is a cookie-session `userId` (a **number**) with no real auth (`app/lib/session.ts`). There is no job queue.

## How this was checked

- **Licences:** I downloaded each package's npm tarball (`npm pack`) and read the `LICENSE` file inside it. Where the tarball had none, I read the repo `LICENSE` through the GitHub API. Then I installed each provider's server SDK and React packages together in a clean directory with `react@19.2.7` and walked every `package.json` in `node_modules` to find transitive AGPL dependencies.
- **SSR smoke test:** For each provider I ran `react-dom/server` `renderToString` on its React provider and feed or inbox component, using React 19.2.7 under Node. This only shows that a server render does not crash. It does **not** test hydration or a live connection.
- **Everything else:** I read the official docs and pricing pages linked inline. Anything I could not verify is marked **Unverified**.

## Recommendation: Knock

Use **Knock** (hosted, `knock.app`). Build the bell and feed in shadcn on top of Knock's headless hooks (`@knocklabs/react-core`), and trigger from the server with `@knocklabs/node`.

Why:

1. **It meets every hard requirement, with clean licences.** `@knocklabs/node` is Apache-2.0 ([LICENSE](https://github.com/knocklabs/knock-node/blob/main/LICENSE)). `@knocklabs/client`, `@knocklabs/react-core` and `@knocklabs/react` are MIT ([LICENSE](https://github.com/knocklabs/javascript/blob/main/LICENSE)). The full install tree (92 packages) holds only MIT, ISC, Apache-2.0, BSD-3-Clause and 0BSD, with **no AGPL**. The free plan includes 10,000 messages a month, unlimited workflows, unlimited feed retention and unlimited isolated environments, and has no hard cap ([pricing](https://knock.app/pricing)).
2. **The client auth model fits Cadence's "no real auth" setup.** Signed user tokens are **optional**: "enhanced security mode" is off by default and can be turned on per environment ([security docs](https://docs.knock.app/in-app-ui/security-and-authentication)). Dev can therefore run with only the public key and a user id. Production should turn on enhanced security and mint an RS256 JWT on the server with `signUserToken` from `@knocklabs/node`, so the browser can't read another user's feed just by changing the id. This matters here because Cadence user ids are small integers and easy to guess.
3. **The headless hooks fit a shadcn UI.** Use `useNotifications` and `useNotificationStore` (or `useKnockFeed`) with `feedClient.markAllAsRead()`, `markAllAsSeen()`, `markAsArchived()` and `markAllAsArchived()`, plus `metadata.unread_count` and `metadata.unseen_count`. Updates arrive in real time over Knock's websocket, so no polling is needed ([headless guide](https://docs.knock.app/in-app-ui/react/custom-notifications-ui), [feed docs](https://docs.knock.app/in-app-ui/react/feed)). I confirmed the method names in the `@knocklabs/client@0.23.1` type definitions.
4. **The trigger shape fits Cadence's fan-out.** You can send up to 1,000 recipients per trigger, identify recipients inline (the user is upserted at trigger time, so no pre-sync is needed), add per-recipient `$trigger_data`, and send an `Idempotency-Key` header. Object subscriptions cover larger audiences ([trigger API](https://docs.knock.app/send-notifications/triggering-workflows/api)). There's no job queue, but one HTTP call per event is all a loader or action needs.
5. **It is SSR- and test-friendly.** `@knocklabs/react` and `@knocklabs/react-core` accept `react ^17 || ^18 || ^19` (npm `peerDependencies`). The packages ship `"use client"` directives, and a server render on React 19.2.7 succeeded. `KnockProvider` has an `enabled` prop that keeps the client idle (no identify, no requests, no socket) ([source](https://github.com/knocklabs/javascript/blob/main/packages/react-core/src/modules/core/context/KnockProvider.tsx)), and the server SDK honours `KNOCK_BASE_URL` ([source](https://github.com/knocklabs/knock-node/blob/main/src/client.ts)). Together these give a clean no-credentials mode and a mock-server hook for tests.

**Runner-up: Novu Cloud.** Its licences are clean too (MIT for the SDKs it ships). It offers optional HMAC user hashing (simpler than a JWT), Dev and Prod environments by default, good headless hooks, and an MIT self-hostable core as an exit route. It loses to Knock on free-plan limits: **5 workflows**, 24-hour activity-log retention, 3 team members and 100 recipients per trigger ([pricing](https://novu.co/pricing), [trigger API](https://docs.novu.co/api-reference/events/trigger-event)). Its prebuilt Inbox is a SolidJS widget rendered inside React (`solid-js` is a dependency of `@novu/js`) and styled through an `appearance` prop, not shadcn components.

**Ruled out: MagicBell.** The React SDK its docs currently point to, `@magicbell/react@1.14.0` ([docs](https://www.magicbell.com/docs/libraries/react)), depends on `ua-parser-js ^2.0.3`, which is **AGPL-3.0-or-later** (npm metadata; [LICENSE](https://github.com/faisalman/ua-parser-js/blob/master/LICENSE.md)). That fails a hard requirement. The older `@magicbell/magicbell-react` avoids AGPL but ships under a proprietary MagicBell EULA ("SEE LICENSE IN LICENSE"; [LICENSE](https://github.com/magicbell/magicbell-js/blob/main/LICENSE)). That EULA limits use to "internal use" of MagicBell's product and forbids "any commercial use" of the Software. The free tier is also the smallest of the five: 1,000 deliveries and 1 project ([pricing](https://www.magicbell.com/pricing)).

**Requirement no candidate fully meets: running with no credentials.** No provider offers a local or offline emulator for the in-app feed. Novu's Inbox has a hosted "keyless" demo mode ([styling docs](https://docs.novu.co/platform/inbox/configuration/styling.md), "Development mode footer"), but it still needs the network and isn't a test double. Cadence must supply its own no-credentials fallback whichever provider it picks (see below).

## Comparison table

✅ = yes / meets. ⚠️ = with caveats. ❌ = no / fails. "Unverified" = I couldn't confirm it from a primary source.

| Criterion | **Knock** | **Novu Cloud** | **Courier** | **SuprSend** | **MagicBell** |
| --- | --- | --- | --- | --- | --- |
| Hosted SaaS | ✅ | ✅ (self-host optional) | ✅ | ✅ | ✅ |
| Free tier (2026-11-12) | ✅ 10k messages/mo, unlimited workflows, envs and feed retention; no hard cap; Knock branding on the free plan ([pricing](https://knock.app/pricing)) | ⚠️ 10k workflow runs/mo, **5 workflows**, 2 envs, 24h activity log, 3 seats; branding stays on Free ([pricing](https://novu.co/pricing)) | ✅ 10k sends/mo; Test-environment sends count toward it ([pricing](https://www.courier.com/pricing)) | ✅ 10k notifications/mo; SuprSend branding on the feed; no hard stop ([pricing](https://www.suprsend.com/pricing)) | ⚠️ 1,000 deliveries/mo, 1 project ([pricing](https://www.magicbell.com/pricing)) |
| Node server trigger SDK | ✅ `@knocklabs/node` `workflows.trigger` | ✅ `@novu/api` `novu.trigger` | ✅ `@trycourier/courier` `send.message` | ✅ `@suprsend/node-sdk` | ✅ `magicbell-js` (not evaluated further) |
| No AGPL (server + React, transitive) | ✅ Apache-2.0 / MIT; 92-package tree clean | ✅ MIT/ISC; 59-package tree clean | ✅ Apache-2.0 / MIT; 11-package tree clean | ✅ MIT; `@suprsend/react` tree (189 packages) clean | ❌ `@magicbell/react` → `ua-parser-js` AGPL-3.0; legacy SDK is a proprietary EULA |
| Prebuilt React feed | ✅ `NotificationFeedPopover`, `NotificationIconButton` | ✅ `<Inbox />` (SolidJS inside) | ✅ `<CourierInbox />` (web components) | ✅ `<Inbox />` | ✅ `FloatingInbox` |
| Headless hooks for a shadcn UI | ✅ `@knocklabs/react-core` | ✅ `@novu/react/hooks` (`useNotifications`, `useCounts`) | ✅ `useCourier().inbox` | ✅ `@suprsend/react-core` (`useFeedClient`, `useFeedData`) | Unverified (excluded) |
| Theming the prebuilt UI | ⚠️ `--rnf-*` CSS variables or a full CSS replacement ([theme.css](https://github.com/knocklabs/javascript/blob/main/packages/react/src/theme.css)) | ✅ `appearance` variables plus per-element Tailwind classes ([styling](https://docs.novu.co/platform/inbox/configuration/styling.md)) | ⚠️ theme objects ([customize](https://www.courier.com/docs/in-app/customize-the-inbox.md)) | ⚠️ theme props ([customising](https://docs.suprsend.com/docs/react-customising-feed.md)) | n/a |
| Read/unread, mark-all-read, archive, unread count | ✅ all ([client types](https://github.com/knocklabs/javascript/tree/main/packages/client)) | ✅ `readAll`, `archiveAll`, `archive`, counts ([hook](https://docs.novu.co/platform/sdks/react/hooks/use-notifications)) | ✅ `readAllMessages`, `archiveMessage`, `totalUnreadCount` ([custom inbox](https://www.courier.com/docs/in-app/build-a-custom-inbox.md)) | ⚠️ mark read/seen/archive via the feed client ([headless](https://docs.suprsend.com/docs/react-sdk-headless-feed.md)); **Unverified:** mark-all-read | — |
| Real-time | ✅ websocket | ✅ websocket (can be turned off per hook) | ✅ realtime socket ([runtime](https://www.courier.com/docs/in-app/how-the-inbox-behaves.md)) | ✅ socket ([headless](https://docs.suprsend.com/docs/react-sdk-headless-feed.md)) | — |
| User identity | Inline identify at trigger, or `users.update` upsert | Inbox auto-creates an unknown `subscriberId` ([quickstart](https://docs.novu.co/platform/quickstart/react.md)); trigger `to` accepts inline subscriber objects ([trigger API](https://docs.novu.co/api-reference/events/trigger-event)). **Unverified:** whether trigger-time creation is guaranteed | Nothing pre-created; sign-in registers the user ([auth](https://www.courier.com/docs/in-app/authenticate-users.md)) | Auto-created at trigger unless `$skip_create` ([trigger](https://docs.suprsend.com/docs/node-trigger-workflow-from-api.md)) | — |
| Client auth: signed token? | **Optional**: RS256 JWT, enforced only when enhanced security mode is on (per environment) | **Optional**: `subscriberHash` = HMAC-SHA256(secret, subscriberId), enforced when turned on ([prod guide](https://docs.novu.co/platform/inbox/prepare-for-production)) | **Always required**: a server-issued JWT through `POST /auth/issue-token` ([auth](https://www.courier.com/docs/in-app/authenticate-users.md)) | **Optional**: ES256 JWT, enforced when enhanced security mode is on ([auth](https://docs.suprsend.com/docs/client-authentication.md)) | **Always required**: user JWT ([docs](https://www.magicbell.com/docs/libraries/react)) |
| Recipients per trigger / fan-out | ≤1,000 + object subscriptions | ≤100 + topics | Array, lists, audiences ([send API](https://www.courier.com/docs/api-reference/send/send-a-message.md)) | ≤100, split internally into one trigger per recipient | — |
| Dev/prod separation | ⚠️ Starts with Production only; enabling environments adds Development (irreversible) ([envs](https://docs.knock.app/version-control/environments)) | ✅ Development + Production by default ([envs](https://docs.novu.co/platform/developer/environments.md)) | ✅ Production + Test by default ([envs](https://www.courier.com/docs/workspaces/environments.md)) | ✅ Sandbox, Staging, Production by default ([workspaces](https://docs.suprsend.com/docs/workspaces.md)) | ⚠️ 1 project on Free |
| React 19 peer range | ✅ `^17 \|\| ^18 \|\| ^19` | ✅ `^18 \|\| ^19` | ✅ `>=18` | ✅ `>=16.8` | `>=18.3.1` (legacy packages); `@magicbell/react` declares no peer range |
| SSR (`renderToString`, React 19.2.7) | ✅ renders markup; ships `"use client"` | ✅ renders a placeholder; mounts on the client | ⚠️ renders an empty string; docs: "render client-side only" ([React SDK](https://www.courier.com/docs/sdk-libraries/courier-react-web.md)) | ✅ renders markup | not tested |
| Lock-in | Medium: proprietary; feed state and templates live in Knock | Lower: MIT core can be self-hosted as an exit | Medium | Medium | Medium–high (proprietary client EULA) |
| Verdict | **Recommended** | **Runner-up** | Viable; required JWT adds a server route even in dev | Viable; deprecated legacy packages around it | **Ruled out (AGPL)** |

Other names screened (not evaluated in depth):

- **Engagespot:** MIT packages, but `@engagespot/react-component` was last published 2025-05-09 (npm `time.modified`), so it looks stale.
- **NotificationAPI / Pingram:** `@notificationapi/react` has no `license` field on npm, and its repo has no detectable LICENSE (GitHub API 404), so I couldn't verify its licence.

Neither beats Knock or Novu.

### Notes per candidate

**Knock**
- The free plan doesn't hard-cap messages: "If you go over your limit, we'll get in touch" ([pricing FAQ](https://knock.app/pricing)). It shows Knock branding ("Remove Knock branding: No" on Free). **Unverified:** whether that branding appears only in the prebuilt components. A headless shadcn UI shouldn't render it.
- "Messages sent" counts one message per user per channel ([pricing FAQ](https://knock.app/pricing)). An in-app-only workflow therefore counts 1 per recipient.
- New accounts start with **Production only**. "Enable environments" adds Development, can't be undone, and makes Development the default target for the CLI and Management API ([envs](https://docs.knock.app/version-control/environments)). Each environment has its own keys and isolated users and messages.
- Trigger `settings.sandbox_mode: true` generates messages without delivering them to providers ([trigger API](https://docs.knock.app/send-notifications/triggering-workflows/api)). **Unverified:** whether it suppresses in-app feed messages.
- `@knocklabs/react` (the prebuilt UI) pulls `@telegraph/*`, `@radix-ui/react-dialog` and its own `lucide-react@0.544.0` (Cadence uses `^0.563.0`). Use `@knocklabs/react-core` alone for a shadcn UI to avoid that.

**Novu Cloud**
- Repo licensing is mixed. Everything outside `enterprise/packages` is MIT ([LICENSE-ENTERPRISE](https://github.com/novuhq/novu/blob/next/LICENSE-ENTERPRISE), [LICENSE-MIT](https://github.com/novuhq/novu/blob/next/LICENSE-MIT)). `@novu/react` and `@novu/js` live in `packages/` (MIT per the repo, though their `package.json` says ISC). `@novu/api` ships an MIT LICENSE file but has no `license` field in `package.json`. None of these is AGPL.
- Production is view-only for workflows; changes are published from Development ([envs](https://docs.novu.co/platform/developer/environments.md)). Custom environments need Team or Enterprise.
- Idempotency keys are "not enabled for all organizations" ([trigger API](https://docs.novu.co/api-reference/events/trigger-event)).

**Courier**
- A JWT is required for every client, with no unsigned mode. `expires_in` is optional, and leaving it out mints a token that never expires ([auth](https://www.courier.com/docs/in-app/authenticate-users.md)).
- `@trycourier/courier-react` is built on Courier's web-component packages (`@trycourier/courier-ui-*`). It renders nothing on the server.

**SuprSend**
- `@suprsend/react-inbox` is archived on GitHub ([repo](https://github.com/suprsend/suprsend-react-inbox)) and pulls the deprecated `@suprsend/js-inbox` and `crypto-js`. Use `@suprsend/react`, whose tree is clean.
- Batching/digest and user preferences aren't on Free ([pricing](https://www.suprsend.com/pricing)).

## Facts later tickets depend on

### npm packages (Knock, as checked 2026-11-12)

| Package | Version checked | Licence (file) | Where it runs | Purpose |
| --- | --- | --- | --- | --- |
| `@knocklabs/node` | 1.41.1 | Apache-2.0 (tarball `LICENSE`) | server only (`*.server.ts`) | trigger workflows, upsert users, `signUserToken` |
| `@knocklabs/react-core` | 0.17.1 | MIT (repo [LICENSE](https://github.com/knocklabs/javascript/blob/main/LICENSE)) | client | `KnockProvider`, `KnockFeedProvider`, `useKnockFeed`, `useNotifications`, `useNotificationStore` (headless) |
| `@knocklabs/client` | 0.23.1 | MIT (tarball `LICENSE`) | client (dependency of react-core) | feed client, websocket, mark-as methods |
| `@knocklabs/react` | 0.15.1 | MIT (repo LICENSE) | client, **optional** | prebuilt UI only; skip it if the UI is shadcn |

`@knocklabs/node/package.json` has no `engines` field.

### Auth / user-token model

- **Server:** the secret API key authenticates triggers and user upserts ([security docs](https://docs.knock.app/in-app-ui/security-and-authentication)).
- **Client:** the browser uses the **public API key** plus a user id: `<KnockProvider apiKey={publicKey} user={{ id }}>`.
  - With enhanced security mode **off** (the default), Knock accepts any user id the public key sends. "A request with your public key can act as any user."
  - With it **on**, Knock rejects public-key requests that lack a signed user token (`userToken` prop).
  - The mode is set per environment, so Development can stay off and Production can be on.
- **Token:** an **RS256** JWT signed with the environment's **signing key**. `sub` = user id is required; `iat` and `exp` are recommended. `signUserToken(userId, { expiresInSeconds })` is exported from the `@knocklabs/node` root and defaults to a 3,600-second expiry. Optional `grants` can scope the token, for example read-only feed access. Refresh it through `onUserTokenExpiring`.
- **Cadence mapping:** in the root loader, read `getCurrentUserId(request)` (`app/lib/session.ts`). Pass `String(userId)` and, in production, a freshly signed `userToken` to the client. The id is a number in Cadence, while Knock ids are strings, so convert it the same way everywhere (trigger, upsert, client).
- **Identity sync:** pass the full recipient inline on trigger (`{ id, name, email }`) and Knock upserts it first. No separate sync job is needed ([trigger API](https://docs.knock.app/send-notifications/triggering-workflows/api)). Note that `KnockProvider` with a `user` object also makes the browser identify the user (see `identificationStrategy` in `KnockProviderProps`).

### Environment variables and keys

| Name | Side | Required | Notes |
| --- | --- | --- | --- |
| `KNOCK_API_KEY` | server | yes, for real sends | The secret key, read by default by `new Knock()` ([client.ts](https://github.com/knocklabs/knock-node/blob/main/src/client.ts)). Never send it to the browser. |
| `KNOCK_SIGNING_KEY` | server | when enhanced security is on | Default for `signUserToken` ([tokenSigner.ts](https://github.com/knocklabs/knock-node/blob/main/src/lib/tokenSigner.ts)). Use the base-64 single-line form in env files ([security docs](https://docs.knock.app/in-app-ui/security-and-authentication#troubleshooting)). |
| `KNOCK_PUBLIC_API_KEY` | server → client | yes, for the feed | The doc convention ([feed docs](https://docs.knock.app/in-app-ui/react/feed)). Expose it through the root loader rather than a `VITE_` variable, so it can change per deploy. |
| `KNOCK_FEED_CHANNEL_ID` | server → client | yes, for the feed | UUID of the in-app feed channel (dashboard → Channels and sources). |
| `KNOCK_BASE_URL` | server | no | Overrides `https://api.knock.app`, which lets tests point at a mock server. |
| `KNOCK_BRANCH` | server | no | Knock version-control branch. |

The key values differ per Knock environment ([envs](https://docs.knock.app/version-control/environments)). Cadence also needs one dashboard-side **workflow key** per notification type, with an in-app feed step. You can manage these through the Knock CLI or Management API ("Manage via API & CLI: Yes", [pricing](https://knock.app/pricing)).

### Dev/prod environment model

- A new Knock account has only **Production**. Turn on "Enable environments" to get **Development** below it. This is irreversible, and Free allows unlimited environments.
- Content (workflows, layouts, translations) is version-controlled: commit it in Development, then promote it to Production. Data (users, messages, logs) never crosses between environments.
- Each environment has its own public and secret key pair and signing key, and its own enhanced-security setting.

### Running with no credentials

No provider offers an offline mode, so Cadence needs its own. Follow the pattern the working `main` already uses for email in `app/lib/mailer.server.ts` (Postmark when a token is set, otherwise a local `.outbox/`):

- **Server:** a `notifications.server.ts` module with a transport interface. Use the Knock transport when `KNOCK_API_KEY` is set. Otherwise use a no-op or local-file transport that records triggers, so tests can assert them.
- **Client:** render `KnockProvider` with `enabled={Boolean(publicKey && feedId)}`. When it's `false`, the client makes no identify call, no requests and no websocket connection ([KnockProvider.tsx](https://github.com/knocklabs/javascript/blob/main/packages/react-core/src/modules/core/context/KnockProvider.tsx)). I confirmed a server render with `apiKey: undefined`, `enabled: false` succeeds and gives `unread_count` 0. It logs a console warning for an invalid `feedId`, so hide the bell, or skip mounting `KnockFeedProvider`, when there's no feed id.
- **Tests:** inject the transport (as `sendEmail(email, transport)` does), or point `KNOCK_BASE_URL` at an MSW handler.

### React 19 / SSR compatibility

- **Peer ranges:** `@knocklabs/react` and `@knocklabs/react-core` declare `react ^17.0.0 || ^18.0.0 || ^19.0.0`. `next` and `@tanstack/react-router` are **optional** peers (`peerDependenciesMeta`), and npm doesn't install them.
- **Router:** there's no React Router adapter export (the exports are `.`, `./next` and `./tanstack`). Wire click navigation yourself with `onNotificationClick` and `useNavigate`.
- **Server render:** `renderToString` on React 19.2.7 succeeded for `KnockProvider` with `KnockFeedProvider`, `NotificationIconButton` and `NotificationFeed`. It also succeeded for a headless `useKnockFeed` component. Data loads and sockets start only in effects, so the SSR output is the empty or zero state. Expect a client-side fill after hydration; the server never fetches the feed. **Unverified:** hydration-mismatch behaviour in a real React Router 8 app. The first implementation ticket should check it.
- **Bundle:** for shadcn, import only `@knocklabs/react-core`. That avoids `@knocklabs/react`'s CSS, its `@telegraph/*` packages and its second copy of `lucide-react`.

### Lock-in notes

Feed state (read, seen, archived), recipient profiles and workflow templates live in Knock. To keep a later migration cheap:

- Keep all triggers behind the single server module above. Call it with Cadence-domain arguments (`notify({ type, recipients, data })`), not Knock payloads.
- Keep the UI on headless hooks inside one `notifications/` component folder.

**Unverified:** a bulk export path for historical feed messages.
