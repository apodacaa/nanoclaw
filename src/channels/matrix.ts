import fs from 'fs';
import path from 'path';

import { ASSISTANT_NAME, DATA_DIR } from '../config.js';
import { readEnvFile } from '../env.js';
import { logger } from '../logger.js';
import { registerChannel, ChannelOpts } from './registry.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

// ---------------------------------------------------------------------------
// Types matching the Matrix Client-Server API responses
// ---------------------------------------------------------------------------

interface SyncResponse {
  next_batch: string;
  rooms?: {
    join?: Record<string, SyncJoinedRoom>;
    invite?: Record<string, SyncInvitedRoom>;
  };
}

interface SyncJoinedRoom {
  timeline: { events: MatrixEvent[] };
  state: { events: MatrixEvent[] };
}

interface SyncInvitedRoom {
  invite_state: { events: MatrixEvent[] };
}

interface MatrixEvent {
  type: string;
  content: Record<string, any>;
  sender: string;
  room_id: string;
  event_id: string;
  origin_server_ts: number;
  state_key?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function syncTokenPath(botIndex: number): string {
  const suffix = botIndex === 1 ? '' : `-${botIndex}`;
  return path.join(DATA_DIR, `matrix-sync-token${suffix}.txt`);
}

function readSyncToken(botIndex: number): string | null {
  try {
    return fs.readFileSync(syncTokenPath(botIndex), 'utf-8').trim() || null;
  } catch {
    return null;
  }
}

function writeSyncToken(botIndex: number, token: string): void {
  try {
    fs.mkdirSync(path.dirname(syncTokenPath(botIndex)), { recursive: true });
    fs.writeFileSync(syncTokenPath(botIndex), token, 'utf-8');
  } catch (err) {
    logger.debug({ err }, 'Failed to persist Matrix sync token');
  }
}

/** Extract @localpart from @localpart:domain */
function displayNameFromUserId(userId: string): string {
  const match = userId.match(/^@([^:]+)/);
  return match ? match[1] : userId;
}

// ---------------------------------------------------------------------------
// MatrixChannel
// ---------------------------------------------------------------------------

export interface MatrixChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
}

export class MatrixChannel implements Channel {
  name: string;

  private baseUrl: string;
  private botUsername: string;
  private botPassword: string;
  private botIndex: number;
  private displayName: string;
  private accessToken: string | null = null;
  private botUserId: string | null = null;
  private syncToken: string | null = null;
  private abortController: AbortController | null = null;
  private running = false;
  private opts: MatrixChannelOpts;
  private startedAt = 0;
  private joinedRooms = new Set<string>();

  constructor(
    baseUrl: string,
    username: string,
    password: string,
    botIndex: number,
    displayName: string,
    opts: MatrixChannelOpts,
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.botUsername = username;
    this.botPassword = password;
    this.botIndex = botIndex;
    this.displayName = displayName;
    this.name = botIndex === 1 ? 'matrix' : `matrix-${botIndex}`;
    this.opts = opts;
  }

  // ── HTTP helpers ───────────────────────────────────────────────────────

  private async api<T = any>(
    method: string,
    endpoint: string,
    body?: unknown,
    noAuth?: boolean,
  ): Promise<T> {
    const url = `${this.baseUrl}/_matrix/client/v3${endpoint}`;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (!noAuth && this.accessToken) {
      headers['Authorization'] = `Bearer ${this.accessToken}`;
    }
    const resp = await fetch(url, {
      method,
      headers,
      body: body != null ? JSON.stringify(body) : undefined,
      signal: this.abortController?.signal,
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`Matrix ${method} ${endpoint}: ${resp.status} ${text}`);
    }
    return resp.json() as Promise<T>;
  }

