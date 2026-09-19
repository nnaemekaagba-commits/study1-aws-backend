import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';

export type ResearchEvent = {
  kind: 'tool'; eventId: string; sessionId: string; timestamp: string;
  studentMessage: string; toolName: string; toolArguments: unknown;
  stateBefore: unknown; stateAfter: unknown; solverResult?: unknown;
  aiResponse: string; succeeded: boolean; error?: string;
} | {
  kind: 'fbd_tool'; eventId: string; sessionId: string; timestamp: string;
  studentMessage: string; toolName: string; toolArguments: unknown;
  stateBefore: unknown; stateAfter: unknown;
  aiResponse: string; succeeded: boolean; error?: string;
} | {
  kind: 'visualization'; eventId: string; sessionId: string; timestamp: string;
  action: 'front' | 'top' | 'right' | 'isometric' | 'reset' | 'free' | 'orbit' | 'fbd' |
    `fbd_given_${'loads' | 'dimensions' | 'angles' | 'labels'}_${'on' | 'off'}` |
    'structure_view' | 'fbd_view' | 'split_view' | 'fbd_enter' | 'fbd_exit' | 'fbd_select' | 'fbd_delete' | 'fbd_undo' | 'fbd_redo' | 'fbd_reset' | 'fbd_force_add' | 'fbd_moment_add' | 'fbd_dimension_add' | 'fbd_angle_add' | 'fbd_label_add' | 'fbd_label_move' | 'fbd_element_edit' | 'fbd_element_delete' | 'fbd_element_drag' | 'fbd_element_reposition';
  target?: { kind: 'body' | 'member' | 'joint'; id: string };
  force?: { id: string; at: { x: number; y: number }; angle: number; label?: string; magnitude?: number };
  moment?: { id: string; at: { x: number; y: number }; clockwise: boolean; label?: string; magnitude?: number };
  dimension?: { id: string; start: { x: number; y: number }; end: { x: number; y: number }; label: string };
  angle?: { id: string; vertex: { x: number; y: number }; from: { x: number; y: number };
    to: { x: number; y: number }; label: string };
  label?: { id: string; at: { x: number; y: number }; text: string;
    associatedWith?: { kind: 'force' | 'moment' | 'node' | 'member' | 'dimension' | 'angle'; id: string } };
  elementKind?: 'force' | 'moment' | 'dimension' | 'angle' | 'label';
  elementId?: string;
  before?: Record<string, unknown>;
  after?: Record<string, unknown> | null;
  dragTarget?: 'label' | 'application';
  fbdBefore?: Record<string, unknown>;
  fbdAfter?: Record<string, unknown>;
};

const nonempty = (value: unknown, max: number) =>
  typeof value === 'string' && value.trim().length > 0 && value.length <= max;
const structure = (value: unknown) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return ['nodes', 'members', 'supports', 'loads', 'dimensions'].every((key) => Array.isArray(row[key])) &&
    !!row.units && typeof row.units === 'object' && !Array.isArray(row.units);
};
export const fbdSnapshot = (value: unknown) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const state = value as Record<string, unknown>;
  const target = state.selectedTarget;
  return state.version === 1 && nonempty(state.sourceStructureKey, 128) &&
    (target === null || (!!target && typeof target === 'object' && !Array.isArray(target) &&
      ['body', 'member', 'joint'].includes((target as Record<string, unknown>).kind as string) &&
      nonempty((target as Record<string, unknown>).id, 128))) &&
    ['forces', 'moments', 'dimensions', 'angles', 'labels'].every((key) =>
      Array.isArray(state[key]) && (state[key] as unknown[]).every((item) =>
        !!item && typeof item === 'object' && !Array.isArray(item) &&
        nonempty((item as Record<string, unknown>).id, 128)));
};
const fbdPoint = (value: unknown): value is { x: number; y: number } => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const point = value as Record<string, unknown>;
  return typeof point.x === 'number' && Number.isFinite(point.x) &&
    typeof point.y === 'number' && Number.isFinite(point.y);
};
function validFbdElement(kind: string, id: string, value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  if (row.id !== id) return false;
  if (row.labelPosition !== undefined && (kind === 'label' || !fbdPoint(row.labelPosition))) return false;
  if (kind === 'force' || kind === 'moment') return fbdPoint(row.at) && nonempty(row.label, 80) &&
    (row.magnitude === undefined || (typeof row.magnitude === 'number' &&
      Number.isFinite(row.magnitude) && row.magnitude >= 0)) &&
    (kind === 'force' ? typeof row.angle === 'number' && Number.isFinite(row.angle) :
      typeof row.clockwise === 'boolean');
  if (kind === 'dimension') return fbdPoint(row.start) && fbdPoint(row.end) &&
    Math.hypot((row.end as { x: number; y: number }).x - (row.start as { x: number; y: number }).x,
      (row.end as { x: number; y: number }).y - (row.start as { x: number; y: number }).y) >= 1e-9 &&
    nonempty(row.label, 120);
  if (kind === 'angle') {
    if (!fbdPoint(row.vertex) || !fbdPoint(row.from) || !fbdPoint(row.to) || !nonempty(row.label, 120)) return false;
    const vertex = row.vertex as { x: number; y: number };
    const from = row.from as { x: number; y: number };
    const to = row.to as { x: number; y: number };
    const ax = from.x - vertex.x; const ay = from.y - vertex.y;
    const bx = to.x - vertex.x; const by = to.y - vertex.y;
    const length = Math.hypot(ax, ay) * Math.hypot(bx, by);
    return length >= 1e-18 && !(Math.abs(ax * by - ay * bx) / length < 1e-9 && ax * bx + ay * by > 0);
  }
  if (kind === 'label') {
    const association = row.associatedWith as Record<string, unknown> | undefined;
    return fbdPoint(row.at) && nonempty(row.text, 120) &&
      (association === undefined || (!!association &&
        ['force', 'moment', 'node', 'member', 'dimension', 'angle'].includes(association.kind as string) &&
        nonempty(association.id, 128)));
  }
  return false;
}

