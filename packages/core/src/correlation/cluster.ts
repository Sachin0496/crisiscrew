export type Similarity = (a: string, b: string) => number;

/** Connected components of the graph whose edges join pairs at or above the threshold (union-find). */
export function clusterComponents(ids: readonly string[], similarity: Similarity, threshold: number): string[][] {
  const parent = new Map(ids.map((id) => [id, id]));
  const find = (id: string): string => {
    let root = id;
    while (parent.get(root) !== root) root = parent.get(root)!;
    parent.set(id, root);
    return root;
  };

  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const a = ids[i]!;
      const b = ids[j]!;
      if (similarity(a, b) >= threshold) parent.set(find(a), find(b));
    }
  }

  const groups = new Map<string, string[]>();
  for (const id of ids) {
    const root = find(id);
    groups.set(root, [...(groups.get(root) ?? []), id]);
  }
  return [...groups.values()];
}

/** Mean similarity over every pair; exposes chains that union-find alone would merge. */
export function meanPairwiseSimilarity(ids: readonly string[], similarity: Similarity): number {
  if (ids.length < 2) return 0;
  let sum = 0;
  let pairs = 0;
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      sum += similarity(ids[i]!, ids[j]!);
      pairs += 1;
    }
  }
  return sum / pairs;
}
