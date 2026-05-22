/**
 * Cypress runs specs in the browser; `process.env.CYPRESS_*` is usually empty in the bundle.
 * `cypress.config.js` forwards `CYPRESS_PERF_*` into `Cypress.env('PERF_*')` for reliable reads.
 */

function readPerfEnv(key) {
  if (typeof Cypress !== 'undefined' && typeof Cypress.env === 'function') {
    const v = Cypress.env(key)
    if (v !== undefined && v !== null && String(v).trim() !== '') {
      return String(v).trim()
    }
  }
  try {
    if (typeof process !== 'undefined' && process.env) {
      const p = process.env[`CYPRESS_${key}`]
      if (p !== undefined && p !== null && String(p).trim() !== '') {
        return String(p).trim()
      }
    }
  } catch (_) {
    // ignore
  }
  return ''
}

function perfEnvFlag(key) {
  if (typeof Cypress !== 'undefined' && typeof Cypress.env === 'function') {
    const v = Cypress.env(key)
    if (v === true || v === 1) return true
  }
  const s = readPerfEnv(key)
  return s === 'true' || s === '1'
}

module.exports = { readPerfEnv, perfEnvFlag }
