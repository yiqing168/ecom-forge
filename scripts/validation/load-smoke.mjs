const equalsArgument = process.argv.find((value) => value.startsWith('--concurrent='));
const namedArgumentIndex = process.argv.indexOf('--concurrent');
const rawConcurrent =
  equalsArgument?.split('=')[1] ??
  (namedArgumentIndex >= 0 ? process.argv[namedArgumentIndex + 1] : undefined) ??
  '50';
const concurrent = Number(rawConcurrent);

if (!Number.isInteger(concurrent) || concurrent < 1) {
  throw new Error('--concurrent must be a positive integer');
}

console.log(`Load-test entrypoint ready (concurrent=${concurrent}). Assertions are added in S15.`);
