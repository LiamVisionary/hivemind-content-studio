# The shared media-model catalog

One inventory of every image and video model a machine can reach, published
in the same shape by Hivemind Content Studio and by HivemindOS. Each app reads
the other's published copy, so the studio's document lists HivemindOS's rows
beside its own and HivemindOS's lists the studio's — and each keeps listing
the other's rows, marked unavailable, when the other app is not running.

## Why it exists

HivemindOS chat has a runtime-and-model picker behind `/image-gen` and
`/video-gen`. It should offer everything the owner can actually run: the apps
on their fleet, their HivemindOS credits, and everything this studio knows —
the local ComfyUI and Media Studio workflows, the provider accounts, the hosted
route. The studio already knows all of that in its own vocabulary (provider
readiness, reference roles, the live workflow registry). The catalog is that
knowledge said once, in the vocabulary both apps agreed on.

The contract is `media-model-catalog` version 1. The schema ships in this
repository at `src/hivemind_content_studio/catalog/media-model-catalog.v1.schema.json`
and is byte-identical to the copy in HivemindOS; each app validates its own
output against it in its tests.

## The three places

Every row says where it would run, and the place decides how it is priced:

| place | what it means | cost |
|---|---|---|
| `this-machine` | a ComfyUI or Media Studio workflow served by this machine's own gateway | free — "stays on this machine" |
| `hivemindos-credits` | the HivemindOS hosted route, paid from the one shared credit balance | credits |
| `your-accounts` | a provider the owner holds an account with (OpenAI, xAI, Higgsfield, MUAPI) | billed to that account |

HivemindOS adds a fourth, `fleet`, for apps on other machines; the studio only
emits it for rows it took from HivemindOS's snapshot. Where the same account
can be reached two ways, the row also names the credential (`api-key` or
`sign-in`) so a picker can tell the siblings apart. The place labels and cost
sentences are the shared ones ("This machine", "Free · stays on this machine"),
so a list that mixes both apps' rows spells a place one way.

## What a row says

- `available` — the source can be reached right now, as the studio's own
  Providers view reports it.
- `ready` — picking the row from HivemindOS chat will run something. Only a
  reachable local workflow is ready today. Every other row says why in
  `reason`, in prose.
- `execute` — how to run it. A local workflow (image or video) carries
  `route: "media-studio-mcp"` with the workflow id, which HivemindOS runs
  through the same Media Studio MCP this studio uses. A provider-account row
  carries `route: "none"` and the studio page to open — those run only inside
  the studio for now. The hosted row is `route: "hosted-media"` with the model
  left as `automatic`: HivemindOS is authoritative for hosted models and
  replaces this row with its own priced list.
- `capabilities` — reference-image support and limits, the workflow family,
  what the graph accepts, whether it is a beta, and for a workflow whether it
  needs a picture to start (`requiresImage`), read off the live registry.

Rows a person cannot choose are left out: the "workflow default" routing
sentinel, the stick-figure and text-card renderers, and graphs the studio only
reaches by routing.

## What it never carries

No prompt, no media or file name, no absolute path, no Tailnet address, no
credential value. A source lists the credential NAMES it is waiting for — the
same thing the Providers view shows — and any readiness sentence that would
name a variable is replaced with one a person can act on.

## Where it is served

- `GET /api/media-models` — answers without a browser session, alongside the
  catalog, providers and runtime reads, because it is a projection of the
  model inventory the studio already caches for its own pickers: no probe
  runs for the request, and nothing is asked of HivemindOS, a provider, or a
  credential store. `?kind=image` or `?kind=video` narrows the models; the
  sources stay whole. The inventory is built when the studio starts and
  refreshed in the background once it is half a minute old. A request that
  arrives before the first build has landed gets `{"ok": true, "pending":
  true, "catalog": <empty document>}` with a `Retry-After` header, the same
  answer the studio's own model picker gets, rather than waiting on the build.
  Otherwise the response is `{"ok": true, "catalog": <document>}`.
- The MCP tool `list_media_models(kind="")` and the resource
  `studio://media-models` return the same document for agents.

## The snapshots

Every fresh projection also writes the document to
`~/.hivemindos/media-catalog/hivemind-content-studio.json` (under `HIVE_HOME`
when that is set); the directory and the file are owner-only and the write is
atomic. HivemindOS writes `hivemindos.json` beside it.

The studio reads HivemindOS's file every time it builds its own document and
adds the rows it does not already list: HivemindOS's fleet rows, its priced
hosted models, anything else it found. Rows are deduplicated by key, and rows
that run on this machine also by lane (the kind plus the workflow id), so a
Media Studio workflow that both apps list appears once. They point at one
source, `hivemindos`, whose detail says they were listed from HivemindOS's
last snapshot. When HivemindOS answered the studio's readiness sweep, its
hosted rows are ready from the studio as well — the studio's hosted client
runs a specific model id — with the same credit cost. When the snapshot is the
only evidence, every row from it is marked unavailable and not ready, with a
reason saying HivemindOS is not running (or not linked to this studio), and
the `hivemindos` source is marked unavailable.

HivemindOS reads the studio's file the same way when the studio is not
answering, so the studio's rows keep appearing in chat — marked unavailable
and not ready — instead of vanishing.

## How HivemindOS consumes it

HivemindOS finds a running studio, reads `/api/media-models`, and merges the
rows with its own: its hosted rows replace the studio's `automatic` one, its
direct Media Studio workflow rows are deduplicated against the studio's on
workflow id, and everything else is unique by `key`. A ready row runs from
chat; a row that is not ready shows its reason and, where the row names a
studio page, opens it.
