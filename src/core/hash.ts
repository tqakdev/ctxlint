import { createHash } from "node:crypto";

/** Short stable content hash — rule identity and compliance cache keys. */
export function sha1Hex(text: string, length = 12): string {
  return createHash("sha1").update(text).digest("hex").slice(0, length);
}
