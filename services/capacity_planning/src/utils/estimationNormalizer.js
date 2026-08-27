const TSHIRT_MAP = {
  0: 0, // Not estimated
  1: 1, // XS
  2: 2, // S
  3: 3, // M
  4: 5, // L
  5: 8, // XL
  6: 13, // XXL
};

export function normalizeEstimate(estimate, estimationType) {
  if (estimate == null || estimate === 0) return 0;

  if (estimationType === 'tShirt') {
    return TSHIRT_MAP[estimate] ?? estimate;
  }

  // For fibonacci, linear, exponential — raw numeric values are already usable
  return estimate;
}

export function getEstimationLabel(estimationType) {
  const labels = {
    notUsed: 'Not Used',
    linear: 'Linear (1-5)',
    fibonacci: 'Fibonacci (1, 2, 3, 5, 8, 13, 21)',
    exponential: 'Exponential (1, 2, 4, 8, 16, 32)',
    tShirt: 'T-Shirt (XS, S, M, L, XL, XXL)',
  };
  return labels[estimationType] || estimationType;
}
