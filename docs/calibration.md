# Calibration: choosing the model and the similarity

CrisisCrew claims one inference above all: complaints worded differently ("my checkout keeps loading forever", "UPI isn't working", "card rejected on checkout") are recognised as the same failure. This page records how the model and similarity were chosen, using the scenario data in `scenarios/`, before any threshold was fixed.

Run on 2026-09-22 with the scenario texts as they are in the repo. To reproduce it, warm the models listed below and run `pnpm --filter @crisiscrew/server exec tsx src/cli/calibrate.ts <model>`.

## The problem with plain sentence embeddings

The first version compared tickets by the cosine similarity of their sentence embeddings alone. With every candidate model, the hero incident **did not fire**:
- Short complaints about the same failure scored only about 0.44 similarity on average, and as low as 0.20 for some pairs.
- The cohesion gate needs 0.55.

The failure-versus-question check was also noisy. "How do I apply a coupon code…?" scored as a failure report.

## Two changes

1. **Hybrid similarity.** Similarity = 0.5 × *meaning* + 0.5 × *product area*.
   - *Meaning* is the cosine of the two sentence embeddings.
   - *Product area* is the cosine of the two tickets' area profiles: a softmax (temperature 0.03) over how close each ticket is to the prototype sentences for checkout and payments, login, delivery, refunds and app performance.
   - The area is itself inferred from meaning, so there are no keyword lists. A ticket far from every area gets an empty profile and is matched on meaning alone.
2. **Question form.** A ticket phrased as a question has 0.3 subtracted from its failure score. That covers an ending "?", an opening "how/what/where…", or an opening "can/is/do…" but not "can't". It's a soft penalty, so "Why does my payment keep failing?" still counts as a failure.

Both weights live in `config/policy.json` (`semanticWeight`, `surfaceTemperature`, `questionPenalty`).

## Model comparison

The labels are hand-assigned:
- **Positive pairs:** two tickets from the same incident (the hero's 8 complaints, the UPI outage's 6).
- **Negative pairs:**
  - an incident ticket paired with an unrelated ticket from the same scenario
  - pairs within the scattered-failures scenario
  - the two-card-complaints pair

AUC is the chance that a random positive pair scores above a random negative pair.

| Model | Size (q8) | Plain cosine AUC | Hybrid AUC | Hero cohesion (hybrid) | UPI cohesion (hybrid) | Unrelated pairs, mean (hybrid) |
|---|---|---|---|---|---|---|
| **Xenova/all-MiniLM-L6-v2** | 23 MB | 0.94 | **1.00** | 0.71 | 0.76 | 0.11 |
| Xenova/bge-small-en-v1.5 | 34 MB | 0.93 | 0.98 | 0.82 | 0.79 | 0.36 |
| Xenova/gte-small | 34 MB | 0.93 | 0.98 | 0.90 | 0.88 | 0.58 |
| Xenova/all-mpnet-base-v2 | 110 MB | 0.90 | 0.97 | 0.68 | 0.76 | 0.19 |
| Xenova/paraphrase-multilingual-MiniLM-L12-v2 | 118 MB | 0.88 | 0.95 | 0.59 | 0.46 | 0.12 |

**Chosen: all-MiniLM-L6-v2 with the hybrid similarity.**
- It separates the labeled pairs completely.
- It keeps unrelated pairs far below the thresholds (0.11 on average).
- It's the smallest and fastest model, which matters on the demo MacBook Air.
- The larger models score everything higher, including unrelated pairs, so they separate less cleanly.
- The multilingual model misplaced two UPI complaints and "my checkout keeps loading forever" outside checkout. It stays the candidate for Hindi and Hinglish tickets, together with the Sarvam translation stretch goal.

## Scenario outcomes with the chosen setup

These are locked in by `apps/server/src/detection.test.ts`.

| Scenario | Expected | Result |
|---|---|---|
| checkout-v4.21.7 (hero) | incident | fires on the 4th complaint (cohesion 0.65); the 5th and the 3 later complaints join, making 8 linked. The background tickets stay out |
| upi-provider-outage | incident | fires on the 4th UPI complaint (cohesion 0.76); 2 more join |
| lookalike-checkout-questions | no incident | every question is classified as a question; refused on failure share and burst |
| scattered-failures | no incident | the only similar pair is two delivery complaints; refused on size |
| two-card-complaints | no incident | similarity 0.26; refused on size |
| quiet-day | no incident | two hours of normal traffic; nothing fires |

## Honest limits

- These are hand-written scenarios, not production traffic. The eval ([eval.md](eval.md)) widens them with paraphrase pools and a held-out split, but it's still synthetic.
- The prototype sentences are domain knowledge for an e-commerce support desk. A different business would edit `packages/core/src/correlation/prototypes.ts`.
- The thresholds are the design defaults. The hybrid similarity is what cleared them, and nothing was tuned to make a particular scenario pass.
