/**
 * Production — conversational RAG (https://entwickler.de)
 *
 * Loads cypress/fixtures/questions.json
 * and tests each question individually by:
 * 1. Typing the question into the chat input
 * 2. Submitting the question
 * 3. Waiting for the response
 * 4. Extracting Topic, Synthesis Question (from page text) and LLM answer (prefer GraphQL API)
 * 5. Generating a CSV/JSON report
 *
 * LLM answer: Prefer the GraphQL `userRags` response (`lastTurn.answer`) — same text the app
 * receives; streaming responses may yield multiple GraphQL payloads; we keep the longest answer.
 * Fallback: page text after the last "Synthesised question:" line if API capture is empty.
 */

// Load questions synchronously at parse time so Cypress can discover tests
const questions = require('../fixtures/questions.json')
// File writing is handled via cy.task() in cypress.config.js

/** Longest answer string in the payload (used while GraphQL may fire multiple times). */
function extractLongestAnswerFromGraphqlBody(body) {
  if (!body || !body.data || !body.data.userRags || !body.data.userRags.UserRags) {
    return ''
  }
  let best = ''
  for (const rag of body.data.userRags.UserRags) {
    if (!rag.turns) continue
    for (const turn of rag.turns) {
      if (turn.answer && String(turn.answer).length > best.length) {
        best = String(turn.answer).trim()
      }
    }
  }
  return best
}

/** GraphQL response shape: data.userRags.UserRags[].turns[].answer */
function extractLlmAnswerFromGraphqlBody(body, currentQuestion) {
  if (!body || !body.data || !body.data.userRags || !body.data.userRags.UserRags) {
    return ''
  }
  const rags = body.data.userRags.UserRags
  for (let i = rags.length - 1; i >= 0; i--) {
    const rag = rags[i]
    if (!rag.turns || !rag.turns.length) continue
    const lastTurn = rag.turns[rag.turns.length - 1]
    if (!lastTurn.answer) continue
    const q = (lastTurn.question || '').toLowerCase()
    const cur = (currentQuestion || '').toLowerCase()
    const questionMatches =
      q &&
      cur &&
      (q.includes(cur.substring(0, Math.min(20, cur.length))) ||
        cur.includes(q.substring(0, Math.min(20, q.length))))
    if (questionMatches || rag.turns.length === 1) {
      return String(lastTurn.answer).trim()
    }
  }
  const lastRag = rags[rags.length - 1]
  if (lastRag.turns && lastRag.turns.length) {
    const t = lastRag.turns[lastRag.turns.length - 1]
    return t.answer ? String(t.answer).trim() : ''
  }
  return ''
}

/** Fallback when API body is not captured */
function extractLlmAnswerFromPageText(bodyText) {
  const synIdx = bodyText.lastIndexOf('Synthesised question:')
  if (synIdx === -1) return ''
  const after = bodyText.slice(synIdx)
  const rest = after.replace(/^[\s\S]*?Synthesised question:\s*[^\n]+\n([\s\S]*)/i, '$1')
  if (rest === after) return ''
  return rest.trim().slice(0, 100000)
}

