// The planner: turns a user-facing `Action` into a verified `Plan`, or a rejection with a
// stable, user-facing reason. Dispatches to the per-action-kind planning modules; also exposes
// `childOptions`, the UI-facing "what can be created under this node" listing. No Obsidian
// imports.

import { ruleBetween } from './derive.js';
import { planCreate } from './plan-create.js';
import type { Action, PlanEnv, PlanResult } from './plan-types.js';
import type { EdgeRule, Schema } from './schema.js';
import type { Snapshot } from './snapshot.js';
import type { Structure } from './structure.js';

export function planAction(
  schema: Schema,
  snapshot: Snapshot,
  action: Action,
  env: PlanEnv,
): PlanResult {
  switch (action.kind) {
    case 'create':
      return planCreate(schema, snapshot, action, env);
    case 'move':
    case 'retype':
      return { ok: false, reason: 'Not supported yet' };
  }
}

function levelOf(schema: Schema, typeName: string): number {
  return schema.typeByName.get(typeName)?.level ?? Number.MAX_SAFE_INTEGER;
}

function typedChildOptions(
  schema: Schema,
  typeName: string,
): ReadonlyArray<{ type: string; rule: EdgeRule }> {
  const typeDef = schema.typeByName.get(typeName);
  if (typeDef === undefined) {
    return [];
  }
  return Array.from(typeDef.children, ([type, rule]) => ({ type, rule })).sort(
    (a, b) => levelOf(schema, a.type) - levelOf(schema, b.type),
  );
}

function untypedChildOptions(schema: Schema): ReadonlyArray<{ type: string; rule: EdgeRule }> {
  const ordered = [...schema.types].sort((a, b) => a.level - b.level);
  const results: Array<{ type: string; rule: EdgeRule }> = [];
  for (const type of ordered) {
    const rule = ruleBetween(schema, null, type.name);
    if (rule !== null) {
      results.push({ type: type.name, rule });
    }
  }
  return results;
}

export function childOptions(
  schema: Schema,
  structure: Structure,
  parent: string,
): ReadonlyArray<{ type: string; rule: EdgeRule }> {
  const node = structure.nodes.get(parent);
  if (node === undefined) {
    return [];
  }
  return node.type === null ? untypedChildOptions(schema) : typedChildOptions(schema, node.type);
}
