/**
 * Login helper functions for Cypress tests
 * Handles optional HTTP basic auth and user login (app login)
 * 
 * Usage:
 *   cy.authLogin()
 *   cy.userLogin()
 *
 * Env:
 *   APP_ORIGIN or cypress.config baseUrl — default https://entwickler.de
 *   USE_BASIC_AUTH — set "true" only if the site is behind HTTP basic auth (then set AUTH_USERNAME / AUTH_PASSWORD)
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

function shouldUseBasicAuth() {
  const use = Cypress.env('USE_BASIC_AUTH')
  return use === true || use === 'true'
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
    const authUsername = Cypress.env('AUTH_USERNAME')
    const authPassword = Cypress.env('AUTH_PASSWORD')

    if (!authUsername || !authPassword) {
      throw new Error(
        'USE_BASIC_AUTH is enabled but AUTH_USERNAME and AUTH_PASSWORD are missing in cypress.env.json'
      )
    }

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
  const origin = getAppOrigin()
  const loginUrl = Cypress.env('LOGIN_URL') || `${origin}/login/`

  cy.visitWithAuth(loginUrl)
  cy.wait(3000)

  cy.dismissOverlays()
})

/**
 * Perform user login (app login) - the actual app login form
 */
Cypress.Commands.add('userLogin', () => {
  const userUsername = Cypress.env('USER_USERNAME')
  const userPassword = Cypress.env('USER_PASSWORD')

  if (!userUsername || !userPassword) {
    throw new Error('USER_USERNAME and USER_PASSWORD must be set in cypress.env.json')
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
