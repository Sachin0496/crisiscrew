export type Vector = Float32Array;

export function dot(a: Vector, b: Vector): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i]! * b[i]!;
  return sum;
}

export function norm(a: Vector): number {
  return Math.sqrt(dot(a, a));
}

/** Cosine similarity; 0 when either vector has no length. */
export function cosine(a: Vector, b: Vector): number {
  const denominator = norm(a) * norm(b);
  return denominator === 0 ? 0 : dot(a, b) / denominator;
}

export function meanVector(vectors: readonly Vector[]): Vector {
  const first = vectors[0];
  if (!first) throw new Error("meanVector needs at least one vector");
  const mean = new Float32Array(first.length);
  for (const v of vectors) for (let i = 0; i < mean.length; i++) mean[i]! += v[i]!;
  for (let i = 0; i < mean.length; i++) mean[i]! /= vectors.length;
  return mean;
}