  /** Long-poll /sync with its own abort controller so disconnect() can cancel it. */
  private async syncOnce(
    since: string | null,
    timeout: number,
  ): Promise<SyncResponse> {
    const params = new URLSearchParams({ timeout: String(timeout) });
    if (since) params.set('since', since);
    const url = `${this.baseUrl}/_matrix/client/v3/sync?${params}`;
    const headers: Record<string, string> = {};
    if (this.accessToken) {
      headers['Authorization'] = `Bearer ${this.accessToken}`;
    }
    const resp = await fetch(url, {
      headers,
      signal: this.abortController?.signal,
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      throw new Error(`Matrix sync: ${resp.status} ${text}`);
    }
    return resp.json() as Promise<SyncResponse>;
  }

  // ── Connect ────────────────────────────────────────────────────────────

  async connect(): Promise<void> {
    this.startedAt = Date.now();
    this.abortController = new AbortController();

    // Try register with UIAA flow, fall back to login if user exists
    try {
      // Step 1: probe to get UIAA session
      const probeResp = await fetch(
        `${this.baseUrl}/_matrix/client/v3/register`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            username: this.botUsername,
            password: this.botPassword,
          }),
          signal: this.abortController?.signal,
        },
      );
      const probe = (await probeResp.json()) as any;

