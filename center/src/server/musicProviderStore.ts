import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
} from "node:crypto";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

export type YoutubeOAuthCredentials = {
  access_token: string;
  expiry_date: string;
  refresh_token: string;
  expires_in?: number;
  scope?: string;
  token_type?: string;
  client?: { client_id: string; client_secret: string };
};

export type TidalCredentials = {
  access_token: string;
  refresh_token?: string;
  expires_at: number;
  user_id?: string;
  country_code?: string;
  scope?: string;
  token_type?: string;
};

export type MusicAccountRecord = {
  version: 1;
  youtube_music?: {
    credentials: YoutubeOAuthCredentials;
    connected_at: string;
  };
  apple_music?: {
    music_user_token: string;
    storefront?: string;
    connected_at: string;
  };
  tidal?: {
    credentials?: TidalCredentials;
    connected_at?: string;
    pending?: {
      state: string;
      verifier: string;
      redirect_uri: string;
      expires_at: number;
    };
  };
};

type StoredEnvelope = {
  version: 1;
  algorithm: "aes-256-gcm";
  iv: string;
  ciphertext: string;
  tag: string;
};

const STORE_CONTEXT = "ai-pin-revival/music-provider-store/v1";
const MAX_STORE_BYTES = 128 * 1024;
const accountLocks = new Map<string, Promise<void>>();

export class MusicSessionStoreError extends Error {
  constructor(message = "Music account storage is unavailable.") {
    super(message);
    this.name = "MusicSessionStoreError";
  }
}

function boundedVisibleSecret(value: string | undefined): string {
  const secret = value?.trim() ?? "";
  if (
    secret.length < 32 ||
    secret.length > 512 ||
    ![...secret].every((character) => {
      const code = character.charCodeAt(0);
      return code >= 0x21 && code <= 0x7e;
    })
  ) {
    throw new MusicSessionStoreError();
  }
  return secret;
}

function storeSecret(): string {
  const dedicated = process.env.REVIVAL_MUSIC_SESSION_SECRET?.trim();
  return boundedVisibleSecret(dedicated || process.env.AUTH_SESSION_SECRET);
}

function accountKey(subject: string): Buffer {
  return createHmac("sha256", storeSecret())
    .update(`${STORE_CONTEXT}\u0000${subject}`, "utf8")
    .digest();
}

function subjectDigest(subject: string): string {
  if (!subject || [...subject].length > 512 || /\p{Cc}/u.test(subject)) {
    throw new MusicSessionStoreError();
  }
  return createHash("sha256").update(subject, "utf8").digest("hex");
}

export function musicSessionStoreFile(subject: string): string {
  const root = process.env.REVIVAL_MUSIC_SESSION_DIR?.trim() || "/data/music-sessions";
  if (!path.isAbsolute(root)) throw new MusicSessionStoreError();
  return path.join(root, `${subjectDigest(subject)}.json`);
}

function aad(subject: string): Buffer {
  return Buffer.from(`${STORE_CONTEXT}\u0000${subject}`, "utf8");
}

function encryptRecord(subject: string, record: MusicAccountRecord): StoredEnvelope {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", accountKey(subject), iv, {
    authTagLength: 16,
  });
  cipher.setAAD(aad(subject));
  const plaintext = Buffer.from(JSON.stringify(record), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  plaintext.fill(0);
  return {
    version: 1,
    algorithm: "aes-256-gcm",
    iv: iv.toString("base64url"),
    ciphertext: ciphertext.toString("base64url"),
    tag: tag.toString("base64url"),
  };
}

function decodeBase64Url(value: unknown, bytes?: number): Buffer {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new MusicSessionStoreError();
  }
  const decoded = Buffer.from(value, "base64url");
  if ((bytes !== undefined && decoded.length !== bytes) || decoded.length === 0) {
    throw new MusicSessionStoreError();
  }
  return decoded;
}

function recordShape(value: unknown): MusicAccountRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new MusicSessionStoreError();
  }
  const record = value as Record<string, unknown>;
  if (
    record.version !== 1 ||
    Object.keys(record).some(
      (key) => !new Set(["version", "youtube_music", "apple_music", "tidal"]).has(key),
    )
  ) {
    throw new MusicSessionStoreError();
  }
  return value as MusicAccountRecord;
}

function decryptRecord(subject: string, value: unknown): MusicAccountRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new MusicSessionStoreError();
  }
  const envelope = value as Record<string, unknown>;
  if (
    envelope.version !== 1 ||
    envelope.algorithm !== "aes-256-gcm" ||
    Object.keys(envelope).some(
      (key) => !new Set(["version", "algorithm", "iv", "ciphertext", "tag"]).has(key),
    )
  ) {
    throw new MusicSessionStoreError();
  }
  const iv = decodeBase64Url(envelope.iv, 12);
  const ciphertext = decodeBase64Url(envelope.ciphertext);
  const tag = decodeBase64Url(envelope.tag, 16);
  try {
    const decipher = createDecipheriv("aes-256-gcm", accountKey(subject), iv, {
      authTagLength: 16,
    });
    decipher.setAAD(aad(subject));
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    try {
      return recordShape(JSON.parse(plaintext.toString("utf8")));
    } finally {
      plaintext.fill(0);
    }
  } catch (error) {
    if (error instanceof MusicSessionStoreError) throw error;
    throw new MusicSessionStoreError();
  }
}

export async function readMusicAccountRecord(subject: string): Promise<MusicAccountRecord> {
  const file = musicSessionStoreFile(subject);
  let bytes: Buffer;
  try {
    bytes = await readFile(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1 };
    throw new MusicSessionStoreError();
  }
  if (bytes.length === 0 || bytes.length > MAX_STORE_BYTES) {
    throw new MusicSessionStoreError();
  }
  try {
    return decryptRecord(subject, JSON.parse(bytes.toString("utf8")));
  } catch (error) {
    if (error instanceof MusicSessionStoreError) throw error;
    throw new MusicSessionStoreError();
  } finally {
    bytes.fill(0);
  }
}

async function writeMusicAccountRecord(
  subject: string,
  record: MusicAccountRecord,
): Promise<void> {
  const file = musicSessionStoreFile(subject);
  const directory = path.dirname(file);
  const temporary = `${file}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  const encoded = `${JSON.stringify(encryptRecord(subject, record))}\n`;
  if (Buffer.byteLength(encoded) > MAX_STORE_BYTES) throw new MusicSessionStoreError();
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await chmod(directory, 0o700);
    await writeFile(temporary, encoded, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await rename(temporary, file);
    await chmod(file, 0o600);
  } catch {
    await unlink(temporary).catch(() => undefined);
    throw new MusicSessionStoreError();
  }
}

/** Serialize one wearer's read-modify-write so two provider callbacks cannot lose state. */
export async function updateMusicAccountRecord(
  subject: string,
  update: (current: MusicAccountRecord) => MusicAccountRecord | Promise<MusicAccountRecord>,
): Promise<MusicAccountRecord> {
  const key = subjectDigest(subject);
  const previous = accountLocks.get(key) ?? Promise.resolve();
  let release!: () => void;
  const currentLock = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queued = previous.then(() => currentLock);
  accountLocks.set(key, queued);
  await previous;
  try {
    const next = recordShape(await update(await readMusicAccountRecord(subject)));
    await writeMusicAccountRecord(subject, next);
    return next;
  } finally {
    release();
    if (accountLocks.get(key) === queued) accountLocks.delete(key);
  }
}
