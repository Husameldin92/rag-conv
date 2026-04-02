/**
 * Login helper functions for Cypress tests
 * 1) Optional HTTP Basic Auth on cy.visit (browser auth dialog)
 * 2) App login (#username / #password)
 *
 * Usage:
 *   cy.authLogin()
 *   cy.userLogin()
 *
 * Env:
 *   APP_ORIGIN / baseUrl — production or staging (e.g. https://staging.entwickler.de)
 *   Production app user: USER_USERNAME, USER_PASSWORD
 *   Staging app user (when origin is staging): STAGING_USER_USERNAME, STAGING_USER_PASSWORD (falls back to USER_* if unset)
 *   Basic auth (production): USE_BASIC_AUTH + AUTH_USERNAME + AUTH_PASSWORD
 *   Staging (staging.entwickler.de only — use test:staging-synthesis):
 *     Every cy.visit uses HTTP Basic Auth (same as cy.visit(url, { auth: { username, password } }) on /login/).
 *     Set STAGING_AUTH_USERNAME + STAGING_AUTH_PASSWORD in cypress.env.json (not used on production).
 *     App form login: STAGING_USER_* or USER_*.
 */

// Ignore uncaught exceptions from the website
Cypress.on('uncaught:exception', (err, runnable) => {
  return false;
});

function getAppOrigin() {
  const fromEnv = Cypress.env('APP_ORIGIN')
  const fromConfig = Cypress.config('baseUrl')
  const fallback = 'https://entwickler.de'
  const raw = fromEnv || fromConfig || fallback
  return String(raw).replace(/\/$/, '')
}

function isStagingOrigin() {
  return getAppOrigin().includes('staging.entwickler')
}

/** Login page URL — on staging, never reuse production LOGIN_URL from env by mistake. */
function getLoginUrl() {
  const origin = getAppOrigin()
  if (isStagingOrigin()) {
    const explicitStaging = Cypress.env('STAGING_LOGIN_URL')
    if (explicitStaging) return String(explicitStaging).trim()
    const loginUrl = Cypress.env('LOGIN_URL')
    if (loginUrl && String(loginUrl).includes('staging.entwickler')) {
      return String(loginUrl).trim()
    }
    return `${origin}/login/`
  }
  return String(Cypress.env('LOGIN_URL') || `${origin}/login/`).trim()
}

function shouldUseBasicAuth() {
  if (isStagingOrigin()) {
    // Staging always uses HTTP Basic Auth on cy.visit (same as the old visitWithAuth + /login/ flow).
    return true
  }
  const use = Cypress.env('USE_BASIC_AUTH')
  return use === true || use === 'true'
}

function getBasicAuthCredentials() {
  if (isStagingOrigin()) {
    const su = Cypress.env('STAGING_AUTH_USERNAME')
    const sp = Cypress.env('STAGING_AUTH_PASSWORD')
    if (su && sp) {
      return { username: su, password: sp }
    }
    throw new Error(
      'Staging requires HTTP Basic Auth: set STAGING_AUTH_USERNAME and STAGING_AUTH_PASSWORD in cypress.env.json (project root).'
    )
  }
  const u = Cypress.env('AUTH_USERNAME')
  const p = Cypress.env('AUTH_PASSWORD')
  if (u && p) {
    return { username: u, password: p }
  }
  throw new Error(
    'USE_BASIC_AUTH is enabled: set AUTH_USERNAME and AUTH_PASSWORD in cypress.env.json.'
  )
}

/** App form credentials (#username / #password) — staging-specific when set */
function getAppUserCredentials() {
  if (isStagingOrigin()) {
    const u = Cypress.env('STAGING_USER_USERNAME')
    const p = Cypress.env('STAGING_USER_PASSWORD')
    if (u && p) {
      return { username: u, password: p }
    }
  }
  const u = Cypress.env('USER_USERNAME')
  const p = Cypress.env('USER_PASSWORD')
  if (!u || !p) {
    throw new Error(
      'Set USER_USERNAME and USER_PASSWORD in cypress.env.json (and STAGING_USER_USERNAME / STAGING_USER_PASSWORD when using staging.entwickler.de)'
    )
  }
  return { username: u, password: p }
}

