/**
 * Plain-message reply-target validation.
 *
 * `replyToId` is client-supplied and was previously accepted as any UUID. The
 * history queries LEFT JOIN the referenced row and return its `content`, so an
 * unvalidated reference disclosed messages from other threads (see AUDIT.md H1).
 *
 * These helpers verify that the referenced message is visible to the caller and
 * belongs to the same conversation before the insert is allowed.
 */
import { query } from "../../db/pool.js";

/**
 * Returns true when `replyToId` refers to a non-deleted message in the DM thread
 * between `userId` and `recipientUserId` that the caller can see.
 */
export async function isVisibleDirectReplyTarget(params: {
  replyToId: string;
  userId: string;
  recipientUserId: string;
}): Promise<boolean> {
  const { replyToId, userId, recipientUserId } = params;
  const [row] = await query<{ id: string }>(
    `SELECT id FROM plain_messages
      WHERE id = $1
        AND deleted_at IS NULL
        AND recipient_user_id IS NOT NULL
        AND group_id IS NULL
        AND (
          (sender_user_id = $2 AND recipient_user_id = $3) OR
          (sender_user_id = $3 AND recipient_user_id = $2)
        )`,
    [replyToId, userId, recipientUserId]
  );
  return Boolean(row);
}

/**
 * Returns true when `replyToId` refers to a non-deleted message in `groupId`
 * (membership is enforced by the caller before this check).
 */
export async function isVisibleGroupReplyTarget(params: {
  replyToId: string;
  groupId: string;
}): Promise<boolean> {
  const { replyToId, groupId } = params;
  const [row] = await query<{ id: string }>(
    `SELECT id FROM plain_messages
      WHERE id = $1
        AND deleted_at IS NULL
        AND group_id = $2`,
    [replyToId, groupId]
  );
  return Boolean(row);
}
