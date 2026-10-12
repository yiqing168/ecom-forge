import type { CandidateNode } from './types.js';

export type DagResult =
  { ok: true; nodes: CandidateNode[] } | { ok: false; candidateKey?: string; ruleId: string };

export function stableTopologicalSort(nodes: readonly CandidateNode[]): DagResult {
  const byKey = new Map(nodes.map((node) => [node.candidate_key, node]));
  const indegree = new Map(nodes.map((node) => [node.candidate_key, 0]));
  const dependants = new Map(nodes.map((node) => [node.candidate_key, [] as string[]]));

  for (const node of nodes) {
    for (const dependency of node.depends_on) {
      if (dependency === node.candidate_key) {
        return { ok: false, candidateKey: node.candidate_key, ruleId: 'dag_self_reference' };
      }
      if (!byKey.has(dependency)) {
        return { ok: false, candidateKey: node.candidate_key, ruleId: 'dag_dependency_missing' };
      }
      indegree.set(node.candidate_key, (indegree.get(node.candidate_key) ?? 0) + 1);
      dependants.get(dependency)?.push(node.candidate_key);
    }
  }

  const depth = new Map<string, number>();
  const ready = [...nodes]
    .filter((node) => indegree.get(node.candidate_key) === 0)
    .map((node) => node.candidate_key)
    .sort();
  for (const key of ready) depth.set(key, 0);
  const result: CandidateNode[] = [];

  while (ready.length > 0) {
    ready.sort((left, right) => {
      const depthDifference = (depth.get(left) ?? 0) - (depth.get(right) ?? 0);
      return depthDifference || left.localeCompare(right);
    });
    const key = ready.shift()!;
    const node = byKey.get(key)!;
    result.push(node);
    for (const dependant of dependants.get(key) ?? []) {
      const remaining = (indegree.get(dependant) ?? 0) - 1;
      indegree.set(dependant, remaining);
      depth.set(dependant, Math.max(depth.get(dependant) ?? 0, (depth.get(key) ?? 0) + 1));
      if (remaining === 0) ready.push(dependant);
    }
  }

  if (result.length !== nodes.length) return { ok: false, ruleId: 'dag_cycle' };
  return { ok: true, nodes: result };
}
