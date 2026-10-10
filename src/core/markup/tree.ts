import type { PairedNode } from '@rohal12/spindle/tooling';

/** Every node of a paired tree, depth first in source order (branches' children included). */
export function* walkNodes(nodes: readonly PairedNode[]): Generator<PairedNode> {
  for (const node of nodes) {
    yield node;
    if (!node.body) continue;
    yield* walkNodes(node.body.children);
    for (const branch of node.body.branches) yield* walkNodes(branch.children);
  }
}
