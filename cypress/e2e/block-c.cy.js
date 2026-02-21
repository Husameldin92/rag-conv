/**
 * Questions Test Suite
 * 
 * This test suite loads questions from cypress/fixtures/questions.json
 * and tests each question individually by:
 * 1. Typing the question into the chat input
 * 2. Submitting the question
 * 3. Waiting for the response
 * 4. Extracting: User, Question, Topic, Synthesis Question from API response
 * 5. Generating a CSV/JSON report
 * 
 * Each question is a separate test case for easy failure identification.
 */

// Load questions synchronously at parse time so Cypress can discover tests
const questions = require('../fixtures/questions.json')
// Note: fs and path are not available in browser context
// File writing is handled via cy.task() in cypress.config.js

describe('Questions Test Suite', { testIsolation: false }, () => {
  let reportData = []
  let currentUser = ''

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
    
    // Extract current user from environment
    currentUser = Cypress.env('USER_USERNAME') || 'Unknown User'
  })

  after(() => {
    // Generate CSV report
    const csvContent = generateCSV(reportData)
    
    // Write CSV report using Cypress task (runs in Node.js context)
    cy.task('writeReport', {
      data: csvContent,
      filename: 'questions-report.csv'
    }).then(() => {
      cy.log(`CSV report generated at: cypress/reports/questions-report.csv`)
    })
    
    // Write JSON report
    cy.task('writeReport', {
      data: JSON.stringify(reportData, null, 2),
      filename: 'questions-report.json'
    }).then(() => {
      cy.log(`JSON report generated at: cypress/reports/questions-report.json`)
    })
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
      
      // Declare variables outside the callback so they're accessible
      let topic = 'Not found'
      let synthesisQuestion = 'Not found'
      
      // Set up interception BEFORE clicking
      cy.intercept('POST', 'https://concord.sandsmedia.com/graphql').as('graphqlRequest')
      
      // Click the send button
      cy.get('button.send-button')
        .click()
      
      // Wait for the send button to be disabled (indicating request is being processed)
      cy.get('button.send-button', { timeout: 5000 })
        .should('have.attr', 'disabled')
      
      // Wait for answer to appear on page FIRST (this is the most reliable)
      // The textarea becomes enabled again when answer is ready
      cy.get('textarea[placeholder="Frag die Entwickler Intelligence"]', { timeout: 120000 })
        .should('exist')
        .should('be.visible')
        .should('not.be.disabled')
        .should('not.have.attr', 'disabled')
      
      // Wait a bit more for answer to fully render
      cy.wait(5000)
      
      // Now try to extract from page (most reliable method)
      // We'll extract from page content since API requests may have already completed
      cy.get('body', { timeout: 10000 }).then(($body) => {
        const bodyText = $body.text()
        
        // Find the LAST occurrence of "Question topics:" (most recent answer)
        const topicPattern = /Question topics?:\s*([^\n]+)/gi
        let topicMatch = null
        let lastTopicMatch = null
        
        while ((topicMatch = topicPattern.exec(bodyText)) !== null) {
          lastTopicMatch = topicMatch
        }
        
        if (lastTopicMatch && lastTopicMatch[1]) {
          topic = lastTopicMatch[1].trim()
        }
        
        // Find the LAST occurrence of "Synthesised question:" (most recent answer)
        const synthesisPattern = /Synthesised question:\s*([^\n]+)/gi
        let synthesisMatch = null
        let lastSynthesisMatch = null
        
        while ((synthesisMatch = synthesisPattern.exec(bodyText)) !== null) {
          lastSynthesisMatch = synthesisMatch
        }
        
        if (lastSynthesisMatch && lastSynthesisMatch[1]) {
          synthesisQuestion = lastSynthesisMatch[1].trim()
        }
      })
      
      // Store the data after extraction
      cy.then(() => {
        // Try API extraction first if we have an interception
        if (answerInterception) {
          const responseBody = answerInterception.response.body
          const userRags = responseBody.data.userRags.UserRags
          
          // Check each UserRag, starting from the most recent
          for (let i = userRags.length - 1; i >= 0; i--) {
            const rag = userRags[i]
            if (rag.turns && rag.turns.length > 0) {
              const lastTurn = rag.turns[rag.turns.length - 1]
              
              // Try to match this turn to the current question
              const questionMatches = lastTurn.question && (
                lastTurn.question.toLowerCase().includes(question.toLowerCase().substring(0, 20)) ||
                question.toLowerCase().includes(lastTurn.question.toLowerCase().substring(0, 20))
              )
              
              if (lastTurn.answer && (questionMatches || rag.turns.length === 1)) {
                const answerText = lastTurn.answer
                
                // Extract using simple string methods
                const topicStart = answerText.indexOf('Question topics:')
                const synthesisStart = answerText.indexOf('Synthesised question:')
                
                if (topicStart > -1 && synthesisStart > -1) {
                  // Extract topic between the two markers
                  const topicText = answerText.substring(topicStart + 'Question topics:'.length, synthesisStart)
                  topic = topicText.trim().replace(/\\n/g, '').replace(/\n/g, '').replace(/\s+/g, ' ').trim()
                  
                  // Extract synthesis question
                  const afterSynthesis = answerText.substring(synthesisStart + 'Synthesised question:'.length)
                  
                  // Find where the next section starts (look for newline followed by capital letter)
                  const nextCapMatch = afterSynthesis.match(/\n\s*([A-Z])/)
                  if (nextCapMatch) {
                    const nextCapIndex = afterSynthesis.indexOf(nextCapMatch[0])
                    synthesisQuestion = afterSynthesis.substring(0, nextCapIndex).trim()
                  } else {
                    // If no capital letter found, take until first newline or first 200 chars
                    const firstNewline = afterSynthesis.indexOf('\n')
                    synthesisQuestion = firstNewline > -1 
                      ? afterSynthesis.substring(0, firstNewline).trim()
                      : afterSynthesis.substring(0, 200).trim()
                  }
                  
                  synthesisQuestion = synthesisQuestion.replace(/\\n/g, '').replace(/\n/g, '').replace(/\s+/g, ' ').trim()
                  
                  // Found it, break out of the loop
                  break
                }
              }
            }
          }
        }
        
        // If API extraction didn't work, try page extraction
        if (topic === 'Not found' || synthesisQuestion === 'Not found') {
          cy.get('body', { timeout: 10000 }).then(($body) => {
            const bodyText = $body.text()
            
            // Find the LAST occurrence of "Question topics:" (most recent answer)
            const topicPattern = /Question topics?:\s*([^\n]+)/gi
            let topicMatch = null
            let lastTopicMatch = null
            
            while ((topicMatch = topicPattern.exec(bodyText)) !== null) {
              lastTopicMatch = topicMatch
            }
            
            if (lastTopicMatch && lastTopicMatch[1]) {
              topic = lastTopicMatch[1].trim()
            }
            
            // Find the LAST occurrence of "Synthesised question:" (most recent answer)
            const synthesisPattern = /Synthesised question:\s*([^\n]+)/gi
            let synthesisMatch = null
            let lastSynthesisMatch = null
            
            while ((synthesisMatch = synthesisPattern.exec(bodyText)) !== null) {
              lastSynthesisMatch = synthesisMatch
            }
            
            if (lastSynthesisMatch && lastSynthesisMatch[1]) {
              synthesisQuestion = lastSynthesisMatch[1].trim()
            }
          })
        }
        
        // Store the data
        reportData.push({
          user: currentUser,
          question: question,
          topic: topic,
          synthesisQuestion: synthesisQuestion,
          questionNumber: index + 1
        })
        
        cy.log(`Question ${index + 1} data extracted - Topic: ${topic}, Synthesis: ${synthesisQuestion ? synthesisQuestion.substring(0, 50) + '...' : 'N/A'}`)
      })
      
      // Note: We already waited for textarea above, so we're done
      cy.log(`Question ${index + 1} response received and input is ready for next question`)
    })
  })
})

// Helper function to generate CSV
function generateCSV(data) {
  if (data.length === 0) return 'User,Question,Topic,Synthesis Question\n'
  
  const headers = ['User', 'Question', 'Topic', 'Synthesis Question']
  const rows = data.map(row => [
    escapeCSV(row.user),
    escapeCSV(row.question),
    escapeCSV(row.topic),
    escapeCSV(row.synthesisQuestion)
  ])
  
  const csvRows = [headers.join(','), ...rows.map(row => row.join(','))]
  return csvRows.join('\n')
}

// Helper function to escape CSV values
function escapeCSV(value) {
  if (value === null || value === undefined) return ''
  const stringValue = String(value)
  if (stringValue.includes(',') || stringValue.includes('"') || stringValue.includes('\n')) {
    return `"${stringValue.replace(/"/g, '""')}"`
  }
  return stringValue
}
