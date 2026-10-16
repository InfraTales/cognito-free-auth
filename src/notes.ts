import { randomUUID } from 'node:crypto';
import { ConditionalCheckFailedException, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DeleteCommand, DynamoDBDocumentClient, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';

/** Table keys. The CDK stack and the DynamoDB Local tests both read these. */
export const PARTITION_KEY = 'pk'; // the user's sub
export const SORT_KEY = 'sk'; // the note ID

export const MAX_NOTE_LENGTH = 1000;
export const MAX_NOTES_PER_PAGE = 50;

/** Note IDs sort by creation time: 13-digit epoch milliseconds, a dash, then a random UUID. */
export const NOTE_ID = /^\d{13}-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface Note {
  id: string;
  text: string;
  createdAt: string;
}

export interface Notes {
  list(sub: string): Promise<Note[]>;
  create(sub: string, text: string): Promise<Note>;
  delete(sub: string, id: string): Promise<boolean>;
}

/**
 * Every key starts with the caller's `sub` from a verified token. No method takes a user ID
 * from the request, so one user can't name another user's partition.
 */
export class NotesStore implements Notes {
  private readonly doc: DynamoDBDocumentClient;

  // The SDK reads AWS_ENDPOINT_URL_DYNAMODB, which is how tests reach DynamoDB Local.
  constructor(
    private readonly table: string,
    client: DynamoDBClient = new DynamoDBClient({}),
    private readonly now: () => Date = () => new Date(),
    private readonly uuid: () => string = randomUUID,
  ) {
    this.doc = DynamoDBDocumentClient.from(client);
  }

  async list(sub: string): Promise<Note[]> {
    const out = await this.doc.send(
      new QueryCommand({
        TableName: this.table,
        KeyConditionExpression: 'pk = :pk',
        ExpressionAttributeValues: { ':pk': sub },
        ScanIndexForward: false, // newest first
        Limit: MAX_NOTES_PER_PAGE,
      }),
    );
    return (out.Items ?? []).map((item) => ({
      id: String(item.sk),
      text: String(item.text),
      createdAt: String(item.createdAt),
    }));
  }

  async create(sub: string, text: string): Promise<Note> {
    const at = this.now();
    const note: Note = {
      id: `${String(at.getTime()).padStart(13, '0')}-${this.uuid()}`,
      text,
      createdAt: at.toISOString(),
    };
    await this.doc.send(
      new PutCommand({
        TableName: this.table,
        Item: { pk: sub, sk: note.id, text: note.text, createdAt: note.createdAt },
        // A put never replaces an existing note, even if two IDs ever collided.
        ConditionExpression: 'attribute_not_exists(pk)',
      }),
    );
    return note;
  }

  /** Returns false when the caller has no note with that ID. */
  async delete(sub: string, id: string): Promise<boolean> {
    try {
      await this.doc.send(
        new DeleteCommand({
          TableName: this.table,
          Key: { pk: sub, sk: id },
          ConditionExpression: 'attribute_exists(pk)',
        }),
      );
      return true;
    } catch (err) {
      if (err instanceof ConditionalCheckFailedException) return false;
      throw err;
    }
  }
}
