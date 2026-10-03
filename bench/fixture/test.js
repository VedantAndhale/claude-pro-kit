// A noisy test runner: hundreds of passing cases and one real failure, the
// way a large suite's output looks.

const { add, subtract, multiply, average, clamp } = require('./src/math')

let passed = 0
let failed = 0

const check = (name, actual, expected) => {
  if (actual === expected) {
    passed += 1
    console.log(`  ✓ ${name} (${(Math.abs(Math.sin(passed)) * 3).toFixed(2)}ms)`)
  } else {
    failed += 1
    console.log(`  ✗ ${name}`)
    console.log(`    AssertionError: expected ${expected}, received ${actual}`)
    console.log(`      at test.js (${name})`)
  }
}

console.log('math suite')
for (let i = 0; i < 200; i++) check(`add(${i}, ${i * 2})`, add(i, i * 2), i * 3)
for (let i = 0; i < 200; i++) check(`subtract(${i * 3}, ${i})`, subtract(i * 3, i), i * 2)
for (let i = 0; i < 200; i++) check(`multiply(${i}, 3)`, multiply(i, 3), i * 3)
check('average([2, 4, 6, 8])', average([2, 4, 6, 8]), 5)
for (let i = 0; i < 200; i++) check(`clamp(${i}, 50, 150)`, clamp(i, 50, 150), Math.min(Math.max(i, 50), 150))

console.log('')
console.log(`${passed} passed, ${failed} failed`)
process.exit(failed === 0 ? 0 : 1)