/**
 * Visit a URL with optional HTTP Basic Auth.
 * Custom commands must return the cy chain so Cypress can chain / await correctly.
 */
Cypress.Commands.add('visitWithAuth', (url) => {
  const target = typeof url === 'string' ? url.trim() : ''
  if (!target) {
    throw new Error(
      'visitWithAuth: url is missing or invalid. Set LOGIN_URL and APP_ORIGIN in cypress.env.json (project root).'
    )
  }

  const visitOpts = { timeout: 90000 }
  // If the server returns a non-2xx status you still need to load (e.g. edge CDN), set in cypress.env.json:
  // "VISIT_IGNORE_STATUS_CODE": "true"
  if (Cypress.env('VISIT_IGNORE_STATUS_CODE') === true || Cypress.env('VISIT_IGNORE_STATUS_CODE') === 'true') {
    visitOpts.failOnStatusCode = false
  }

  if (shouldUseBasicAuth()) {
    const { username: authUsername, password: authPassword } = getBasicAuthCredentials()

    return cy.visit(target, {
      ...visitOpts,
      auth: {
        username: authUsername,
        password: authPassword
      }
    })
  }

  return cy.visit(target, visitOpts)
})

/**
 * Perform auth login: visit login page (with optional HTTP Basic Auth)
 */
Cypress.Commands.add('authLogin', () => {
  const loginUrl = getLoginUrl()

  if (isStagingOrigin()) {
    cy.log(`Staging: visit login with HTTP Basic Auth → ${loginUrl}`)
  }

  cy.visitWithAuth(loginUrl)
  cy.wait(3000)

  cy.dismissOverlays()
})

/**
 * Perform user login (app login) - the actual app login form
 */
Cypress.Commands.add('userLogin', () => {
  const { username: userUsername, password: userPassword } = getAppUserCredentials()

  if (isStagingOrigin()) {
    cy.log('Using staging app login credentials (STAGING_USER_* or fallback USER_*)')
  }

  // Check if already logged in (on intelligence page)
  cy.url().then((currentUrl) => {
    if (currentUrl.includes('/reader/intelligence')) {
      cy.log('Already logged in, skipping login')
      // Just ensure we're on the intelligence page
      cy.url({ timeout: 5000 }).should('include', '/reader/intelligence')
      return
    }
    
    // Check if login form is present
    cy.get('body').then(($body) => {
      const hasLoginForm = $body.find('#username').length > 0
      
      if (!hasLoginForm && !currentUrl.includes('/login')) {
        cy.log('Already logged in, navigating to intelligence page')
        cy.visitWithAuth(`${getAppOrigin()}/reader/intelligence`)
        cy.url({ timeout: 15000 }).should('include', '/reader/intelligence')
        return
      }
      
      // Need to login
      cy.log('Performing user login (app login)')
      
      cy.get('#username', { timeout: 10000 }).type(userUsername)
      cy.get('#password').type(userPassword)
      cy.get(':nth-child(5) > .woocommerce-Button').click()

      // Handle case where login might request password again
      cy.get('body').then(($body) => {
        if ($body.find('#password:visible').length > 0) {
          cy.get('#password').type(userPassword)
          cy.get(':nth-child(5) > .woocommerce-Button').click()
        }
      })
      
      // Wait for login to complete
      cy.url({ timeout: 10000 }).should('not.include', '/login')
    })
  })
  
  // Navigate to the intelligence page after login (or if already there, just verify)
  cy.url().then((currentUrl) => {
    if (!currentUrl.includes('/reader/intelligence')) {
      cy.visitWithAuth(`${getAppOrigin()}/reader/intelligence`)
    }
  })
  
  // Wait for the intelligence page to fully load
  cy.url({ timeout: 15000 }).should('include', '/reader/intelligence')
  
  // Wait for the composer component to be present
  cy.get('readerapp-ai-search-composer', { timeout: 15000 })
    .should('exist')
    .should('be.visible')

  cy.dismissOverlays()

  // Optional: Wait for a specific element that indicates successful login
  // cy.get('[data-testid="user-menu"], .user-profile, .dashboard').should('be.visible')
})
