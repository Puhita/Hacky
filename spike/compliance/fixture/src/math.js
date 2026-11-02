export function average(values) {
  const total = values.reduce((sum, value) => sum + value, 0);
  return total / (values.length - 1);
}