export function validateResearchEvent(input: unknown): ResearchEvent {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid research event.');
  const event = input as Record<string, unknown>;
  const serialized = JSON.stringify(event);
  if (!serialized || Buffer.byteLength(serialized, 'utf8') > 300_000 || !nonempty(event.eventId, 128) ||
    !nonempty(event.sessionId, 128) || !nonempty(event.timestamp, 40) ||
    Number.isNaN(Date.parse(event.timestamp as string))) throw new Error('Invalid research event metadata.');
  if (event.kind === 'visualization') {
    if (!['front', 'top', 'right', 'isometric', 'reset', 'free', 'orbit', 'fbd',
      ...['loads', 'dimensions', 'angles', 'labels'].flatMap((key) =>
        [`fbd_given_${key}_on`, `fbd_given_${key}_off`]),
      'structure_view', 'fbd_view', 'split_view',
      'fbd_enter', 'fbd_exit', 'fbd_select', 'fbd_delete', 'fbd_undo', 'fbd_redo', 'fbd_reset', 'fbd_force_add', 'fbd_moment_add', 'fbd_dimension_add', 'fbd_angle_add', 'fbd_label_add', 'fbd_label_move', 'fbd_element_edit', 'fbd_element_delete', 'fbd_element_drag', 'fbd_element_reposition']
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
    if (event.action === 'fbd_moment_add') {
      const moment = event.moment as Record<string, unknown> | undefined;
      const at = moment?.at as Record<string, unknown> | undefined;
      if (!moment || !nonempty(moment.id, 128) || !nonempty(moment.label, 80) ||
        !at || typeof at.x !== 'number' || !Number.isFinite(at.x) ||
        typeof at.y !== 'number' || !Number.isFinite(at.y) ||
        typeof moment.clockwise !== 'boolean' ||
        (moment.magnitude !== undefined && (typeof moment.magnitude !== 'number' ||
          !Number.isFinite(moment.magnitude) || moment.magnitude < 0))) throw new Error('Invalid FBD moment.');
    } else if (event.moment !== undefined) throw new Error('Invalid visualization moment.');
    if (event.action === 'fbd_dimension_add') {
      const dimension = event.dimension as Record<string, unknown> | undefined;
      const start = dimension?.start as Record<string, unknown> | undefined;
      const end = dimension?.end as Record<string, unknown> | undefined;
      const point = (value: Record<string, unknown> | undefined) => value &&
        typeof value.x === 'number' && Number.isFinite(value.x) &&
        typeof value.y === 'number' && Number.isFinite(value.y);
      if (!dimension || !nonempty(dimension.id, 128) || !nonempty(dimension.label, 120) ||
        !point(start) || !point(end) ||
        Math.hypot((end!.x as number) - (start!.x as number),
          (end!.y as number) - (start!.y as number)) < 1e-9) throw new Error('Invalid FBD dimension.');
    } else if (event.dimension !== undefined) throw new Error('Invalid visualization dimension.');
    if (event.action === 'fbd_angle_add') {
      const angle = event.angle as Record<string, unknown> | undefined;
      const point = (value: unknown): value is { x: number; y: number } => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
        const row = value as Record<string, unknown>;
        return typeof row.x === 'number' && Number.isFinite(row.x) &&
          typeof row.y === 'number' && Number.isFinite(row.y);
      };
      if (!angle || !nonempty(angle.id, 128) || !nonempty(angle.label, 120) ||
        !point(angle.vertex) || !point(angle.from) || !point(angle.to))
        throw new Error('Invalid FBD angle.');
      const vertex = angle.vertex as { x: number; y: number };
      const from = angle.from as { x: number; y: number };
      const to = angle.to as { x: number; y: number };
      const ax = from.x - vertex.x; const ay = from.y - vertex.y;
      const bx = to.x - vertex.x; const by = to.y - vertex.y;
      const length = Math.hypot(ax, ay) * Math.hypot(bx, by);
      if (length < 1e-18 || (Math.abs(ax * by - ay * bx) / length < 1e-9 && ax * bx + ay * by > 0))
        throw new Error('Invalid FBD angle.');
    } else if (event.angle !== undefined) throw new Error('Invalid visualization angle.');
    if (event.action === 'fbd_label_add' || event.action === 'fbd_label_move') {
      const label = event.label as Record<string, unknown> | undefined;
      const at = label?.at as Record<string, unknown> | undefined;
      const association = label?.associatedWith as Record<string, unknown> | undefined;
      if (!label || !nonempty(label.id, 128) || !nonempty(label.text, 120) ||
        !at || typeof at.x !== 'number' || !Number.isFinite(at.x) ||
        typeof at.y !== 'number' || !Number.isFinite(at.y) ||
        (association !== undefined && (!association ||
          !['force', 'moment', 'node', 'member', 'dimension', 'angle'].includes(association.kind as string) ||
          !nonempty(association.id, 128)))) throw new Error('Invalid FBD label.');
    } else if (event.label !== undefined) throw new Error('Invalid visualization label.');
    if (event.action === 'fbd_element_edit' || event.action === 'fbd_element_delete' ||
      event.action === 'fbd_element_drag' || event.action === 'fbd_element_reposition') {
      const kind = event.elementKind as string;
      const id = event.elementId as string;
      if (!nonempty(id, 128) || !validFbdElement(kind, id, event.before) ||
        (event.action === 'fbd_element_delete' ? event.after !== null : !validFbdElement(kind, id, event.after)) ||
        (event.action === 'fbd_element_drag' || event.action === 'fbd_element_reposition'
          ? !['label', 'application'].includes(event.dragTarget as string) ||
            (event.dragTarget === 'application' && kind !== 'force')
          : event.dragTarget !== undefined))
        throw new Error('Invalid FBD element change.');
    } else if (event.elementKind !== undefined || event.elementId !== undefined ||
      event.before !== undefined || event.after !== undefined || event.dragTarget !== undefined)
      throw new Error('Invalid visualization change.');
    const hasSelectionSnapshots = (event.action === 'fbd_select' || event.action === 'fbd_delete') &&
      (event.fbdBefore !== undefined || event.fbdAfter !== undefined);
    if (event.action === 'fbd_undo' || event.action === 'fbd_redo' || event.action === 'fbd_reset' ||
      hasSelectionSnapshots) {
      if (!fbdSnapshot(event.fbdBefore) || !fbdSnapshot(event.fbdAfter) ||
        JSON.stringify(event.fbdBefore) === JSON.stringify(event.fbdAfter))
        throw new Error('Invalid FBD history transition.');
      if (hasSelectionSnapshots) {
        const before = event.fbdBefore as Record<string, unknown>;
        const after = event.fbdAfter as Record<string, unknown>;
        if (before.sourceStructureKey !== after.sourceStructureKey ||
          JSON.stringify(after.selectedTarget) !== JSON.stringify(event.action === 'fbd_select' ? event.target : null) ||
          ['forces', 'moments', 'dimensions', 'angles', 'labels'].some((key) =>
            (after[key] as unknown[]).length > 0))
          throw new Error('Invalid FBD selection transition.');
      }
      if (event.action === 'fbd_reset') {
        const before = event.fbdBefore as Record<string, unknown>;
        const after = event.fbdAfter as Record<string, unknown>;
        const collections = ['forces', 'moments', 'dimensions', 'angles', 'labels'];
        if (!collections.some((key) => (before[key] as unknown[]).length > 0) ||
          !collections.every((key) => (after[key] as unknown[]).length === 0) ||
          before.sourceStructureKey !== after.sourceStructureKey ||
          JSON.stringify(before.selectedTarget) !== JSON.stringify(after.selectedTarget))
          throw new Error('Invalid FBD reset transition.');
      }
    } else if (event.fbdBefore !== undefined || event.fbdAfter !== undefined)
      throw new Error('Invalid visualization history.');
    return event as ResearchEvent;
  }
  if (event.kind === 'fbd_tool') {
    if (!nonempty(event.studentMessage, 20_000) || !nonempty(event.toolName, 128) ||
      !(event.toolName as string).startsWith('fbd_') ||
      typeof event.aiResponse !== 'string' || event.aiResponse.length > 30_000 ||
      typeof event.succeeded !== 'boolean' || event.toolArguments === undefined ||
      !fbdSnapshot(event.stateBefore) || !fbdSnapshot(event.stateAfter) ||
      (event.error !== undefined && typeof event.error !== 'string') ||
      (!event.succeeded && JSON.stringify(event.stateBefore) !== JSON.stringify(event.stateAfter)))
      throw new Error('Invalid FBD tool event.');
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
