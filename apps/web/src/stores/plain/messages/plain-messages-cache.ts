import type { PlainConversation, PlainMessageType } from "../types";

/**
 * Encrypted local cache for the plain DM conversation list.
 *
 * Owns only the AES-GCM localStorage persistence layer extracted from
 * `plain-messages-store.ts`: cache key naming, per-user key derivation, and
 * save/load of conversation summaries. It is store-agnostic — every function
 * takes explicit identity arguments and never touches the Zustand `set/get`.
 *
 * The cache stores only a per-conversation summary (last message + counters),
 * not full history; full history is reloaded from the API after restore.
 */

interface CachedConvEntry {
  userId: string;
  username: string;
  lastMessageAt: number;
  unreadCount: number;
  lastMessage?: { id: string; clientId: string; senderId: string; senderName: string; content: string; type: PlainMessageType; timestamp: number; isOwn: boolean };
}

/** localStorage key holding the encrypted conversation cache for a user. */
export function cacheStorageKey(myUserId: string): string {
  return `plain_convs_v2_${myUserId}`;
}

// Derive a per-user AES-GCM key from userId + deviceId using PBKDF2.
// This prevents another user on the same browser from reading cached messages.
async function deriveCacheKey(myUserId: string, deviceId: string): Promise<CryptoKey> {
  const enc = new TextEncoder();
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    enc.encode(`${myUserId}:${deviceId}`),
    "PBKDF2",
    false,
    ["deriveKey"]
  );
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", salt: enc.encode("plain_cache_v2"), iterations: 100_000, hash: "SHA-256" },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

/**
 * Persist a conversation-summary snapshot to encrypted localStorage.
 * Best-effort: quota, private-mode, and crypto errors are swallowed.
 */
export async function saveConversationsCache(
  myUserId: string,
  deviceId: string,
  conversations: Record<string, PlainConversation>
): Promise<void> {
  try {
    const entries: CachedConvEntry[] = Object.values(conversations).map((c) => {
      const last = c.messages.at(-1);
      return {
        userId: c.userId,
        username: c.username,
        lastMessageAt: c.lastMessageAt,
        unreadCount: c.unreadCount,
        lastMessage: last ? {
          id: last.id,
          clientId: last.clientId,
          senderId: last.senderId,
          senderName: last.senderName,
          content: last.content,
          type: last.type,
          timestamp: last.timestamp,
          isOwn: last.isOwn,
        } : undefined,
      };
    });
    const plaintext = new TextEncoder().encode(JSON.stringify(entries));
    const key = await deriveCacheKey(myUserId, deviceId);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plaintext);
    const blob = new Uint8Array(iv.byteLength + ciphertext.byteLength);
    blob.set(iv, 0);
    blob.set(new Uint8Array(ciphertext), iv.byteLength);
    // Encode in chunks: `String.fromCodePoint(...blob)` throws RangeError when
    // the spread exceeds the engine argument limit for large caches.
    const CHUNK = 8192;
    let binary = "";
    for (let offset = 0; offset < blob.length; offset += CHUNK) {
      binary += String.fromCodePoint(...blob.subarray(offset, offset + CHUNK));
    }
    localStorage.setItem(cacheStorageKey(myUserId), btoa(binary));
  } catch {
    // quota exceeded, private mode, or crypto error — ignore
  }
}

/**
 * Restore conversation stubs from encrypted localStorage.
 * Returns an empty record on any miss/decrypt failure. Restored conversations
 * are marked `historyLoaded: false` so the store reloads full history.
 */
export async function loadConversationsCache(
  myUserId: string,
  deviceId: string
): Promise<Record<string, PlainConversation>> {
  try {
    const raw = localStorage.getItem(cacheStorageKey(myUserId));
    if (!raw) return {};
    const blob = Uint8Array.from(atob(raw), (c) => c.codePointAt(0) ?? 0);
    const iv = blob.slice(0, 12);
    const ciphertext = blob.slice(12);
    const key = await deriveCacheKey(myUserId, deviceId);
    const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, ciphertext);
    const entries = JSON.parse(new TextDecoder().decode(plaintext)) as CachedConvEntry[];
    const result: Record<string, PlainConversation> = {};
    for (const e of entries) {
      result[e.userId] = {
        userId: e.userId,
        username: e.username,
        displayName: null,
        avatarKey: null,
        messages: e.lastMessage ? [{ ...e.lastMessage, status: "sent" as const }] : [],
        lastMessageAt: e.lastMessageAt,
        unreadCount: e.unreadCount,
        hasMore: false,
        historyLoaded: false,
      };
    }
    return result;
  } catch {
    return {};
  }
}
