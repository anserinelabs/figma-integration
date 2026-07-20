import crypto from 'crypto';
import fs from 'fs';

import express from 'express';

const PORT = 3335;
const WEBHOOK_PATH = '/webhook/figma';
const AUTH_PATH = '/auth/figma';
const CALLBACK_PATH = '/auth/figma/callback';

const FIGMA_API = 'https://api.figma.com';
const FIGMA_OAUTH_URL = 'https://www.figma.com/oauth';
const DEFAULT_ENDPOINT = 'https://figma.slashwork.net/webhook/figma';
const DEFAULT_REDIRECT_URI = 'https://figma.slashwork.net/auth/figma/callback';

// Scopes needed to list (webhooks:read) and create/update (webhooks:write).
const OAUTH_SCOPES = 'webhooks:read webhooks:write';

const FIGMA_CLIENT_ID = process.env.FIGMA_CLIENT_ID;
const FIGMA_CLIENT_SECRET = process.env.FIGMA_CLIENT_SECRET;
const FIGMA_FILE_KEY = process.env.FIGMA_FILE_KEY;
const FIGMA_WEBHOOK_PASSCODE = process.env.FIGMA_WEBHOOK_PASSCODE;
const FIGMA_WEBHOOK_ENDPOINT =
  process.env.FIGMA_WEBHOOK_ENDPOINT || DEFAULT_ENDPOINT;
const FIGMA_OAUTH_REDIRECT_URI =
  process.env.FIGMA_OAUTH_REDIRECT_URI || DEFAULT_REDIRECT_URI;
const TOKEN_FILE = process.env.FIGMA_TOKEN_FILE || '.figma-oauth.json';

const SLASHWORK_AUTH_TOKEN = process.env.SLASHWORK_AUTH_TOKEN;
const SLASHWORK_GROUP_ID = process.env.SLASHWORK_GROUP_ID;
const SLASHWORK_GRAPHQL_URL = 'https://anserine.slashwork.com/api/graphql';

if (
  !FIGMA_CLIENT_ID ||
  !FIGMA_CLIENT_SECRET ||
  !FIGMA_FILE_KEY ||
  !FIGMA_WEBHOOK_PASSCODE ||
  !SLASHWORK_AUTH_TOKEN ||
  !SLASHWORK_GROUP_ID
) {
  throw new Error(
    'Missing required environment variables: FIGMA_CLIENT_ID, FIGMA_CLIENT_SECRET, FIGMA_FILE_KEY, FIGMA_WEBHOOK_PASSCODE, SLASHWORK_AUTH_TOKEN, SLASHWORK_GROUP_ID',
  );
}

// Where a browser should start the one-time authorization, derived from the
// registered redirect URI so it works both in prod and behind ngrok.
const AUTH_START_URL = new URL(AUTH_PATH, FIGMA_OAUTH_REDIRECT_URI).toString();

// We only want LIBRARY_PUBLISH (fires when the library file is published).
// A webhook subscribes to exactly one event type, so this is the single webhook
// created each run against the file context.
const EVENT_TYPES = ['LIBRARY_PUBLISH'] as const;

// --- OAuth token management ------------------------------------------------

class NotAuthorizedError extends Error {
  constructor() {
    super('Not authorized with Figma');
    this.name = 'NotAuthorizedError';
  }
}

type TokenSet = {
  access_token: string;
  refresh_token: string;
  expires_at: number; // epoch milliseconds
};

type TokenResponse = {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
};

let tokens: TokenSet | null = null;

// state -> PKCE code_verifier for in-flight authorization requests
const pendingAuth = new Map<string, string>();

function basicAuthHeader(): string {
  const encoded = Buffer.from(
    `${FIGMA_CLIENT_ID}:${FIGMA_CLIENT_SECRET}`,
  ).toString('base64');
  return `Basic ${encoded}`;
}

function loadTokens(): void {
  try {
    tokens = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8')) as TokenSet;
  } catch {
    tokens = null;
  }
}

function saveTokens(next: TokenSet): void {
  tokens = next;
  fs.writeFileSync(TOKEN_FILE, JSON.stringify(next, null, 2), { mode: 0o600 });
}

