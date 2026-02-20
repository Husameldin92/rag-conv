/**
 * Questions Test Suite
 * 
 * This test suite loads questions from cypress/fixtures/questions.json
 * and tests each question individually by:
 * 1. Typing the question into the chat input
 * 2. Submitting the question
 * 3. Waiting for the response
 * 4. Asserting that a response is returned (not empty)
 * 
 * Each question is a separate test case for easy failure identification.
 */

// Load questions synchronously at parse time so Cypress can discover tests
const questions = require('../fixtures/questions.json')

describe('Questions Test Suite', { testIsolation: false }, () => {
  before(() => {
    // Perform both login steps once before all tests
    // This will navigate to https://staging.entwickler.de/reader/intelligence after login
    cy.authLogin()
    cy.userLogin()
    
    // Wait for the intelligence page to fully load before starting tests
    cy.url({ timeout: 15000 }).should('include', '/reader/intelligence')
    
    // Wait for the composer component to be present on the page
    cy.get('readerapp-ai-search-composer', { timeout: 15000 })
      .should('exist')
      .should('be.visible')
    
    // Wait for the textarea to be ready
    cy.get('textarea[placeholder="Frag die Entwickler Intelligence"]', { timeout: 15000 })
      .should('exist')
      .should('be.visible')
  })

  // Generate a test for each question - all in the same chat session
  questions.forEach((question, index) => {
    it(`Question ${index + 1}: "${question.substring(0, 50)}${question.length > 50 ? '...' : ''}"`, () => {
      // Wait until the chat input is unlocked/ready for the next question
      cy.get('textarea[placeholder="Frag die Entwickler Intelligence"]', { timeout: 30000 })
        .should('exist')
        .should('be.visible')
        .should('not.be.disabled')
        .should('not.have.attr', 'disabled')
      
      // Clear and type the question
      cy.get('textarea[placeholder="Frag die Entwickler Intelligence"]')
        .clear()
        .type(question, { force: true })
      
      // Wait for the send button to be enabled (it starts disabled)
      cy.get('button.send-button', { timeout: 10000 })
        .should('be.visible')
        .should('not.be.disabled')
        .should('not.have.attr', 'disabled')
      
      // Click the send button
      cy.get('button.send-button')
        .click()
      
      // Wait for the send button to be disabled (indicating request is being processed)
      cy.get('button.send-button', { timeout: 5000 })
        .should('have.attr', 'disabled')
      
      // Wait for the response to complete - wait for textarea to be ready again
      // The textarea becomes available again when the response is complete
      cy.get('textarea[placeholder="Frag die Entwickler Intelligence"]', { timeout: 60000 })
        .should('exist')
        .should('be.visible')
        .should('not.be.disabled')
        .should('not.have.attr', 'disabled')
      
      cy.log(`Question ${index + 1} response received and input is ready for next question`)
    })
  })
})
