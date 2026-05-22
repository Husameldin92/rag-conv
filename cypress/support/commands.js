// ***********************************************
// Custom commands — chat UI + overlays
// Rule: composer text input enabled = ready to type; after send, wait until it is enabled again = turn done.
// ***********************************************

/**
 * Textarea inside readerapp-ai-search-composer only (avoids stray .message-input on the page).
 */
Cypress.Commands.add('getChatInput', (options = {}) => {
  const timeout = options.timeout != null ? options.timeout : 30000
  return cy
    .get('readerapp-ai-search-composer', { timeout })
    .should('be.visible')
    .find('.message-input')
    .filter(':visible')
    .first()
})

/**
 * Wait until the composer textarea is enabled (not disabled). Same signal before the first question and after each answer.
 */
Cypress.Commands.add('waitForComposerTextareaReady', (options = {}) => {
  const timeout = options.timeout != null ? options.timeout : 300000
  cy.get('readerapp-ai-search-composer', { timeout })
    .should('be.visible')
    .find('.message-input')
    .filter(':visible')
    .first()
    .should('be.visible')
    .should('not.be.disabled')
    .should('not.have.attr', 'disabled')
})

Cypress.Commands.add('waitForComposerReadyForNewQuestion', (options = {}) => {
  const timeout = options.timeout != null ? options.timeout : 180000
  cy.log('⏳ Text input ready (previous turn finished)…')
  cy.waitForComposerTextareaReady({ timeout })
})

function isSendButtonDisabled($el) {
  return (
    $el.is(':disabled') ||
    $el.attr('disabled') !== undefined ||
    $el.attr('aria-disabled') === 'true'
  )
}

Cypress.Commands.add('getComposerSendButton', (options = {}) => {
  const timeout = options.timeout != null ? options.timeout : 30000
  return cy
    .get('readerapp-ai-search-composer', { timeout })
    .should('be.visible')
    .find('button.send-button')
})

/** After typing: wait until send is no longer disabled, then click. */
Cypress.Commands.add('waitForComposerSendEnabled', (options = {}) => {
  const timeout = options.timeout != null ? options.timeout : 30000
  cy.getComposerSendButton({ timeout })
    .filter(':visible')
    .first()
    .should('be.visible')
    .should(($el) => {
      expect(isSendButtonDisabled($el), 'send enabled after typing').to.be.false
    })
})

Cypress.Commands.add('dismissOverlays', () => {
  cy.get('body', { timeout: 5000 }).then(($body) => {
    const oneSignal = $body.find('#onesignal-slidedown-cancel-button:visible')
    if (oneSignal.length) {
      cy.wrap(oneSignal.first()).click({ force: true })
      cy.log('Dismissed OneSignal slide-down')
    }
  })

  cy.get('body').then(($body) => {
    if ($body.find(':contains("Alle akzeptieren")').length > 0) {
      cy.contains('Alle akzeptieren', { timeout: 5000 }).click()
      cy.log('Accepted cookie banner')
    }
  })
})

const { textFromNodeDeep } = require('./perf-shadow-text')

/**
 * Full plain text including open shadow roots (Performance Metrics / Stage tables are often inside
 * web components — `cy.get('body').invoke('text')` misses them, which leaves Token received / totals empty).
 */
Cypress.Commands.add('getDocumentTextIncludingShadow', () => {
  return cy.document().then((doc) => textFromNodeDeep(doc.body))
})

const { extractBackendStageTableFromDom } = require('./staging-backend-stage-dom')

/** Rows from the on-screen backend Stage table (`STAGE`, `TIMESTAMP`, `DELTA (MS)`). */
Cypress.Commands.add('getBackendStageTableRows', () => {
  return cy.document().then((doc) => extractBackendStageTableFromDom(doc.body))
})
