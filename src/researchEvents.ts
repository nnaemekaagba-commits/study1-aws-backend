import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';

type FBDResearchContext = {
  problemId: string; isolatedObject: { kind: 'body' | 'member' | 'joint'; id: string } | null;
  actionType: string; elementType: 'body' | 'joint' | 'member' | 'force' | 'moment' | 'dimension' | 'angle' | 'label' | null;
  elementId: string | null; stateBefore: unknown; stateAfter: unknown;
  inputModality: 'text' | 'audio' | null; relatedStudentChatMessage: string | null;
  sequence: number;
};

export type ResearchEvent = {
  kind: 'tool'; eventId: string; sessionId: string; timestamp: string;
  studentMessage: string; toolName: string; toolArguments: unknown;
  stateBefore: unknown; stateAfter: unknown; solverResult?: unknown;
  aiResponse: string; succeeded: boolean; error?: string;
  fbdResearch?: FBDResearchContext;
  } | {
  kind: 'fbd_tool'; eventId: string; sessionId: string; timestamp: string;
  studentMessage: string; toolName: string; toolArguments: unknown;
  stateBefore: unknown; stateAfter: unknown;
    aiResponse: string; succeeded: boolean; error?: string;
    fbdResearch?: FBDResearchContext;
  } | {
    kind: 'fbd_check'; eventId: string; sessionId: string; timestamp: string;
    studentMessage: string; fbdState: unknown; comparisonResult: unknown; feedback: string;
    fbdResearch?: FBDResearchContext;
  } | {
  kind: 'visualization'; eventId: string; sessionId: string; timestamp: string;
  action: 'front' | 'top' | 'right' | 'isometric' | 'reset' | 'free' | 'orbit' | 'fbd' |
    `fbd_given_${'loads' | 'dimensions' | 'angles' | 'labels'}_${'on' | 'off'}` |
    'structure_view' | 'fbd_view' | 'split_view' | 'fbd_enter' | 'fbd_exit' | 'fbd_select' | 'fbd_delete' | 'fbd_undo' | 'fbd_redo' | 'fbd_reset' | 'fbd_force_add' | 'fbd_moment_add' | 'fbd_dimension_add' | 'fbd_angle_add' | 'fbd_label_add' | 'fbd_label_move' | 'fbd_element_edit' | 'fbd_element_delete' | 'fbd_element_drag' | 'fbd_element_reposition' | 'fbd_blank_workspace' |
    `fbd_${'body' | 'joint' | 'member'}_${'add' | 'edit' | 'move' | 'delete'}`;
  target?: { kind: 'body' | 'member' | 'joint'; id: string };
  force?: { id: string; at: { x: number; y: number }; angle: number; label?: string; magnitude?: number };
  moment?: { id: string; at: { x: number; y: number }; clockwise: boolean; label?: string; magnitude?: number };
  dimension?: { id: string; start: { x: number; y: number }; end: { x: number; y: number }; label: string };
  angle?: { id: string; vertex: { x: number; y: number }; from: { x: number; y: number };
    to: { x: number; y: number }; label: string };
  label?: { id: string; at: { x: number; y: number }; text: string;
    associatedWith?: { kind: 'force' | 'moment' | 'node' | 'member' | 'dimension' | 'angle'; id: string } };
  elementKind?: 'body' | 'joint' | 'member' | 'force' | 'moment' | 'dimension' | 'angle' | 'label';
  elementId?: string;
  before?: Record<string, unknown>;
  after?: Record<string, unknown> | null;
  dragTarget?: 'label' | 'application';
  fbdBefore?: Record<string, unknown>;
  fbdAfter?: Record<string, unknown>;
  fbdResearch?: FBDResearchContext;
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
        nonempty((item as Record<string, unknown>).id, 128))) &&
    ['bodies', 'joints', 'members'].every((key) => state[key] === undefined ||
      (Array.isArray(state[key]) && (state[key] as unknown[]).every((item) =>
        !!item && typeof item === 'object' && !Array.isArray(item) &&
        nonempty((item as Record<string, unknown>).id, 128) &&
        validFbdElement(key === 'bodies' ? 'body' : key.slice(0, -1),
          (item as Record<string, unknown>).id as string, item))));
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
  if (kind === 'body') return fbdPoint(row.origin) &&
    typeof row.width === 'number' && Number.isFinite(row.width) && row.width > 0 &&
    typeof row.height === 'number' && Number.isFinite(row.height) && row.height > 0 &&
    (row.label === undefined || typeof row.label === 'string' && row.label.length <= 120);
  if (kind === 'joint') return fbdPoint(row.at) &&
    (row.label === undefined || typeof row.label === 'string' && row.label.length <= 120);
  if (kind === 'member') return fbdPoint(row.start) && fbdPoint(row.end) &&
    Math.hypot((row.end as { x: number; y: number }).x - (row.start as { x: number; y: number }).x,
      (row.end as { x: number; y: number }).y - (row.start as { x: number; y: number }).y) >= 1e-9 &&
    (row.label === undefined || typeof row.label === 'string' && row.label.length <= 120);
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

