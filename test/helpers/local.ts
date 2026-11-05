// In-memory LocalState for API-level tests.
import { createHash } from 'node:crypto';
import type { Change, FileMode, LocalState } from '../../src/changes.ts';

export const blobSha = (data: Buffer): string => createHash('sha1').update(`blob ${data.length}\0`).update(data).digest('hex');

export function fakeLocal(files: Record<string, { mode?: FileMode; data: string | Buffer } | null>, head = 'f'.repeat(40)): LocalState {
  const blobs = new Map<string, Buffer>();
  const changes: Change[] = Object.entries(files).map(([path, file]) => {
    if (!file) return { path, mode: null, sha: null };
    const data = Buffer.from(file.data);
    const sha = blobSha(data);
    blobs.set(sha, data);
    return { path, mode: file.mode ?? '100644', sha };
  });
  return {
    head,
    changes,
    read: async (sha) => {
      const data = blobs.get(sha);
      if (!data) throw new Error(`no blob ${sha}`);
      return data;
    },
  };
}