      if (probe.session) {
        // Step 2: complete with m.login.dummy
        const reg = await this.api<{ user_id: string; access_token: string }>(
          'POST',
          '/register',
          {
            username: this.botUsername,
            password: this.botPassword,
            auth: { type: 'm.login.dummy', session: probe.session },
          },
          true,
        );
        this.accessToken = reg.access_token;
        this.botUserId = reg.user_id;
        logger.info({ userId: this.botUserId }, 'Matrix bot registered');
      } else if (probe.access_token) {
        // Server returned token directly (no UIAA)
        this.accessToken = probe.access_token;
        this.botUserId = probe.user_id;
        logger.info({ userId: this.botUserId }, 'Matrix bot registered');
      } else {
        throw new Error(probe.errcode || 'registration failed');
      }
    } catch {
      // Already registered or registration failed — log in
      const login = await this.api<{ user_id: string; access_token: string }>(
        'POST',
        '/login',
        {
          type: 'm.login.password',
          user: this.botUsername,
          password: this.botPassword,
        },
        true,
      );
      this.accessToken = login.access_token;
      this.botUserId = login.user_id;
      logger.info({ userId: this.botUserId }, 'Matrix bot logged in');
    }

    // Set display name
    try {
      await this.api(
        'PUT',
        `/profile/${encodeURIComponent(this.botUserId!)}/displayname`,
        { displayname: this.displayName },
      );
    } catch (err) {
      logger.debug({ err }, 'Failed to set Matrix display name');
    }

    // Populate joinedRooms from /joined_rooms before starting the sync loop.
    // This is required for correct routing when multiple Matrix bots are
    // connected: routeOutbound picks the first channel whose ownsJid returns
    // true, and ownsJid relies on joinedRooms. Without this, a bot with a
    // persisted sync token has empty joinedRooms (since incremental syncs
    // only include rooms with new activity), falls back to claiming every
    // mx: jid, and ends up handing replies to the wrong bot — which then
    // 403s because it's not a member of the target room.
    try {
      const resp = await this.api<{ joined_rooms: string[] }>(
        'GET',
        '/joined_rooms',
      );
      for (const roomId of resp.joined_rooms || []) {
        this.joinedRooms.add(`mx:${roomId}`);
      }
    } catch (err) {
      logger.warn({ err }, 'Matrix /joined_rooms failed; routing may be wrong');
    }

    // Restore persisted sync token or do an initial sync to drain history
    this.syncToken = readSyncToken(this.botIndex);
    if (!this.syncToken) {
      try {
        const initial = await this.syncOnce(null, 0);
        this.syncToken = initial.next_batch;
        writeSyncToken(this.botIndex, this.syncToken);
      } catch (err) {
        logger.warn({ err }, 'Matrix initial sync failed');
      }
    }

    this.running = true;
    this.pollLoop();

    console.log(`\n  Matrix bot: ${this.botUserId}`);
    console.log(`  Homeserver: ${this.baseUrl}\n`);
  }

  // ── Sync loop ──────────────────────────────────────────────────────────

  private async pollLoop(): Promise<void> {
    while (this.running) {
      try {
        const resp = await this.syncOnce(this.syncToken, 30000);
        this.syncToken = resp.next_batch;
        writeSyncToken(this.botIndex, this.syncToken);
        await this.processSync(resp);
      } catch (err: any) {
        if (err?.name === 'AbortError') break;
        logger.warn({ err }, 'Matrix sync error, retrying in 5s');
        await new Promise((r) => setTimeout(r, 5000));
      }
    }
  }

  private async processSync(resp: SyncResponse): Promise<void> {
    // Auto-join invited rooms
    if (resp.rooms?.invite) {
      for (const roomId of Object.keys(resp.rooms.invite)) {
        try {
          await this.api('POST', `/join/${encodeURIComponent(roomId)}`, {});
          this.joinedRooms.add(`mx:${roomId}`);
          logger.info({ roomId }, 'Matrix auto-joined room');
        } catch (err) {
          logger.warn({ roomId, err }, 'Matrix failed to auto-join room');
        }
      }
    }

    // Process messages from joined rooms
    if (!resp.rooms?.join) return;

    for (const [roomId, room] of Object.entries(resp.rooms.join)) {
      this.joinedRooms.add(`mx:${roomId}`);
      const events = room.timeline?.events;
      if (!events) continue;

      // Try to extract room name from state events
      let roomName: string | undefined;
      for (const se of room.state?.events || []) {
        if (se.type === 'm.room.name' && se.content?.name) {
          roomName = se.content.name;
        }
      }

      const chatJid = `mx:${roomId}`;

      for (const event of events) {
        // Only handle m.room.message
        if (event.type !== 'm.room.message') continue;
        // Skip own messages
        if (event.sender === this.botUserId) continue;
        // Skip messages from before startup (prevents replay on first sync)
        if (event.origin_server_ts < this.startedAt) continue;

        const msgtype = event.content?.msgtype || '';
        let content: string;

        if (msgtype === 'm.text') {
          content = event.content.body || '';
        } else if (msgtype === 'm.image') {
          content = '[Image]';
        } else if (msgtype === 'm.file') {
          const fname = event.content.body || 'file';
          content = `[File: ${fname}]`;
        } else if (msgtype === 'm.audio') {
          content = '[Audio]';
        } else if (msgtype === 'm.video') {
          content = '[Video]';
        } else {
          content = `[${msgtype}]`;
        }

        const senderName = displayNameFromUserId(event.sender);
        const timestamp = new Date(event.origin_server_ts).toISOString();

        // Report metadata for chat discovery
        this.opts.onChatMetadata(chatJid, timestamp, roomName, 'matrix', true);

        // Only deliver to registered groups
        const group = this.opts.registeredGroups()[chatJid];
        if (!group) {
          logger.debug(
            { chatJid, roomName },
            'Message from unregistered Matrix room',
          );
          continue;
        }

        this.opts.onMessage(chatJid, {
          id: event.event_id,
          chat_jid: chatJid,
          sender: event.sender,
          sender_name: senderName,
          content,
          timestamp,
          is_from_me: false,
        });

        logger.info(
          { chatJid, roomName, sender: senderName },
          'Matrix message stored',
        );
      }
    }
  }

  // ── Send ───────────────────────────────────────────────────────────────

  async sendMessage(jid: string, text: string): Promise<void> {
    const roomId = jid.replace(/^mx:/, '');
    const txnId = `nc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    try {
      await this.api(
        'PUT',
        `/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${txnId}`,
        { msgtype: 'm.text', body: text },
      );
      logger.info({ jid, length: text.length }, 'Matrix message sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Matrix message');
    }
  }

  // Upload an audio file to the homeserver and post it as an m.audio message.
  // Mime is hard-coded to audio/mpeg — we only send .mp3 course clips right now.
  async sendAudio(
    jid: string,
    filePath: string,
    caption?: string,
  ): Promise<void> {
    const roomId = jid.replace(/^mx:/, '');
    const filename = path.basename(filePath);
    const body = caption || filename;

    let bytes: Buffer;
    try {
      bytes = fs.readFileSync(filePath);
    } catch (err) {
      logger.error({ jid, filePath, err }, 'Matrix sendAudio: read failed');
      throw err;
    }

    // 1. Upload bytes to the media repo.
    const uploadUrl = `${this.baseUrl}/_matrix/media/v3/upload?filename=${encodeURIComponent(
      filename,
    )}`;
    let contentUri: string;
    try {
      const resp = await fetch(uploadUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'audio/mpeg',
          Authorization: `Bearer ${this.accessToken}`,
        },
        body: new Uint8Array(bytes),
        signal: this.abortController?.signal,
      });
      if (!resp.ok) {
        const text = await resp.text().catch(() => '');
        throw new Error(`upload: ${resp.status} ${text}`);
      }
      const json = (await resp.json()) as { content_uri: string };
      contentUri = json.content_uri;
    } catch (err) {
      logger.error({ jid, filePath, err }, 'Matrix audio upload failed');
      throw err;
    }

    // 2. Post m.audio message referencing the uploaded mxc:// URI.
    const txnId = `nc-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    try {
      await this.api(
        'PUT',
        `/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${txnId}`,
        {
          msgtype: 'm.audio',
          body,
          url: contentUri,
          info: { mimetype: 'audio/mpeg', size: bytes.length },
        },
      );
      logger.info({ jid, filename, size: bytes.length }, 'Matrix audio sent');
    } catch (err) {
      logger.error({ jid, filePath, err }, 'Matrix audio send failed');
      throw err;
    }
  }

  // ── Interface methods ──────────────────────────────────────────────────

  isConnected(): boolean {
    return this.running;
  }

  ownsJid(jid: string): boolean {
    if (!jid.startsWith('mx:')) return false;
    return this.joinedRooms.has(jid);
  }

  async disconnect(): Promise<void> {
    this.running = false;
    this.abortController?.abort();
    this.abortController = null;
    logger.info('Matrix channel stopped');
  }

  async setTyping(jid: string, isTyping: boolean): Promise<void> {
    if (!isTyping || !this.botUserId) return;
    const roomId = jid.replace(/^mx:/, '');
    try {
      await this.api(
        'PUT',
        `/rooms/${encodeURIComponent(roomId)}/typing/${encodeURIComponent(this.botUserId)}`,
        { typing: true, timeout: 30000 },
      );
    } catch (err) {
      logger.debug({ jid, err }, 'Failed to send Matrix typing indicator');
    }
  }
}