// Each question can take several minutes (LLM stream). Default Mocha/Cypress test timeout is 60s.
describe('Production — conversational RAG', { testIsolation: false, timeout: 600000 }, () => {
  let reportData = []
  let currentUser = ''
  let reportTimestamp = ''
  const graphqlCapture = { longestAnswer: '', lastBody: null }

  before(() => {
    // Generate unique timestamp for this test run
    const now = new Date()
    reportTimestamp = now.toISOString().replace(/[:.]/g, '-').slice(0, -5) // Format: 2026-02-20T14-30-45
    
    cy.authLogin()
    cy.userLogin()
    

    cy.url({ timeout: 15000 }).should('include', '/reader/intelligence')
    
    cy.get('readerapp-ai-search-composer', { timeout: 15000 })
      .should('exist')
      .should('be.visible')
    
    cy.getChatInput()
      .should('exist')
      .should('be.visible')
    
    // Extract current user from environment
    currentUser = Cypress.env('USER_USERNAME') || 'Unknown User'

    const graphqlUrl =
      Cypress.env('GRAPHQL_URL') || 'https://concord.sandsmedia.com/graphql'
    // Passive: does not modify requests/responses or stop streaming — only copies response body for the report.
    cy.intercept('POST', graphqlUrl, (req) => {
      req.on('response', (res) => {
        try {
          const body = res.body
          graphqlCapture.lastBody = body
          const longest = extractLongestAnswerFromGraphqlBody(body)
          if (longest.length > graphqlCapture.longestAnswer.length) {
            graphqlCapture.longestAnswer = longest
          }
        } catch (_) {
          // ignore parse errors
        }
      })
    })
  })

  after(() => {
    // Generate CSV report
    const csvContent = generateCSV(reportData)
    
    cy.log(`\n=== QUESTIONS TEST REPORT ===`)
    cy.log(`\nExtracted Data:`)
    reportData.forEach((row, index) => {
      cy.log(`\nRow ${index + 1}:`)
      cy.log(`  User: ${row.user}`)
      cy.log(`  Question: ${row.question}`)
      cy.log(`  Topic: ${row.topic}`)
      cy.log(`  Synthesis Question: ${row.synthesisQuestion}`)
      const ans = row.llmAnswer || ''
      cy.log(`  LLM Answer (preview): ${ans.length > 200 ? `${ans.substring(0, 200)}...` : ans || '(empty)'}`)
      cy.log(`  Response Time: ${row.responseTime} ms`)
    })
    
    // Write CSV report using Cypress task (runs in Node.js context) with unique filename
    const csvFilename = `questions-report-${reportTimestamp}.csv`
    cy.task('writeReport', {
      data: csvContent,
      filename: csvFilename
    }).then(() => {
      cy.log(`\nCSV report generated at: cypress/reports/${csvFilename}`)
    })
    
    // Write JSON report with unique filename
    const jsonFilename = `questions-report-${reportTimestamp}.json`
    cy.task('writeReport', {
      data: JSON.stringify(reportData, null, 2),
      filename: jsonFilename
    }).then(() => {
      cy.log(`JSON report generated at: cypress/reports/${jsonFilename}`)
    })
  })

  questions.forEach((question, index) => {
    it(`Question ${index + 1}: "${question.substring(0, 50)}${question.length > 50 ? '...' : ''}"`, () => {
      // Previous turn: wait until textarea enabled again (not overlays — login already dismissed; avoid extra clicks before typing).
      cy.waitForComposerReadyForNewQuestion({ timeout: 180000 })

      // Let the previous answer finish rendering/streaming before typing the next question
      if (index > 0) {
        cy.wait(30000)
        cy.log('⏳ 30s pause before typing the next question')
      }

      cy.then(() => {
        graphqlCapture.longestAnswer = ''
        graphqlCapture.lastBody = null
      })

      cy.log(`▶ Question ${index + 1}/${questions.length}`)

      let topic = 'Not found'
      let synthesisQuestion = 'Not found'
      let llmAnswer = ''
      let responseTime = 0
      let startTime = 0

      cy.getChatInput()
        .clear()
        .type(question, { force: true })

      cy.getChatInput().should('not.be.disabled')
      cy.waitForComposerSendEnabled({ timeout: 60000 })

      cy.getComposerSendButton({ timeout: 10000 })
        .filter(':visible')
        .first()
        .should('be.visible')
        .then(($btn) => {
          const node = $btn[0]
          const sendDisabled =
            !node ||
            node.disabled ||
            $btn.attr('disabled') !== undefined ||
            $btn.attr('aria-disabled') === 'true'

          if (sendDisabled) {
            cy.log('⚠ Send still disabled — not clicking (skips this question)')
            reportData.push({
              user: currentUser,
              question,
              topic: 'Not sent',
              synthesisQuestion: 'Not sent',
              llmAnswer: '',
              responseTime: 0,
              questionNumber: index + 1
            })
            const csvContent = generateCSV(reportData)
            const csvFilename = `questions-report-${reportTimestamp}.csv`
            cy.task('writeReport', { data: csvContent, filename: csvFilename })
            const jsonFilename = `questions-report-${reportTimestamp}.json`
            cy.task('writeReport', {
              data: JSON.stringify(reportData, null, 2),
              filename: jsonFilename
            })
            return
          }

          startTime = Date.now()
          node.click()

          cy.log('⏳ Wait until text input is enabled again (then next question)…')
          cy.waitForComposerTextareaReady({ timeout: 300000 })

          cy.then(() => {
            const endTime = Date.now()
            responseTime = endTime - startTime
            cy.log(
              `⏱️  Response time: ${responseTime} ms (${(responseTime / 1000).toFixed(2)} s) — click → textarea ready again`
            )
          })

          cy.wait(300)

          cy.get('body', { timeout: 10000 }).then(($body) => {
        const bodyText = $body.text()

        llmAnswer = extractLlmAnswerFromGraphqlBody(graphqlCapture.lastBody, question)
        if (!llmAnswer) {
          llmAnswer = graphqlCapture.longestAnswer
        }
        if (!llmAnswer) {
          llmAnswer = extractLlmAnswerFromPageText(bodyText)
        }
        if (llmAnswer) {
          cy.log(`✓ LLM answer captured (${llmAnswer.length} chars)`)
        } else {
          cy.log(`✗ LLM answer not captured from API or page fallback`)
        }

        // Find the LAST occurrence of "Question topics:" (most recent answer)
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
        
        // Find the LAST occurrence of "Synthesised question:" (most recent answer)
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
        
        // Store the data AFTER extraction completes
        reportData.push({
          user: currentUser,
          question: question,
          topic: topic,
          synthesisQuestion: synthesisQuestion,
          llmAnswer: llmAnswer,
          responseTime: responseTime,
          questionNumber: index + 1
        })
        
        cy.log(`Question ${index + 1} data extracted - Topic: ${topic}, Synthesis: ${synthesisQuestion ? synthesisQuestion.substring(0, 50) + '...' : 'N/A'}, LLM chars: ${llmAnswer ? llmAnswer.length : 0}, Response Time: ${responseTime} ms`)
        
        // Generate and save reports after each question (incremental saving)
        const csvContent = generateCSV(reportData)
        const csvFilename = `questions-report-${reportTimestamp}.csv`
        cy.task('writeReport', {
          data: csvContent,
          filename: csvFilename
        }).then(() => {
          cy.log(`✓ CSV report updated with question ${index + 1}`)
        })
        
        const jsonFilename = `questions-report-${reportTimestamp}.json`
        cy.task('writeReport', {
          data: JSON.stringify(reportData, null, 2),
          filename: jsonFilename
        }).then(() => {
          cy.log(`✓ JSON report updated with question ${index + 1}`)
        })
          })

          cy.log(`Question ${index + 1} response received and input is ready for next question`)
        })
    })
  })
})

// Helper function to generate CSV
function generateCSV(data) {
  if (data.length === 0) {
    return 'User,Question,Topic,Synthesis Question,LLM Answer,Response Time (ms)\n'
  }

  const headers = [
    'User',
    'Question',
    'Topic',
    'Synthesis Question',
    'LLM Answer',
    'Response Time (ms)'
  ]
  const rows = data.map(row => [
    escapeCSV(row.user),
    escapeCSV(row.question),
    escapeCSV(row.topic),
    escapeCSV(row.synthesisQuestion),
    escapeCSV(row.llmAnswer || ''),
    escapeCSV(row.responseTime || 0)
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