async function exchangeCode(code: string, codeVerifier: string): Promise<void> {
  const res = await fetch(`${FIGMA_API}/v1/oauth/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: basicAuthHeader(),
    },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: FIGMA_OAUTH_REDIRECT_URI,
      code_verifier: codeVerifier,
    }),
  });
  if (!res.ok) {
    throw new Error(`Token exchange failed: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as TokenResponse;
  if (!data.refresh_token) {
    throw new Error('Token exchange response missing refresh_token');
  }
  saveTokens({
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: Date.now() + data.expires_in * 1000,
  });
}

// Refresh returns only a new access_token, so we keep the existing refresh
// token unless Figma hands back a new one.
async function refreshTokens(): Promise<void> {
  if (!tokens) {
    throw new NotAuthorizedError();
  }
  const res = await fetch(`${FIGMA_API}/v1/oauth/refresh`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: basicAuthHeader(),
    },
    body: new URLSearchParams({ refresh_token: tokens.refresh_token }),
  });
  if (!res.ok) {
    throw new Error(`Token refresh failed: ${res.status} ${await res.text()}`);
  }
  const data = (await res.json()) as TokenResponse;
  saveTokens({
    access_token: data.access_token,
    refresh_token: data.refresh_token ?? tokens.refresh_token,
    expires_at: Date.now() + data.expires_in * 1000,
  });
}

// Return a valid access token, refreshing a few minutes ahead of expiry.
async function accessToken(): Promise<string> {
  if (!tokens) {
    throw new NotAuthorizedError();
  }
  if (Date.now() >= tokens.expires_at - 5 * 60 * 1000) {
    await refreshTokens();
  }
  return tokens.access_token;
}

// --- Figma webhooks API ----------------------------------------------------

type FigmaWebhook = {
  id: string;
  event_type: string;
  context: string;
  context_id: string;
  endpoint: string;
  passcode: string;
  status: string;
  description?: string;
};

type ListWebhooksResponse = {
  webhooks?: FigmaWebhook[];
  pagination?: {
    next_page?: string;
  };
};

