function logFactorial(n: number): number {
  let sum = 0;
  for (let k = 2; k <= n; k++) sum += Math.log(k);
  return sum;
}

/**
 * P(N >= n) for N ~ Poisson(mu).
 *
 * When n is above the mean, the upper tail is summed directly so tiny
 * probabilities keep their precision (1 - CDF would round them to 0).
 */
export function poissonTail(n: number, mu: number): number {
  if (n <= 0) return 1;
  if (mu <= 0) return 0;

  if (n > mu) {
    let term = Math.exp(-mu + n * Math.log(mu) - logFactorial(n));
    let sum = 0;
    for (let k = n; k < n + 1000; k++) {
      sum += term;
      term *= mu / (k + 1);
      if (term < sum * 1e-17) break;
    }
    return Math.min(1, sum);
  }

  let term = Math.exp(-mu);
  let below = 0;
  for (let k = 0; k < n; k++) {
    below += term;
    term *= mu / (k + 1);
  }
  return Math.max(0, 1 - below);
}
