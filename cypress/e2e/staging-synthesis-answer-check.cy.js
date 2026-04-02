/**
 * Questions Test Suite (staging — https://staging.entwickler.de)
 *
 * Loads questions from cypress/fixtures/questions.json and tests each question by:
 * 1. Typing the question into the chat input
 * 2. Submitting the question
 * 3. Waiting for the response
 * 4. Extracting: User, Question, Topic, Synthesis Question, response time
 * 5. Generating CSV/JSON reports (incremental after each question + final in after)
 *
 * Pins baseUrl / APP_ORIGIN to staging. Login: cy.authLogin() / cy.userLogin() (see cypress.env.json).
 * Each question is a separate test case for easy failure identification.
 */

const STAGING_ORIGIN = 'https://staging.entwickler.de'

// Load questions synchronously at parse time so Cypress can discover tests
const questions = require('../fixtures/questions.json')
// File writing is handled via cy.task() in cypress.config.js

describe('Questions Test Suite', { testIsolation: false, timeout: 600000 }, () => {
  let reportData = []
  let currentUser = ''
  let reportTimestamp = ''

  before(() => {
    Cypress.config('baseUrl', STAGING_ORIGIN)
    Cypress.env('APP_ORIGIN', STAGING_ORIGIN)

    const now = new Date()
    reportTimestamp = now.toISOString().replace(/[:.]/g, '-').slice(0, -5)

    cy.authLogin()
    cy.userLogin()

    cy.url({ timeout: 15000 }).should('include', '/reader/intelligence')

    cy.get('readerapp-ai-search-composer', { timeout: 15000 })
      .should('exist')
      .should('be.visible')

    cy.get('textarea[placeholder="Frag die Entwickler Intelligence"]', { timeout: 15000 })
      .should('exist')
      .should('be.visible')

    currentUser = Cypress.env('USER_USERNAME') || 'Unknown User'
  })

  after(() => {
    const csvContent = generateCSV(reportData)

    cy.log(`\n=== QUESTIONS TEST REPORT ===`)
    cy.log(`\nExtracted Data:`)
    reportData.forEach((row, index) => {
      cy.log(`\nRow ${index + 1}:`)
      cy.log(`  User: ${row.user}`)
      cy.log(`  Question: ${row.question}`)
      cy.log(`  Topic: ${row.topic}`)
      cy.log(`  Synthesis Question: ${row.synthesisQuestion}`)
      cy.log(`  Response Time: ${row.responseTime} ms`)
    })

    const csvFilename = `questions-report-${reportTimestamp}.csv`
    const jsonFilename = `questions-report-${reportTimestamp}.json`
    cy.task('writeReport', { data: csvContent, filename: csvFilename })
      .then(() =>
        cy.task('writeReport', {
          data: JSON.stringify(reportData, null, 2),
          filename: jsonFilename
        })
      )
      .then(() => {
        cy.log(`\nCSV report generated at: cypress/reports/${csvFilename}`)
        cy.log(`JSON report generated at: cypress/reports/${jsonFilename}`)
      })
  })

  questions.forEach((question, index) => {
    it(`Question ${index + 1}: "${question.substring(0, 50)}${question.length > 50 ? '...' : ''}"`, () => {
      cy.get('textarea[placeholder="Frag die Entwickler Intelligence"]', { timeout: 30000 })
        .should('exist')
        .should('be.visible')
        .should('not.be.disabled')
        .should('not.have.attr', 'disabled')

      cy.get('textarea[placeholder="Frag die Entwickler Intelligence"]')
        .clear()
        .type(question, { force: true })

      cy.get('button.send-button', { timeout: 10000 })
        .should('be.visible')
        .should('not.be.disabled')
        .should('not.have.attr', 'disabled')

      let topic = 'Not found'
      let synthesisQuestion = 'Not found'
      let responseTime = 0
      let startTime = 0

      cy.then(() => {
        startTime = Date.now()
        cy.log(`⏱️  Response time measurement started at: ${startTime}`)
      })

      cy.get('button.send-button').click()

      cy.get('button.send-button', { timeout: 5000 }).should('have.attr', 'disabled')

      cy.get('textarea[placeholder="Frag die Entwickler Intelligence"]', { timeout: 120000 })
        .should('exist')
        .should('be.visible')
        .should('not.be.disabled')
        .should('not.have.attr', 'disabled')
        .then(() => {
          const endTime = Date.now()
          responseTime = endTime - startTime
          cy.log(
            `⏱️  Response time: ${responseTime} ms (${(responseTime / 1000).toFixed(2)} seconds)`
          )
        })

      cy.wait(5000)

      cy.get('body', { timeout: 10000 }).then(($body) => {
        const bodyText = $body.text()

        const topicPattern = /Question topics?:\s*([^\n]+)/gi
        let topicMatch = null
        let lastTopicMatch = null

        while ((topicMatch = topicPattern.exec(bodyText)) !== null) {
          lastTopicMatch = topicMatch
        }

        if (lastTopicMatch && lastTopicMatch[1]) {
          topic = lastTopicMatch[1].trim()
          cy.log(`✓ Found topic on page: "${topic}"`)
        }

        const synthesisPattern = /Synthesised question:\s*([^\n]+)/gi
        let synthesisMatch = null
        let lastSynthesisMatch = null

        while ((synthesisMatch = synthesisPattern.exec(bodyText)) !== null) {
          lastSynthesisMatch = synthesisMatch
        }

        if (lastSynthesisMatch && lastSynthesisMatch[1]) {
          synthesisQuestion = lastSynthesisMatch[1].trim()
          cy.log(`✓ Found synthesis on page: "${synthesisQuestion}"`)
        }

        reportData.push({
          user: currentUser,
          question: question,
          topic: topic,
          synthesisQuestion: synthesisQuestion,
          responseTime: responseTime,
          questionNumber: index + 1
        })

        cy.log(
          `Question ${index + 1} data extracted - Topic: ${topic}, Synthesis: ${synthesisQuestion ? synthesisQuestion.substring(0, 50) + '...' : 'N/A'}, Response Time: ${responseTime} ms`
        )

        const csvContent = generateCSV(reportData)
        const csvFilename = `questions-report-${reportTimestamp}.csv`
        const jsonFilename = `questions-report-${reportTimestamp}.json`
        cy.task('writeReport', { data: csvContent, filename: csvFilename })
          .then(() =>
            cy.task('writeReport', {
              data: JSON.stringify(reportData, null, 2),
              filename: jsonFilename
            })
          )
          .then(() => {
            cy.log(`✓ CSV & JSON report updated with question ${index + 1}`)
          })
      })

      cy.log(`Question ${index + 1} response received and input is ready for next question`)
    })
  })
})

function generateCSV(data) {
  if (data.length === 0) {
    return 'User,Question,Topic,Synthesis Question,Response Time (ms)\n'
  }

  const headers = ['User', 'Question', 'Topic', 'Synthesis Question', 'Response Time (ms)']
  const rows = data.map((row) => [
    escapeCSV(row.user),
    escapeCSV(row.question),
    escapeCSV(row.topic),
    escapeCSV(row.synthesisQuestion),
    escapeCSV(row.responseTime || 0)
  ])

  const csvRows = [headers.join(','), ...rows.map((row) => row.join(','))]
  return csvRows.join('\n')
}

function escapeCSV(value) {
  if (value === null || value === undefined) return ''
  const stringValue = String(value)
  if (stringValue.includes(',') || stringValue.includes('"') || stringValue.includes('\n')) {
    return `"${stringValue.replace(/"/g, '""')}"`
  }
  return stringValue
}
