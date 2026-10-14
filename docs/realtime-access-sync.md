# Real-time access sync

When a Super Admin changes an account's access, the affected account's open
tabs update without a refresh.

## Why a refresh used to be needed

The browser holds a cached copy of the signed-in profile (`localStorage`,
including `canManageWhatsAppTemplates`). It was re-read from the server only
when a session was restored (page load). The Templates Access endpoint saved
the change but sent no event, and nothing in the browser asked again - so the
menu and route guards kept reading the old copy. Other changes had the same
gap: only removal and event assignment were pushed.

## How it works

1. **Persist, then notify.** After a change is saved (and audited), the backend
   calls `emitAccessChanged(accountId, reason)`: Templates Access granted or
   revoked, approval, rejection, password reset. Removal and event assignment
   keep their existing events.
2. **Authenticated, per-account delivery.** Socket.IO already requires a valid
   token for an active account and puts each socket in a room named after its
   own account id; the client cannot choose a room (`identify`, query strings
   and spoofed ids are ignored). The event goes to that room only.
3. **The event carries no permissions** - just `{ reason, at }`. The browser
   answers it by asking the API (`GET /auth/me`), which reads the database.
   A forged, duplicate, late or out-of-order event can therefore cause at most
   one harmless re-read.
4. **The browser adopts the answer** (`useAccessSync`, mounted in the layout):
   the menu and the route guards read the same profile and follow; a toast says
   what changed; a person on a page they no longer may use is moved to the
   dashboard. A 401 (removed, expired, password reset) ends the session.
5. **Re-reads happen one at a time** (a burst of duplicates costs at most two
   requests) and an unchanged answer causes no re-render.

## Missed events

The push is an optimisation, never the guarantee. The browser also re-reads:
on socket reconnect, when the tab becomes visible or the window regains focus
or the network returns, every 60 s while the tab is visible, and at the moment
its access window starts or ends. An account that was offline simply reads the
current state when it returns.

## Several tabs

Every tab holds its own socket and is notified. A tab whose push was missed
follows another tab of the **same account** through the `storage` event; a
profile for a different account is never adopted.

## Authorization is unchanged

Nothing here grants access. Every API request is still authorized from the
database (`requireAuth`, and `templateManagerRole` for templates): a revoked
Admin is refused on the very next request whatever the browser shows.

## Deployment note

Socket.IO rooms live in one process. With **one** backend instance (the current
setup) the push reaches every connected tab. With several instances it reaches
only sockets on the instance that handled the change until a shared adapter
(e.g. `@socket.io/redis-adapter`) is configured; the 60 s re-read bounds the
delay in the meantime. The existing server-side `ACCESS_EXPIRED` timer is also
per-process; the browser's own boundary timer and the server's per-request
expiry check cover a restart.
