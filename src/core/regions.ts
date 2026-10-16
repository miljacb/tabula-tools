/** Atlas region paths referenced by skeletons (sequence frames expanded). */

import { sequenceFramePath } from './attachments.js';
import type { Attachment, SkeletonData } from './types.js';

/** Region paths one attachment can show: its path, or every frame of its sequence. */
export function attachmentRegionPaths(attachment: Attachment): string[] {
  if (attachment.type !== 'region' && attachment.type !== 'mesh') return [];
  const sequence = attachment.sequence;
  if (!sequence) return [attachment.path];
  return Array.from({ length: sequence.count }, (_, i) => sequenceFramePath(attachment.path, sequence, i));
}

/** Every region path any skin of `data` can show, in first-use order. */
export function regionPathsOf(data: SkeletonData): Set<string> {
  const paths = new Set<string>();
  for (const skin of data.skins) {
    for (const attachments of skin.attachments.values()) {
      for (const attachment of attachments.values()) for (const p of attachmentRegionPaths(attachment)) paths.add(p);
    }
  }
  return paths;
}