async function figmaFetch(path: string, init?: RequestInit): Promise<Response> {
  const token = await accessToken();
  return fetch(`${FIGMA_API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...init?.headers,
    },
  });
}

// List every webhook on the file, following pagination so we see all of them
// (missing later pages is what let duplicates pile up past the limit before).
async function listFileWebhooks(): Promise<FigmaWebhook[]> {
  const all: FigmaWebhook[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;

  // Cap iterations as a safety net against an unexpected pagination loop.
  for (let page = 0; page < 100; page++) {
    const params = new URLSearchParams({
      context: 'file',
      context_id: FIGMA_FILE_KEY!,
    });
    if (cursor) {
      params.set('cursor', cursor);
    }
    const res = await figmaFetch(`/v2/webhooks?${params.toString()}`);
    if (!res.ok) {
      throw new Error(
        `Failed to list webhooks: ${res.status} ${await res.text()}`,
      );
    }
    const data = (await res.json()) as ListWebhooksResponse;
    let added = 0;
    for (const webhook of data.webhooks ?? []) {
      if (!seen.has(webhook.id)) {
        seen.add(webhook.id);
        all.push(webhook);
        added++;
      }
    }
    cursor = data.pagination?.next_page || undefined;
    // Stop if there's no next page, or a page returned nothing new (guards
    // against a repeated/stale cursor looping forever).
    if (!cursor || added === 0) {
      break;
    }
  }
  return all;
}

async function createWebhook(eventType: string): Promise<void> {
  const res = await figmaFetch('/v2/webhooks', {
    method: 'POST',
    body: JSON.stringify({
      event_type: eventType,
      context: 'file',
      context_id: FIGMA_FILE_KEY,
      endpoint: FIGMA_WEBHOOK_ENDPOINT,
      passcode: FIGMA_WEBHOOK_PASSCODE,
      description: `slashwork figma integration (${eventType})`,
    }),
  });
  if (!res.ok) {
    console.warn(
      `  ⚠ could not create ${eventType} webhook: ${res.status} ${await res.text()}`,
    );
    return;
  }
  const created = (await res.json()) as FigmaWebhook;
  console.log(`  + created ${eventType} webhook (${created.id})`);
}

async function deleteWebhook(webhook: FigmaWebhook): Promise<void> {
  const res = await figmaFetch(`/v2/webhooks/${webhook.id}`, {
    method: 'DELETE',
  });
  if (!res.ok) {
    console.warn(
      `  ⚠ could not delete webhook ${webhook.id} (${webhook.event_type}): ${res.status} ${await res.text()}`,
    );
    return;
  }
  console.log(`  - deleted ${webhook.event_type} webhook (${webhook.id})`);
}

// Start every run from a clean slate: delete all existing webhooks on the file,
// then create a fresh set (one per event type) for this run. This keeps webhook
// count from creeping up over restarts and hitting Figma's per-context limit.
async function syncWebhooks(): Promise<void> {
  console.log(
    `Syncing webhooks for file ${FIGMA_FILE_KEY} → ${FIGMA_WEBHOOK_ENDPOINT}`,
  );

  const existing = await listFileWebhooks();
  console.log(`Deleting ${existing.length} pre-existing webhook(s)…`);
  for (const webhook of existing) {
    await deleteWebhook(webhook);
  }

  console.log('Creating fresh webhooks for this run…');
  for (const eventType of EVENT_TYPES) {
    await createWebhook(eventType);
  }
  console.log('Webhook sync complete.');
}

function syncWebhooksWithHint(): void {
  syncWebhooks().catch((err: unknown) => {
    if (err instanceof NotAuthorizedError) {
      console.log(
        `Authorization required. Visit ${AUTH_START_URL} to grant access.`,
      );
    } else {
      console.error('Failed to sync webhooks:', err);
    }
  });
}

// --- Slashwork posting -----------------------------------------------------

type GraphQLResponse = {
  data?: { createPost?: { node?: { id: string } } };
  errors?: { message: string }[];
};

type NamedItem = { name?: string };

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

// Extract the `name` of each entry in a Figma library-change array.
function itemNames(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map((item) =>
      item && typeof item === 'object'
        ? asString((item as NamedItem).name)
        : undefined,
    )
    .filter((name): name is string => Boolean(name));
}

function figmaFileUrl(fileKey: string | undefined): string | undefined {
  return fileKey ? `https://www.figma.com/file/${fileKey}` : undefined;
}

function triggeredByName(triggeredBy: unknown): string | undefined {
  if (triggeredBy && typeof triggeredBy === 'object') {
    const user = triggeredBy as Record<string, unknown>;
    return asString(user.handle) ?? asString(user.email) ?? asString(user.id);
  }
  return undefined;
}

// Render the added/modified/deleted names for one library entity kind.
function renderChangeGroup(
  event: Record<string, unknown>,
  kind: 'components' | 'styles' | 'variables',
  label: string,
): string {
  const groups: [string, string[]][] = [
    ['Added', itemNames(event[`created_${kind}`])],
    ['Modified', itemNames(event[`modified_${kind}`])],
    ['Removed', itemNames(event[`deleted_${kind}`])],
  ];
  const lines = groups
    .filter(([, names]) => names.length > 0)
    .map(
      ([verb, names]) =>
        `- ${verb} (${names.length}): ${names.map((n) => `\`${n}\``).join(', ')}`,
    );
  if (lines.length === 0) {
    return '';
  }
  return `\n**${label}**\n${lines.join('\n')}\n`;
}

function formatLibraryPublish(event: Record<string, unknown>): string {
  const fileName = asString(event.file_name) ?? 'Untitled file';
  const url = figmaFileUrl(asString(event.file_key));
  const heading = url ? `[${fileName}](${url})` : fileName;

  let md = `## 📚 Figma library published\n\n**${heading}**\n\n`;

  const description = asString(event.description);
  if (description) {
    md += `> ${description.replace(/\n/g, '\n> ')}\n\n`;
  }

  const meta: string[] = [];
  const by = triggeredByName(event.triggered_by);
  if (by) {
    meta.push(`Published by **${by}**`);
  }
  const when = asString(event.timestamp);
  if (when) {
    meta.push(when);
  }
  if (meta.length > 0) {
    md += `${meta.join(' · ')}\n`;
  }

  md += renderChangeGroup(event, 'components', 'Components');
  md += renderChangeGroup(event, 'styles', 'Styles');
  md += renderChangeGroup(event, 'variables', 'Variables');

  return md.trimEnd();
}

