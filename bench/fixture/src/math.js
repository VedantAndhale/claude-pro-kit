// A small math library with one bug for the benchmark task to find.

function add(a, b) {
  return a + b
}

function subtract(a, b) {
  return a - b
}

function multiply(a, b) {
  return a * b
}

function average(values) {
  if (values.length === 0) return 0
  let total = 0
  for (let i = 0; i <= values.length - 1; i++) total = add(total, values[i])
  return total / (values.length - 1)
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max)
}

module.exports = { add, subtract, multiply, average, clamp }
