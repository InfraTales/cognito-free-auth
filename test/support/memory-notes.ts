import { randomUUID } from 'node:crypto';
import type { Note, Notes } from '../../src/notes';

/** In-memory Notes for handler tests. It counts calls so tests can prove the store wasn't touched. */
export class MemoryNotes implements Notes {
  calls = 0;
  failNext = false;
  private readonly byUser = new Map<string, Note[]>();

  private touch() {
    this.calls += 1;
    if (this.failNext) {
      this.failNext = false;
      throw new Error('store unavailable');
    }
  }

  list(sub: string): Promise<Note[]> {
    this.touch();
    return Promise.resolve([...(this.byUser.get(sub) ?? [])].reverse());
  }

  create(sub: string, text: string): Promise<Note> {
    this.touch();
    const now = new Date();
    const note = { id: `${String(now.getTime()).padStart(13, '0')}-${randomUUID()}`, text, createdAt: now.toISOString() };
    this.byUser.set(sub, [...(this.byUser.get(sub) ?? []), note]);
    return Promise.resolve(note);
  }

  delete(sub: string, id: string): Promise<boolean> {
    this.touch();
    const notes = this.byUser.get(sub) ?? [];
    const kept = notes.filter((n) => n.id !== id);
    this.byUser.set(sub, kept);
    return Promise.resolve(kept.length !== notes.length);
  }
}
