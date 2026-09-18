import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';

export type ResearchEvent = {
  kind: 'tool'; eventId: string; sessionId: string; timestamp: string;
  studentMessage: string; toolName: string; toolArguments: unknown;
  stateBefore: unknown; stateAfter: unknown; solverResult?: unknown;
  aiResponse: string; succeeded: boolean; error?: string;
} | {
  kind: 'visualization'; eventId: string; sessionId: string; timestamp: string;
  action: 'front' | 'top' | 'right' | 'isometric' | 'reset' | 'free' | 'orbit' | 'fbd' |
    'fbd_enter' | 'fbd_exit' | 'fbd_select' | 'fbd_delete' | 'fbd_undo' | 'fbd_redo' | 'fbd_reset' | 'fbd_force_add';
  target?: { kind: 'body' | 'member' | 'joint'; id: string };
  force?: { id: string; at: { x: number; y: number }; angle: number; label?: string; magnitude?: number };
};

const nonempty = (value: unknown, max: number) =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= max;
const structure = (value: unknown) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return ['nodes', 'members', 'supports', 'loads', 'dimensions'].every((key) => Array.isArray(row[key])) &&
    !!row.units && typeof row.units === 'object' && !Array.isArray(row.units);
};

export function validateResearchEvent(input: unknown): ResearchEvent {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid research event.');
  const event = input as Record<string, unknown>;
  const serialized = JSON.stringify(event);
  if (!serialized || Buffer.byteLength(serialized, 'utf8') > 300_000 || !nonempty(event.eventId, 128) ||
    !nonempty(event.sessionId, 128) || !nonempty(event.timestamp, 40) ||
    Number.isNaN(Date.parse(event.timestamp as string))) throw new Error('Invalid research event metadata.');
  if (event.kind === 'visualization') {
    if (!['front', 'top', 'right', 'isometric', 'reset', 'free', 'orbit', 'fbd',
      'fbd_enter', 'fbd_exit', 'fbd_select', 'fbd_delete', 'fbd_undo', 'fbd_redo', 'fbd_reset', 'fbd_force_add']
      .includes(event.action as string)) {
      throw new Error('Invalid visualization action.');
    }
    if (event.action === 'fbd_select') {
      const target = event.target as Record<string, unknown> | undefined;
      if (!target || !['body', 'member', 'joint'].includes(target.kind as string) ||
        !nonempty(target.id, 128)) throw new Error('Invalid FBD selection.');
    } else if (event.target !== undefined) throw new Error('Invalid visualization target.');
    if (event.action === 'fbd_force_add') {
      const force = event.force as Record<string, unknown> | undefined;
      const at = force?.at as Record<string, unknown> | undefined;
      if (!force || !nonempty(force.id, 128) || !nonempty(force.label, 80) ||
        !at || typeof at.x !== 'number' || !Number.isFinite(at.x) ||
        typeof at.y !== 'number' || !Number.isFinite(at.y) ||
        typeof force.angle !== 'number' || !Number.isFinite(force.angle) ||
        (force.magnitude !== undefined && (typeof force.magnitude !== 'number' ||
          !Number.isFinite(force.magnitude) || force.magnitude < 0))) throw new Error('Invalid FBD force.');
    } else if (event.force !== undefined) throw new Error('Invalid visualization force.');
    return event as ResearchEvent;
  }
  if (event.kind !== 'tool' || !nonempty(event.studentMessage, 20_000) ||
    !nonempty(event.toolName, 128) || typeof event.aiResponse !== 'string' ||
    event.aiResponse.length > 30_000 || typeof event.succeeded !== 'boolean' ||
    !structure(event.stateBefore) || !structure(event.stateAfter) ||
    event.toolArguments === undefined ||
    (event.error !== undefined && typeof event.error !== 'string')) {
    throw new Error('Invalid engineering tool event.');
  }
  return event as ResearchEvent;
}

const tableName = process.env.MESSAGES_TABLE;
const client = tableName ? DynamoDBDocumentClient.from(new DynamoDBClient({})) : null;
const memory = new Map<string, ResearchEvent[]>();

export async function saveResearchEvent(userId: string, event: ResearchEvent): Promise<void> {
  if (!nonempty(userId, 128)) throw new Error('Invalid research user.');
  const validated = validateResearchEvent(event);
  if (client && tableName) {
    await client.send(new PutCommand({ TableName: tableName, Item: {
      pk: `USER#${userId}`, sk: `ENGINEERING_EVENT#${validated.timestamp}#${validated.eventId}`,
      event: validated, timestamp: validated.timestamp,
    } }));
  } else {
    const events = memory.get(userId) || [];
    memory.set(userId, [...events.filter((item) => item.eventId !== validated.eventId), validated]);
  }
}

export async function listResearchEvents(userId: string): Promise<ResearchEvent[]> {
  if (!nonempty(userId, 128)) throw new Error('Invalid research user.');
  if (client && tableName) {
    const response = await client.send(new QueryCommand({ TableName: tableName,
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
      ExpressionAttributeValues: { ':pk': `USER#${userId}`, ':prefix': 'ENGINEERING_EVENT#' },
    }));
    return (response.Items || []).map((item) => item.event as ResearchEvent).filter(Boolean);
  }
  return [...(memory.get(userId) || [])].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}
