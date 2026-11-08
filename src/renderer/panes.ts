/**
 * Pane tree for split layouts inside a tab.
 * A node is either a terminal leaf or a split container.
 */
export type PaneNode =
  | { type: "leaf"; id: number }
  | { type: "split"; dir: "h" | "v"; children: PaneNode[] };

let nextPaneId = 1;
export const newPaneId = () => nextPaneId++;

export function findLeaf(node: PaneNode, id: number): boolean {
  if (node.type === "leaf") return node.id === id;
  return node.children.some((c) => findLeaf(c, id));
}

export function removeLeaf(node: PaneNode, id: number): PaneNode | null {
  if (node.type === "leaf") return node.id === id ? null : node;
  const kept = node.children
    .map((c) => removeLeaf(c, id))
    .filter((c): c is PaneNode => c !== null);
  if (kept.length === 0) return null;
  if (kept.length === 1) return kept[0];
  return { ...node, children: kept };
}

/** Split the leaf with `id` in direction `dir`; the new pane goes second. */
export function splitLeaf(node: PaneNode, id: number, dir: "h" | "v", newId: number): PaneNode {
  if (node.type === "leaf") {
    if (node.id !== id) return node;
    return { type: "split", dir, children: [node, { type: "leaf", id: newId }] };
  }
  return {
    ...node,
    children: node.children.map((c) => splitLeaf(c, id, dir, newId)),
  };
}

export function leafIds(node: PaneNode): number[] {
  if (node.type === "leaf") return [node.id];
  return node.children.flatMap(leafIds);
}

export function firstLeaf(node: PaneNode): number {
  if (node.type === "leaf") return node.id;
  return firstLeaf(node.children[0]);
}
