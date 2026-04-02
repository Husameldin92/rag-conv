// ***********************************************
// Custom commands — chat UI + overlays
// ***********************************************

/**
 * Chat composer input (Entwickler Intelligence).
 * Prefer .message-input; falls back to legacy placeholder if needed.
 */
Cypress.Commands.add('getChatInput', (options = {}) => {
  const timeout = options.timeout != null ? options.timeout : 30000
  return cy.get('.message-input', { timeout })
})

/**
 * Wait until the composer can accept input again (previous turn finished).
 * Only checks the textarea — send stays disabled until there is text to type.
 */
Cypress.Commands.add('waitForComposerReadyForNewQuestion', (options = {}) => {
  const timeout = options.timeout != null ? options.timeout : 180000
  cy.log('⏳ [queue] Wait until chat is ready before typing the next question…')
  cy.get('.message-input', { timeout })
    .should('exist')
    .should('be.visible')
    .should('not.be.disabled')
    .should('not.have.attr', 'disabled')
})

/**
 * After stream ends: wait until the LLM answer is visible (page markers and/or GraphQL length).
 * Use getGraphqlLength from the spec to read intercept-captured answer length.
 */
Cypress.Commands.add('waitForAnswerVisibleOnPage', (options = {}) => {
  const timeout = options.timeout != null ? options.timeout : 180000
  const getGraphqlLength = options.getGraphqlLength
  cy.get('body', { timeout }).should(($body) => {
    const t = $body.text()
    const hasUiMarkers = /Synthesised question:|Question topics?:/i.test(t)
    let gqlLen = 0
    if (typeof getGraphqlLength === 'function') {
      gqlLen = Number(getGraphqlLength()) || 0
    }
    expect(
      hasUiMarkers || gqlLen > 120,
      'LLM answer: page markers or substantial GraphQL answer'
    ).to.be.true
  })
})

/**
 * One place: send clicked → wait for stream to finish → wait for answer content.
 * Order is always: ask → WAIT for full LLM answer → (caller types next question).
 */
Cypress.Commands.add('waitForLlmAnswerComplete', (options = {}) => {
  const answerTimeout = options.answerTimeout != null ? options.answerTimeout : 180000
  const { getGraphqlLength, answerTimeout: _at, ...streamOpts } = options
  cy.log('⏳ [LLM] Waiting for stream to finish (send disabled → enabled)…')
  cy.waitForSendReadyAfterStream(streamOpts)
  cy.log('⏳ [LLM] Waiting for answer text (page / API)…')
  cy.waitForAnswerVisibleOnPage({ timeout: answerTimeout, getGraphqlLength })
})

/**
 * After clicking send: stream runs (send disabled) → when send is enabled again, the turn is done.
 * Use this as the end of "response time", not only textarea enabled.
 */
function isSendButtonDisabled($el) {
  return (
    $el.is(':disabled') ||
    $el.attr('disabled') !== undefined ||
    $el.attr('aria-disabled') === 'true'
  )
}

/**
 * Send control inside the intelligence composer only (avoids global button.send-button matches).
 */
Cypress.Commands.add('getComposerSendButton', (options = {}) => {
  const timeout = options.timeout != null ? options.timeout : 30000
  return cy
    .get('readerapp-ai-search-composer', { timeout })
    .should('be.visible')
    .find('button.send-button')
})

Cypress.Commands.add('waitForSendReadyAfterStream', (options = {}) => {
  const streamTimeout = options.streamTimeout != null ? options.streamTimeout : 120000
  const doneTimeout = options.timeout != null ? options.timeout : 300000
  const skipDisabled =
    options.skipStreamDisabledCheck === true || Cypress.env('SKIP_STREAM_DISABLED') === true

  if (skipDisabled) {
    cy.log(
      'waitForSendReadyAfterStream: skipping send disabled/enabled — short pause then waitForAnswerVisibleOnPage'
    )
    cy.wait(options.afterSkipPauseMs != null ? options.afterSkipPauseMs : 2000)
    return
  }

  // 1) Stream is running: send is not clickable (allow up to streamTimeout for slow UIs)
  cy.getComposerSendButton({ timeout: streamTimeout })
    .should('be.visible')
    .should(($el) => {
      expect(isSendButtonDisabled($el), 'send should be disabled while streaming').to.be.true
    })
  // 2) Turn done: send enabled again (ready for next question after you type)
  cy.getComposerSendButton({ timeout: doneTimeout })
    .should('be.visible')
    .should(($el) => {
      expect(isSendButtonDisabled($el), 'send should be enabled again after stream').to.be.false
    })
})


/**
 * Dismiss cookie banner, OneSignal push slide-down, etc. Safe to call often (no-op if missing).
 */
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