// ---------------------------------------------------------------------------
// Self-registration — scan for numbered bot credentials
// ---------------------------------------------------------------------------

// Collect all MATRIX_BOT_N_USERNAME / MATRIX_BOT_N_PASSWORD / MATRIX_BOT_N_DISPLAY_NAME
// keys we might need
const allBotKeys: string[] = ['MATRIX_BASE_URL'];
for (let i = 1; i <= 10; i++) {
  allBotKeys.push(
    `MATRIX_BOT_${i}_USERNAME`,
    `MATRIX_BOT_${i}_PASSWORD`,
    `MATRIX_BOT_${i}_DISPLAY_NAME`,
  );
}
const matrixEnv = readEnvFile(allBotKeys);

function getEnv(key: string): string {
  return process.env[key] || matrixEnv[key] || '';
}

const matrixBaseUrl = getEnv('MATRIX_BASE_URL');

for (let i = 1; i <= 10; i++) {
  const username = getEnv(`MATRIX_BOT_${i}_USERNAME`);
  const password = getEnv(`MATRIX_BOT_${i}_PASSWORD`);
  if (!username || !password) break; // stop at first gap

  if (!matrixBaseUrl) {
    logger.warn('Matrix: MATRIX_BASE_URL not set');
    break;
  }

  // Per-bot display name overrides ASSISTANT_NAME — needed when the same
  // homeserver hosts multiple distinct assistants (e.g. Ivy + Ken).
  const displayName = getEnv(`MATRIX_BOT_${i}_DISPLAY_NAME`) || ASSISTANT_NAME;

  const channelName = i === 1 ? 'matrix' : `matrix-${i}`;
  const idx = i; // capture for closure
  registerChannel(channelName, (opts: ChannelOpts) => {
    return new MatrixChannel(
      matrixBaseUrl,
      username,
      password,
      idx,
      displayName,
      opts,
    );
  });
}