const fbdActions = new Set([
  'enter_fbd_mode', 'enter_blank_workspace', 'exit_fbd_mode', 'select_body', 'undo', 'redo', 'reset_fbd',
  'request_ai_help', 'request_fbd_check', 'view_change', 'show_given_information',
  ...['body', 'joint', 'member', 'force', 'moment', 'dimension', 'angle', 'label'].flatMap((kind) =>
    [`add_${kind}`, `edit_${kind}`, `move_${kind}`, `delete_${kind}`]),
]);
function validateFBDResearchContext(value: unknown): FBDResearchContext {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid FBD research context.');
  const row = value as Record<string, unknown>;
  const after = row.stateAfter as Record<string, unknown> | undefined;
  if (!fbdSnapshot(row.stateBefore) || !fbdSnapshot(after) ||
    !nonempty(row.problemId, 128) || row.problemId !== after?.sourceStructureKey ||
    JSON.stringify(row.isolatedObject) !== JSON.stringify(after?.selectedTarget) ||
    !fbdActions.has(row.actionType as string) ||
    !(row.elementType === null || ['body', 'joint', 'member', 'force', 'moment', 'dimension', 'angle', 'label'].includes(row.elementType as string)) ||
    !(row.elementId === null || nonempty(row.elementId, 128)) ||
    (row.elementType === null && row.elementId !== null) ||
    !(row.inputModality === null || row.inputModality === 'text' || row.inputModality === 'audio') ||
    !(row.relatedStudentChatMessage === null || nonempty(row.relatedStudentChatMessage, 20_000)) ||
    !Number.isSafeInteger(row.sequence) || (row.sequence as number) < 1)
    throw new Error('Invalid FBD research context.');
  return row as FBDResearchContext;
}

