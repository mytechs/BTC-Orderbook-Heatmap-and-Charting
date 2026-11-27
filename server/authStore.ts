import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { AuthUserInfo, UserWorkspaceState } from '../shared/types.ts';

interface StoredUserRecord {
  username: string;
  usernameLower: string;
  passwordSalt: string;
  passwordHash: string;
  createdAt: number;
  updatedAt: number;
  state: UserWorkspaceState;
  geminiApiKey?: string;
}

interface StoredSession {
  token: string;
  usernameLower: string;
  expiresAt: number;
}

interface AccountsFile {
  users: StoredUserRecord[];
  sessions: StoredSession[];
}

export const SESSION_COOKIE_NAME = 'heatmap_sid';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days
const USERNAME_RE = /^[a-zA-Z0-9_.-]{3,32}$/;

function hashPassword(password: string, salt: string): string {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

function verifyPassword(password: string, salt: string, expectedHex: string): boolean {
  const actual = Buffer.from(hashPassword(password, salt), 'hex');
  const expected = Buffer.from(expectedHex, 'hex');
  if (actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(actual, expected);
}

export function parseCookieHeader(cookieHeader?: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!cookieHeader) return out;
  const parts = cookieHeader.split(';');
  for (const part of parts) {
    const idx = part.indexOf('=');
    if (idx <= 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) {
      try {
        out[k] = decodeURIComponent(v);
      } catch {
        out[k] = v;
      }
    }
  }
  return out;
}

export class AccountStore {
  private filePath: string;
  private users = new Map<string, StoredUserRecord>();
  private sessions = new Map<string, StoredSession>();
  private writeInProgress = false;
  private writePending = false;
  private dirty = false;

  constructor(dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true });
    this.filePath = path.join(dataDir, 'accounts.json');
    this.loadFromDisk();
  }

  private loadFromDisk() {
    try {
      if (!fs.existsSync(this.filePath)) return;
      const raw = fs.readFileSync(this.filePath, 'utf-8');
      const parsed = JSON.parse(raw) as Partial<AccountsFile>;
      const now = Date.now();
      if (Array.isArray(parsed.users)) {
        for (const u of parsed.users) {
          if (u && typeof u.usernameLower === 'string' && typeof u.passwordHash === 'string') {
            this.users.set(u.usernameLower, u);
          }
        }
      }
      if (Array.isArray(parsed.sessions)) {
        for (const s of parsed.sessions) {
          if (s && s.token && s.expiresAt > now && this.users.has(s.usernameLower)) {
            this.sessions.set(s.token, s);
          }
        }
      }
    } catch {
      // Ignore corrupt file on fresh start
    }
  }

  private buildSerializedPayload(): string {
    const now = Date.now();
    for (const [tok, sess] of this.sessions.entries()) {
      if (sess.expiresAt <= now) this.sessions.delete(tok);
    }
    const payload: AccountsFile = {
      users: Array.from(this.users.values()),
      sessions: Array.from(this.sessions.values()),
    };
    return JSON.stringify(payload);
  }

  private persistToDisk() {
    const serialized = this.buildSerializedPayload();
    const tmpPath = `${this.filePath}.tmp`;
    fs.writeFileSync(tmpPath, serialized, { encoding: 'utf-8', mode: 0o600 });
    fs.renameSync(tmpPath, this.filePath);
    this.dirty = false;
  }

  private persistToDiskAsync() {
    this.dirty = true;
    if (this.writeInProgress) {
      this.writePending = true;
      return;
    }
    this.writeInProgress = true;
    const serialized = this.buildSerializedPayload();
    const tmpPath = `${this.filePath}.tmp`;
    fs.promises
      .writeFile(tmpPath, serialized, { encoding: 'utf-8', mode: 0o600 })
      .then(() => fs.promises.rename(tmpPath, this.filePath))
      .then(() => {
        this.dirty = false;
      })
      .catch(() => {
        // Ignore transient write error; next flush will retry
      })
      .finally(() => {
        this.writeInProgress = false;
        if (this.writePending) {
          this.writePending = false;
          this.persistToDiskAsync();
        }
      });
  }

  public flushSync() {
    if (this.dirty || this.writePending) {
      this.writePending = false;
      this.persistToDisk();
    }
  }

  private createSession(usernameLower: string): StoredSession {
    const token = crypto.randomBytes(32).toString('hex');
    const session: StoredSession = {
      token,
      usernameLower,
      expiresAt: Date.now() + SESSION_TTL_MS,
    };
    this.sessions.set(token, session);
    return session;
  }

  private toPublicUser(rec: StoredUserRecord): AuthUserInfo {
    return {
      username: rec.username,
      createdAt: rec.createdAt,
      updatedAt: rec.updatedAt,
    };
  }

  public register(
    usernameRaw: string,
    password: string,
    initialState?: UserWorkspaceState
  ): { ok: true; token: string; user: AuthUserInfo; state: UserWorkspaceState } | { ok: false; error: string } {
    const username = (usernameRaw || '').trim();
    if (!USERNAME_RE.test(username)) {
      return {
        ok: false,
        error: 'Username must be 3–32 characters (letters, numbers, _, ., -).',
      };
    }
    if (typeof password !== 'string' || password.length < 6) {
      return { ok: false, error: 'Password must be at least 6 characters.' };
    }
    if (password.length > 128) {
      return { ok: false, error: 'Password is too long.' };
    }

    const key = username.toLowerCase();
    if (this.users.has(key)) {
      return { ok: false, error: 'That username is already taken.' };
    }

    const now = Date.now();
    const salt = crypto.randomBytes(16).toString('hex');
    const hash = hashPassword(password, salt);
    const record: StoredUserRecord = {
      username,
      usernameLower: key,
      passwordSalt: salt,
      passwordHash: hash,
      createdAt: now,
      updatedAt: now,
      state: initialState && typeof initialState === 'object' ? initialState : {},
    };
    this.users.set(key, record);
    const session = this.createSession(key);
    this.persistToDisk();

    return {
      ok: true,
      token: session.token,
      user: this.toPublicUser(record),
      state: record.state,
    };
  }

  public login(
    usernameRaw: string,
    password: string
  ): { ok: true; token: string; user: AuthUserInfo; state: UserWorkspaceState } | { ok: false; error: string } {
    const key = (usernameRaw || '').trim().toLowerCase();
    const record = this.users.get(key);
    if (!record || typeof password !== 'string') {
      return { ok: false, error: 'Invalid username or password.' };
    }
    if (!verifyPassword(password, record.passwordSalt, record.passwordHash)) {
      return { ok: false, error: 'Invalid username or password.' };
    }
    const session = this.createSession(key);
    this.persistToDisk();
    return {
      ok: true,
      token: session.token,
      user: this.toPublicUser(record),
      state: record.state,
    };
  }

  public logout(token?: string) {
    if (!token) return;
    if (this.sessions.delete(token)) {
      this.persistToDisk();
    }
  }

  public getSessionUser(
    token?: string
  ): { user: AuthUserInfo; state: UserWorkspaceState } | null {
    if (!token) return null;
    const sess = this.sessions.get(token);
    if (!sess) return null;
    if (sess.expiresAt <= Date.now()) {
      this.sessions.delete(token);
      this.persistToDisk();
      return null;
    }
    const rec = this.users.get(sess.usernameLower);
    if (!rec) return null;
    return { user: this.toPublicUser(rec), state: rec.state };
  }

  public saveUserState(
    token: string | undefined,
    nextState: UserWorkspaceState
  ): { ok: true; updatedAt: number } | { ok: false; error: string } {
    if (!token) return { ok: false, error: 'Not authenticated.' };
    const sess = this.sessions.get(token);
    if (!sess || sess.expiresAt <= Date.now()) {
      return { ok: false, error: 'Session expired.' };
    }
    const rec = this.users.get(sess.usernameLower);
    if (!rec) return { ok: false, error: 'User not found.' };

    rec.state = {
      ...rec.state,
      ...nextState,
    };
    rec.updatedAt = Date.now();
    this.persistToDiskAsync();
    return { ok: true, updatedAt: rec.updatedAt };
  }

  public getUserGeminiKey(token?: string): string | null {
    if (!token) return null;
    const sess = this.sessions.get(token);
    if (!sess || sess.expiresAt <= Date.now()) return null;
    const rec = this.users.get(sess.usernameLower);
    if (!rec || !rec.geminiApiKey) return null;
    return rec.geminiApiKey;
  }

  public setUserGeminiKey(
    token: string | undefined,
    apiKeyRaw: string
  ): { ok: true; hasUserKey: boolean } | { ok: false; error: string } {
    if (!token) return { ok: false, error: 'Sign in first to save your API key to your account.' };
    const sess = this.sessions.get(token);
    if (!sess || sess.expiresAt <= Date.now()) {
      return { ok: false, error: 'Session expired. Please sign in again.' };
    }
    const rec = this.users.get(sess.usernameLower);
    if (!rec) return { ok: false, error: 'User not found.' };
    const trimmed = (apiKeyRaw || '').trim();
    if (trimmed.length > 256) {
      return { ok: false, error: 'API key looks too long.' };
    }
    if (trimmed) {
      rec.geminiApiKey = trimmed;
    } else {
      delete rec.geminiApiKey;
    }
    rec.updatedAt = Date.now();
    this.persistToDiskAsync();
    return { ok: true, hasUserKey: Boolean(rec.geminiApiKey) };
  }
}