// Fallback renderer for any other event type: header plus every remaining field.
function formatGenericEvent(event: Record<string, unknown>): string {
  const type = asString(event.event_type) ?? 'unknown';
  let md = `## Figma event: \`${type}\`\n\n`;

  const fileName = asString(event.file_name);
  if (fileName) {
    const url = figmaFileUrl(asString(event.file_key));
    md += url ? `**[${fileName}](${url})**\n\n` : `**${fileName}**\n\n`;
  }

  const meta: string[] = [];
  const by = triggeredByName(event.triggered_by);
  if (by) {
    meta.push(`By **${by}**`);
  }
  const when = asString(event.timestamp);
  if (when) {
    meta.push(when);
  }
  if (meta.length > 0) {
    md += `${meta.join(' · ')}\n\n`;
  }

  const covered = new Set([
    'event_type',
    'file_name',
    'file_key',
    'triggered_by',
    'timestamp',
    'webhook_id',
  ]);
  for (const [key, value] of Object.entries(event)) {
    if (covered.has(key)) {
      continue;
    }
    const rendered =
      value && typeof value === 'object'
        ? `\n\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``
        : ` ${String(value)}`;
    md += `- **${key}:**${rendered}\n`;
  }

  return md.trimEnd();
}

// Build the rich-markdown body, then append the complete raw payload so no
// information from the event is lost.
function formatEventMarkdown(event: Record<string, unknown>): string {
  const summary =
    asString(event.event_type) === 'LIBRARY_PUBLISH'
      ? formatLibraryPublish(event)
      : formatGenericEvent(event);
  const raw = JSON.stringify(event, null, 2);
  return `${summary}\n\n### Full event payload\n\`\`\`json\n${raw}\n\`\`\``;
}

async function postToSlashwork(
  markdown: string,
  metadata: unknown,
): Promise<void> {
  const mutation = `
    mutation CreatePost($groupId: ID!, $input: CreatePostMutationInput!) {
      createPost(groupId: $groupId, input: $input) {
        node {
          id
        }
      }
    }`;
  const res = await fetch(SLASHWORK_GRAPHQL_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${SLASHWORK_AUTH_TOKEN}`,
    },
    body: JSON.stringify({
      query: mutation,
      variables: {
        groupId: SLASHWORK_GROUP_ID,
        input: { markdown, metadata: JSON.stringify(metadata) },
      },
    }),
  });
  if (!res.ok) {
    throw new Error(`Slashwork API error: ${res.status} ${await res.text()}`);
  }
  const result = (await res.json()) as GraphQLResponse;
  if (result.errors && result.errors.length > 0) {
    throw new Error(
      `Slashwork GraphQL errors: ${JSON.stringify(result.errors)}`,
    );
  }
  console.log(
    `  → posted to Slashwork (${result.data?.createPost?.node?.id ?? 'unknown id'})`,
  );
}

// --- HTTP server -----------------------------------------------------------

const app = express();
app.use(express.json());

// Kick off the one-time OAuth authorization with PKCE + a CSRF state value.
app.get(AUTH_PATH, (_req, res) => {
  const state = crypto.randomBytes(16).toString('hex');
  const codeVerifier = crypto.randomBytes(32).toString('base64url');
  const codeChallenge = crypto
    .createHash('sha256')
    .update(codeVerifier)
    .digest('base64url');
  pendingAuth.set(state, codeVerifier);

  const params = new URLSearchParams({
    client_id: FIGMA_CLIENT_ID,
    redirect_uri: FIGMA_OAUTH_REDIRECT_URI,
    scope: OAUTH_SCOPES,
    state,
    response_type: 'code',
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });
  res.redirect(`${FIGMA_OAUTH_URL}?${params.toString()}`);
});

app.get(CALLBACK_PATH, (req, res) => {
  const code = typeof req.query.code === 'string' ? req.query.code : undefined;
  const state =
    typeof req.query.state === 'string' ? req.query.state : undefined;
  const error =
    typeof req.query.error === 'string' ? req.query.error : undefined;

  if (error) {
    res.status(400).send(`Figma authorization failed: ${error}`);
    return;
  }
  const codeVerifier = state ? pendingAuth.get(state) : undefined;
  if (!code || !state || !codeVerifier) {
    res.status(400).send('Invalid or expired authorization request.');
    return;
  }
  pendingAuth.delete(state);

  exchangeCode(code, codeVerifier)
    .then(() => {
      res.send('✅ Figma authorization complete. You can close this tab.');
      console.log('OAuth authorization complete — syncing webhooks…');
      syncWebhooksWithHint();
    })
    .catch((err: unknown) => {
      console.error('OAuth callback error:', err);
      if (!res.headersSent) {
        res.status(500).send('Authorization failed. Check the server logs.');
      }
    });
});

app.post(WEBHOOK_PATH, (req, res) => {
  const body = (req.body ?? {}) as Record<string, unknown>;

  // Figma echoes the passcode we set on the webhook in every payload. It's the
  // only authenticity signal, so reject anything that doesn't match.
  if (body.passcode !== FIGMA_WEBHOOK_PASSCODE) {
    console.warn('Rejected webhook delivery with invalid passcode');
    res.sendStatus(401);
    return;
  }

  res.sendStatus(200);

  const eventType = String(body.event_type);
  if (eventType === 'PING') {
    console.log('✓ PING received — webhook endpoint is confirmed active');
    return;
  }

  console.log(`\n── Figma event: ${eventType} ──────────────────────────`);
  console.log(JSON.stringify(body, null, 2));

  // Drop the passcode — it's our shared secret and must not be posted to or
  // stored in the Slashwork stream.
  const { passcode: _passcode, ...event } = body;
  postToSlashwork(formatEventMarkdown(event), event).catch((err: unknown) => {
    console.error('Failed to post event to Slashwork:', err);
  });
});

app.listen(PORT, () => {
  console.log(`Figma webhook server listening on port ${PORT}`);
  loadTokens();
  if (!tokens) {
    console.log(
      `Not yet authorized with Figma. Visit ${AUTH_START_URL} to grant access.`,
    );
    return;
  }
  syncWebhooksWithHint();
});