export function validateResearchEvent(input: unknown): ResearchEvent {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid research event.');
  const event = input as Record<string, unknown>;
  const serialized = JSON.stringify(event);
  if (!serialized || Buffer.byteLength(serialized, 'utf8') > 300_000 || !nonempty(event.eventId, 128) ||
    !nonempty(event.sessionId, 128) || !nonempty(event.timestamp, 40) ||
    Number.isNaN(Date.parse(event.timestamp as string))) throw new Error('Invalid research event metadata.');
  if (event.fbdResearch !== undefined) {
    const context = validateFBDResearchContext(event.fbdResearch);
    if (event.kind === 'fbd_tool' &&
      (JSON.stringify(context.stateBefore) !== JSON.stringify(event.stateBefore) ||
        JSON.stringify(context.stateAfter) !== JSON.stringify(event.stateAfter)))
      throw new Error('FBD tool research state mismatch.');
    if (event.kind === 'fbd_check' &&
      (context.actionType !== 'request_fbd_check' ||
        JSON.stringify(context.stateAfter) !== JSON.stringify(event.fbdState)))
      throw new Error('FBD check research state mismatch.');
    if (event.kind === 'visualization' && event.fbdBefore !== undefined &&
      (JSON.stringify(context.stateBefore) !== JSON.stringify(event.fbdBefore) ||
        JSON.stringify(context.stateAfter) !== JSON.stringify(event.fbdAfter)))
      throw new Error('FBD visualization research state mismatch.');
  }
  if (event.kind === 'fbd_check') {
    const comparison = event.comparisonResult as Record<string, unknown> | undefined;
    const checked = comparison?.checked as Record<string, unknown> | undefined;
    const issues = comparison?.issues;
    const limitations = comparison?.limitations;
    const kinds = ['missing_force', 'extra_force', 'incorrect_force_direction', 'missing_moment',
      'extra_moment', 'incorrect_moment_direction', 'incorrect_support_reaction',
      'omitted_applied_load', 'incorrect_given_magnitude', 'select_target', 'stale_structure'];
    if (!nonempty(event.studentMessage, 20_000) || !fbdSnapshot(event.fbdState) ||
      typeof event.feedback !== 'string' || !nonempty(event.feedback, 30_000) ||
      !comparison || typeof comparison !== 'object' || Array.isArray(comparison) ||
      !['no_discrepancies', 'needs_revision', 'limited'].includes(comparison.status as string) ||
      JSON.stringify(comparison.selectedTarget) !== JSON.stringify((event.fbdState as Record<string, unknown>).selectedTarget) ||
      !Array.isArray(issues) || issues.length > 100 || !issues.every((item) => {
        if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
        const issue = item as Record<string, unknown>;
        return kinds.includes(issue.kind as string) && nonempty(issue.description, 500) &&
          (issue.elementId === undefined || nonempty(issue.elementId, 128)) &&
          (issue.sourceId === undefined || nonempty(issue.sourceId, 128));
      }) || !Array.isArray(limitations) || limitations.length > 50 ||
      !limitations.every((item) => nonempty(item, 500)) ||
      !checked || typeof checked !== 'object' || Array.isArray(checked) ||
      !['appliedForces', 'appliedMoments', 'supportForceComponents', 'supportMoments'].every((key) =>
        Number.isSafeInteger(checked[key]) && (checked[key] as number) >= 0))
      throw new Error('Invalid FBD check event.');
    return event as ResearchEvent;
  }
  if (event.kind === 'visualization') {
    if (!['front', 'top', 'right', 'isometric', 'reset', 'free', 'orbit', 'fbd',
      ...['loads', 'dimensions', 'angles', 'labels'].flatMap((key) =>
        [`fbd_given_${key}_on`, `fbd_given_${key}_off`]),
      'structure_view', 'fbd_view', 'split_view',
      'fbd_enter', 'fbd_exit', 'fbd_select', 'fbd_delete', 'fbd_undo', 'fbd_redo', 'fbd_reset', 'fbd_force_add', 'fbd_moment_add', 'fbd_dimension_add', 'fbd_angle_add', 'fbd_label_add', 'fbd_label_move', 'fbd_element_edit', 'fbd_element_delete', 'fbd_element_drag', 'fbd_element_reposition', 'fbd_blank_workspace',
      ...['body', 'joint', 'member'].flatMap((kind) => ['add', 'edit', 'move', 'delete'].map((action) => `fbd_${kind}_${action}`))]
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
          ['bodies', 'joints', 'members', 'forces', 'moments', 'dimensions', 'angles', 'labels'].some((key) =>
            ((after[key] as unknown[] | undefined)?.length || 0) > 0))
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
      pk: `USER#${userId}`, sk: `ENGINEERING_EVENT#${validated.timestamp}#${validated.fbdResearch
        ? String(validated.fbdResearch.sequence).padStart(12, '0') + '#' : ''}${validated.eventId}`,
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
    const events: ResearchEvent[] = [];
    let cursor: Record<string, unknown> | undefined;
    do {
      const response = await client.send(new QueryCommand({ TableName: tableName,
        KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
        ExpressionAttributeValues: { ':pk': `USER#${userId}`, ':prefix': 'ENGINEERING_EVENT#' },
        ...(cursor ? { ExclusiveStartKey: cursor } : {}),
      }));
      events.push(...(response.Items || []).map((item) => item.event as ResearchEvent).filter(Boolean));
      cursor = response.LastEvaluatedKey;
    } while (cursor);
    return events;
  }
  return [...(memory.get(userId) || [])].sort((a, b) =>
    a.timestamp.localeCompare(b.timestamp) ||
    ((a.fbdResearch?.sequence || 0) - (b.fbdResearch?.sequence || 0)) ||
    a.eventId.localeCompare(b.eventId));
}
