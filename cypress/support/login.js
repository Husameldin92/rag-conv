/**
 * Login helper functions for Cypress tests
 * Handles both auth login (staging auth wall) and user login (app login)
 * 
 * Usage:
 *   cy.authLogin()
 *   cy.userLogin()
 */

// Ignore uncaught exceptions from the website
Cypress.on('uncaught:exception', (err, runnable) => {
  return false;
});

/**
 * Visit a URL with HTTP Basic Auth (for staging auth wall)
 */
Cypress.Commands.add('visitWithAuth', (url) => {
  const authUsername = Cypress.env('AUTH_USERNAME')
  const authPassword = Cypress.env('AUTH_PASSWORD')

  if (!authUsername || !authPassword) {
    throw new Error('AUTH_USERNAME and AUTH_PASSWORD must be set in cypress.env.json')
  }

  cy.visit(url, {
    auth: {
      username: authUsername,
      password: authPassword
    }
  })
})

/**
 * Perform auth login (staging auth wall) using HTTP Basic Auth
 */
Cypress.Commands.add('authLogin', () => {
  const loginUrl = Cypress.env('LOGIN_URL') || 'https://staging.entwickler.de/login/'
  
  // Visit login page with basic auth
  cy.visitWithAuth(loginUrl)
  cy.wait(3000)
  
  // Handle cookie consent
  cy.get('body').then(($body) => {
    if ($body.find(':contains("Alle akzeptieren")').length > 0) {
      cy.contains('Alle akzeptieren', { timeout: 10000 }).click()
    }
  })
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
        cy.visitWithAuth('https://staging.entwickler.de/reader/intelligence')
        cy.url({ timeout: 15000 }).should('include', '/reader/intelligence')
        return
      }
      
      // Need to login
      cy.log('Performing user login (app login)')
      
      cy.get('#username', { timeout: 10000 }).type(userUsername)
      cy.get('#password').type(userPassword)
      cy.get(':nth-child(5) > .woocommerce-Button').click()

      // Handle case where staging might request password again
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
      cy.visitWithAuth('https://staging.entwickler.de/reader/intelligence')
    }
  })
  
  // Wait for the intelligence page to fully load
  cy.url({ timeout: 15000 }).should('include', '/reader/intelligence')
  
  // Wait for the composer component to be present
  cy.get('readerapp-ai-search-composer', { timeout: 15000 })
    .should('exist')
    .should('be.visible')
  
  // Optional: Wait for a specific element that indicates successful login
  // cy.get('[data-testid="user-menu"], .user-profile, .dashboard').should('be.visible')
})
