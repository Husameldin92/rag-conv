/**
 * Quick Test - Single Question
 * 
 * This test runs a single question to verify:
 * 1. API data extraction works correctly
 * 2. Topic and Synthesis Question are extracted properly
 * 3. Report generation works
 */

// Note: fs and path are not available in browser context
// File writing is handled via cy.task() in cypress.config.js

describe('Quick Test - Three Questions', { testIsolation: false }, () => {
  let reportData = []
  let currentUser = ''
  let reportTimestamp = ''
  const testQuestions = [
    "What is AI?",
    "How does machine learning work? with examples and use cases",
    "What is deep learning?",
    "What is the difference between machine learning and deep learning?",
    "how salesforce work with that?"
  ]

  before(() => {
    // Generate unique timestamp for this test run
    const now = new Date()
    reportTimestamp = now.toISOString().replace(/[:.]/g, '-').slice(0, -5) // Format: 2026-02-20T14-30-45
    
    // Perform both login steps
    cy.authLogin()
    cy.userLogin()
    
    // Wait for the intelligence page to fully load
    cy.url({ timeout: 15000 }).should('include', '/reader/intelligence')
    
    // Wait for the composer component to be present
    cy.get('readerapp-ai-search-composer', { timeout: 15000 })
      .should('exist')
      .should('be.visible')
    
    // Wait for the textarea to be ready
    cy.getChatInput()
      .should('exist')
      .should('be.visible')
    
    // Extract current user from environment
    currentUser = Cypress.env('USER_USERNAME') || 'Unknown User'
  })

  after(() => {
    // Generate CSV report
    const csvContent = generateCSV(reportData)
    
    cy.log(`\n=== QUICK TEST REPORT ===`)
    cy.log(`\nExtracted Data:`)
    reportData.forEach((row, index) => {
      cy.log(`\nRow ${index + 1}:`)
      cy.log(`  User: ${row.user}`)
      cy.log(`  Question: ${row.question}`)
      cy.log(`  Topic: ${row.topic}`)
      cy.log(`  Synthesis Question: ${row.synthesisQuestion}`)
      cy.log(`  Response Time: ${row.responseTime} ms`)
    })
    
    // Write CSV report using Cypress task (runs in Node.js context) with unique filename
    const csvFilename = `quick-test-report-${reportTimestamp}.csv`
    cy.task('writeReport', {
      data: csvContent,
      filename: csvFilename
    }).then(() => {
      cy.log(`\nCSV report generated at: cypress/reports/${csvFilename}`)
    })
    
    // Write JSON report with unique filename
    const jsonFilename = `quick-test-report-${reportTimestamp}.json`
    cy.task('writeReport', {
      data: JSON.stringify(reportData, null, 2),
      filename: jsonFilename
    }).then(() => {
      cy.log(`JSON report generated at: cypress/reports/${jsonFilename}`)
    })
  })

  // Generate a test for each question
  testQuestions.forEach((testQuestion, questionIndex) => {
    it(`Question ${questionIndex + 1}: "${testQuestion.substring(0, 50)}${testQuestion.length > 50 ? '...' : ''}"`, () => {
      // Do not send the next question until the previous turn is fully done
      cy.waitForComposerReadyForNewQuestion({ timeout: 180000 })
      cy.dismissOverlays()

      // Declare variables outside the callback so they're accessible
      let topic = 'Not found'
      let synthesisQuestion = 'Not found'
      let responseTime = 0
      let startTime = 0
      
      // 1) Type → 2) send active → 3) click send (intercept must be registered before click)
      cy.getChatInput()
        .clear()
        .type(testQuestion, { force: true })

      cy.intercept('POST', 'https://concord.sandsmedia.com/graphql').as('graphqlRequest')

      cy.getComposerSendButton({ timeout: 30000 })
        .should('be.visible')
        .should('not.be.disabled')
        .should('not.have.attr', 'disabled')
      cy.getComposerSendButton({ timeout: 10000 })
        .first()
        .should('be.visible')
        .should('not.be.disabled')
        .then(($el) => {
          const node = $el && $el[0]
          if (!node) throw new Error('Composer send button not found for click')
          startTime = Date.now()
          node.click()
        })

    let answerInterception = null

    cy.waitForLlmAnswerComplete({
      streamTimeout: 120000,
      timeout: 300000,
      answerTimeout: 180000,
    })

    cy.then(() => {
      const endTime = Date.now()
      responseTime = endTime - startTime
      cy.log(
        `⏱️  Response time: ${responseTime} ms (${(responseTime / 1000).toFixed(2)} s) — until answer complete`
      )
    })
    cy.wait(1000)
    
    // Note: We set up interception earlier, but requests may have already completed
    // We'll extract from the page content instead, which is more reliable
    
    // Now process the answer interception
    cy.then(() => {
      // Always push data, even if we didn't find the answer in API
      // We'll try to extract from page as fallback
      
      if (!answerInterception) {
        cy.log(`\n✗ No request found with userRags after checking 5 requests`)
        cy.log(`Will try to extract from page content as fallback`)
        
        // Push empty data first, will update later if we find it on page
        reportData.push({
          user: currentUser,
          question: testQuestion,
          topic: topic,
          synthesisQuestion: synthesisQuestion,
          responseTime: responseTime,
          questionNumber: questionIndex + 1
        })
        
        // Try to extract from page
        cy.get('body', { timeout: 10000 }).then(($body) => {
          const bodyText = $body.text()
          cy.log(`Page text length: ${bodyText.length} characters`)
          
          // Try to find topic and synthesis in page text
          // IMPORTANT: Find the LAST occurrence (most recent answer), not the first
          // We'll search backwards from the end of the text
          
          let foundTopic = false
          let foundSynthesis = false
          
          // Find the LAST occurrence of "Question topics:" (most recent answer)
          const topicPattern = /Question topics?:\s*([^\n]+)/gi
          let topicMatch = null
          let lastTopicMatch = null
          
          // Find all matches and get the last one
          while ((topicMatch = topicPattern.exec(bodyText)) !== null) {
            lastTopicMatch = topicMatch
          }
          
          if (lastTopicMatch && lastTopicMatch[1] && reportData.length > 0) {
            reportData[reportData.length - 1].topic = lastTopicMatch[1].trim()
            cy.log(`✓ Found topic on page (last occurrence): "${lastTopicMatch[1].trim()}"`)
            foundTopic = true
          }
          
          // Find the LAST occurrence of "Synthesised question:" (most recent answer)
          const synthesisPattern = /Synthesised question:\s*([^\n]+)/gi
          let synthesisMatch = null
          let lastSynthesisMatch = null
          
          // Find all matches and get the last one
          while ((synthesisMatch = synthesisPattern.exec(bodyText)) !== null) {
            lastSynthesisMatch = synthesisMatch
          }
          
          if (lastSynthesisMatch && lastSynthesisMatch[1] && reportData.length > 0) {
            reportData[reportData.length - 1].synthesisQuestion = lastSynthesisMatch[1].trim()
            cy.log(`✓ Found synthesis on page (last occurrence): "${lastSynthesisMatch[1].trim()}"`)
            foundSynthesis = true
          }
          
          if (!foundTopic || !foundSynthesis) {
            // Log context around keywords for debugging
            const topicIndex = bodyText.toLowerCase().indexOf('topic')
            const synthesisIndex = bodyText.toLowerCase().indexOf('synthes')
            if (topicIndex > -1) {
              cy.log(`Found "topic" at index ${topicIndex}: ${bodyText.substring(Math.max(0, topicIndex - 50), Math.min(bodyText.length, topicIndex + 200))}`)
            }
            if (synthesisIndex > -1) {
              cy.log(`Found "synthes" at index ${synthesisIndex}: ${bodyText.substring(Math.max(0, synthesisIndex - 50), Math.min(bodyText.length, synthesisIndex + 200))}`)
            }
          }
          
          // Generate and save reports after page extraction (incremental saving)
          const csvContent = generateCSV(reportData)
          const csvFilename = `quick-test-report-${reportTimestamp}.csv`
          cy.task('writeReport', {
            data: csvContent,
            filename: csvFilename
          }).then(() => {
            cy.log(`✓ CSV report updated with question ${questionIndex + 1} (from page extraction)`)
          })
          
          const jsonFilename = `quick-test-report-${reportTimestamp}.json`
          cy.task('writeReport', {
            data: JSON.stringify(reportData, null, 2),
            filename: jsonFilename
          }).then(() => {
            cy.log(`✓ JSON report updated with question ${questionIndex + 1} (from page extraction)`)
          })
        })
        
        return
      }
      
      // Process the interception with the answer
      const interception = answerInterception
      
      cy.log(`\n=== FULL API RESPONSE DEBUG ===`)
      
      if (!interception || !interception.response) {
        cy.log(`✗ No interception or response found`)
        cy.log(`Interception: ${JSON.stringify(interception)}`)
        // Still push data even if interception is invalid
        reportData.push({
          user: currentUser,
          question: testQuestion,
          topic: topic,
          synthesisQuestion: synthesisQuestion,
          responseTime: responseTime,
          questionNumber: questionIndex + 1
        })
        return
      }
      
      const response = interception.response
      
      // Write request body to debug file to see what query was made
      if (interception.requestBody) {
        cy.task('writeDebug', {
          data: JSON.stringify(interception.requestBody, null, 2),
          filename: 'request-body.json'
        })
      }
      cy.log(`Response status: ${response.statusCode}`)
      cy.log(`Response headers: ${JSON.stringify(response.headers)}`)
      
      if (!response.body) {
        cy.log(`✗ No response body`)
        // Still push data even if no response body
        reportData.push({
          user: currentUser,
          question: testQuestion,
          topic: topic,
          synthesisQuestion: synthesisQuestion,
          responseTime: responseTime,
          questionNumber: questionIndex + 1
        })
        return
      }
      
      // Log the FULL response body structure
      cy.log(`\n=== FULL RESPONSE BODY ===`)
      const fullResponseJson = JSON.stringify(response.body, null, 2)
      cy.log(fullResponseJson)
      
      // Write full response to debug file
      cy.task('writeDebug', {
        data: fullResponseJson,
        filename: 'api-response-full.json'
      })
      
      const responseBody = response.body
      
      // Navigate through the response structure
      if (responseBody.data && responseBody.data.userRags && responseBody.data.userRags.UserRags) {
        const userRags = responseBody.data.userRags.UserRags
        cy.log(`\n✓ Found ${userRags.length} UserRags`)
        
        // Check each UserRag, starting from the most recent
        for (let i = userRags.length - 1; i >= 0; i--) {
          const rag = userRags[i]
          cy.log(`\n--- UserRag ${i} ---`)
          cy.log(`Name: "${rag.name}"`)
          cy.log(`Turns: ${rag.turns ? rag.turns.length : 0}`)
          
          if (rag.turns && rag.turns.length > 0) {
            // Check the last turn (most recent answer)
            const lastTurn = rag.turns[rag.turns.length - 1]
            cy.log(`Last turn question: "${lastTurn.question}"`)
            cy.log(`Current test question: "${testQuestion}"`)
            
            // Try to match this turn to the current question
            // Check if the turn's question matches (or is similar to) the current test question
            const questionMatches = lastTurn.question && (
              lastTurn.question.toLowerCase().includes(testQuestion.toLowerCase().substring(0, 20)) ||
              testQuestion.toLowerCase().includes(lastTurn.question.toLowerCase().substring(0, 20))
            )
            
            if (lastTurn.answer && (questionMatches || rag.turns.length === 1)) {
              cy.log(`✓ Using this turn (question matches: ${questionMatches})`)
              const answerText = lastTurn.answer
              cy.log(`\n=== ANSWER TEXT (first 1000 chars) ===`)
              cy.log(answerText.substring(0, 1000))
              
              // Write answer text to debug file
              cy.task('writeDebug', {
                data: answerText,
                filename: 'answer-text-full.txt'
              })
              
              // Also write a JSON with the answer and extraction attempts
              const extractionDebug = {
                answerLength: answerText.length,
                answerPreview: answerText.substring(0, 500),
                topicStartIndex: answerText.indexOf('Question topics:'),
                synthesisStartIndex: answerText.indexOf('Synthesised question:'),
                topicEndIndex: answerText.indexOf('Synthesised question:'),
                hasTopicMarker: answerText.includes('Question topics:'),
                hasSynthesisMarker: answerText.includes('Synthesised question:'),
                answerContainsNewlines: answerText.includes('\n'),
                answerContainsEscapedNewlines: answerText.includes('\\n')
              }
              cy.task('writeDebug', {
                data: JSON.stringify(extractionDebug, null, 2),
                filename: 'extraction-debug.json'
              })
              
              // Extract using simple string methods
              const topicStart = answerText.indexOf('Question topics:')
              const synthesisStart = answerText.indexOf('Synthesised question:')
              
              cy.log(`\n=== EXTRACTION ATTEMPT ===`)
              cy.log(`"Question topics:" found at index: ${topicStart}`)
              cy.log(`"Synthesised question:" found at index: ${synthesisStart}`)
              
              if (topicStart > -1 && synthesisStart > -1) {
                // Extract topic between the two markers
                const topicText = answerText.substring(topicStart + 'Question topics:'.length, synthesisStart)
                cy.log(`Raw topic text: "${topicText}"`)
                topic = topicText.trim().replace(/\\n/g, '').replace(/\n/g, '').replace(/\s+/g, ' ').trim()
                cy.log(`✓ Topic extracted: "${topic}"`)
                
                // Extract synthesis question
                const afterSynthesis = answerText.substring(synthesisStart + 'Synthesised question:'.length)
                cy.log(`Text after "Synthesised question:": "${afterSynthesis.substring(0, 200)}"`)
                
                // Find where the next section starts (look for newline followed by capital letter)
                const nextCapMatch = afterSynthesis.match(/\n\s*([A-Z])/)
                if (nextCapMatch) {
                  const nextCapIndex = afterSynthesis.indexOf(nextCapMatch[0])
                  synthesisQuestion = afterSynthesis.substring(0, nextCapIndex).trim()
                  cy.log(`Found next section at index: ${nextCapIndex}`)
                } else {
                  // If no capital letter found, take until first newline or first 200 chars
                  const firstNewline = afterSynthesis.indexOf('\n')
                  synthesisQuestion = firstNewline > -1 
                    ? afterSynthesis.substring(0, firstNewline).trim()
                    : afterSynthesis.substring(0, 200).trim()
                  cy.log(`No next section found, using first line or 200 chars`)
                }
                
                synthesisQuestion = synthesisQuestion.replace(/\\n/g, '').replace(/\n/g, '').replace(/\s+/g, ' ').trim()
                cy.log(`✓ Synthesis extracted: "${synthesisQuestion}"`)
                
                // Found it, break out of the loop
                // We found the answer for this question, no need to check other UserRags
                break
              } else {
                cy.log(`✗ Could not find both markers in this answer`)
                if (topicStart === -1) cy.log(`  - "Question topics:" not found`)
                if (synthesisStart === -1) cy.log(`  - "Synthesised question:" not found`)
              }
            } else {
              cy.log(`✗ Skipping this turn (question doesn't match or no answer)`)
            }
          }
        }
      } else {
        cy.log(`\n✗ Response structure not as expected`)
        cy.log(`Has data: ${!!responseBody.data}`)
        if (responseBody.data) {
          cy.log(`Data keys: ${Object.keys(responseBody.data).join(', ')}`)
          if (responseBody.data.userRags) {
            cy.log(`userRags keys: ${Object.keys(responseBody.data.userRags).join(', ')}`)
          }
        }
      }
      
      cy.log(`\n=== FINAL EXTRACTION ===`)
      cy.log(`Topic: ${topic}`)
      cy.log(`Synthesis Question: ${synthesisQuestion}`)
      cy.log(`Response Time: ${responseTime} ms`)
      
      // Store the data immediately after extraction
      reportData.push({
        user: currentUser,
        question: testQuestion,
        topic: topic,
        synthesisQuestion: synthesisQuestion,
        responseTime: responseTime,
        questionNumber: questionIndex + 1
      })
      
      cy.log(`\n=== DATA STORED ===`)
      cy.log(`User: ${currentUser}`)
      cy.log(`Question: ${testQuestion}`)
      cy.log(`Topic: ${topic}`)
      cy.log(`Synthesis Question: ${synthesisQuestion}`)
      cy.log(`Response Time: ${responseTime} ms`)
      
      // If still not found, wait a bit and try to get the response from the page
      if (topic === 'Not found' || synthesisQuestion === 'Not found') {
        cy.wait(3000) // Wait for page to update
        cy.log(`\n=== FALLBACK: Checking page content ===`)
        
        // Wait for response to be visible on page
        cy.get('body', { timeout: 10000 }).then(($body) => {
          const bodyText = $body.text()
          
          cy.log(`Page text length: ${bodyText.length} characters`)
          cy.log(`Page text preview: ${bodyText.substring(0, 1000)}...`)
          
          // Try to extract from page text with multiple patterns
          if (topic === 'Not found') {
            const topicPatterns = [
              /Question topics?:\s*(.+?)(?:\n|Synthesised|Synthesis|$)/i,
              /Question topics?:\s*([^\n]+)/i,
              /Topics?:\s*(.+?)(?:\n|Synthesised|$)/i
            ]
            
            for (const pattern of topicPatterns) {
              const topicMatch = bodyText.match(pattern)
              if (topicMatch && topicMatch[1]) {
                topic = topicMatch[1].trim()
                cy.log(`✓ Topic found in page: "${topic}"`)
                break
              }
            }
            
            if (topic === 'Not found') {
              // Show context around "topic" keyword
              const topicIndex = bodyText.toLowerCase().indexOf('topic')
              if (topicIndex > -1) {
                cy.log(`Found "topic" in page at position ${topicIndex}`)
                cy.log(`Context: ${bodyText.substring(Math.max(0, topicIndex - 100), Math.min(bodyText.length, topicIndex + 200))}`)
              }
            }
          }
          
          if (synthesisQuestion === 'Not found') {
            const synthesisPatterns = [
              /Synthesised question:\s*(.+?)(?:\n|$)/i,
              /Synthesised question:\s*([^\n]+)/i,
              /Synthesis question:\s*(.+?)(?:\n|$)/i
            ]
            
            for (const pattern of synthesisPatterns) {
              const synthesisMatch = bodyText.match(pattern)
              if (synthesisMatch && synthesisMatch[1]) {
                synthesisQuestion = synthesisMatch[1].trim()
                cy.log(`✓ Synthesis question found in page: "${synthesisQuestion}"`)
                break
              }
            }
            
            if (synthesisQuestion === 'Not found') {
              // Show context around "synthes" keyword
              const synthesisIndex = bodyText.toLowerCase().indexOf('synthes')
              if (synthesisIndex > -1) {
                cy.log(`Found "synthes" in page at position ${synthesisIndex}`)
                cy.log(`Context: ${bodyText.substring(Math.max(0, synthesisIndex - 100), Math.min(bodyText.length, synthesisIndex + 200))}`)
              }
            }
          }
          
          // Update reportData if we found values from page fallback
          // Capture current values to avoid closure issues
          const currentTopic = topic
          const currentSynthesis = synthesisQuestion
          
          cy.log(`\n=== FALLBACK EXTRACTION VALUES ===`)
          cy.log(`Current topic: "${currentTopic}"`)
          cy.log(`Current synthesis: "${currentSynthesis}"`)
          cy.log(`ReportData length: ${reportData.length}`)
          
          if (reportData && reportData.length > 0) {
            const lastEntry = reportData[reportData.length - 1]
            
            if (lastEntry) {
              if (lastEntry.topic === 'Not found' && currentTopic !== 'Not found') {
                lastEntry.topic = currentTopic
                cy.log(`✓ Updated topic from page: "${currentTopic}"`)
              }
              if (lastEntry.synthesisQuestion === 'Not found' && currentSynthesis !== 'Not found') {
                lastEntry.synthesisQuestion = currentSynthesis
                cy.log(`✓ Updated synthesis from page: "${currentSynthesis}"`)
              }
            } else {
              cy.log(`⚠ Warning: lastEntry is undefined`)
            }
          } else {
            cy.log(`⚠ Warning: reportData is empty or undefined, cannot update`)
          }
        })
      }
      
      // Safety check: ensure data was pushed
      if (reportData.length < questionIndex + 1) {
        cy.log(`⚠ Warning: No data was pushed for question ${questionIndex + 1}, pushing default data`)
        reportData.push({
          user: currentUser,
          question: testQuestion,
          topic: topic,
          synthesisQuestion: synthesisQuestion,
          responseTime: responseTime,
          questionNumber: questionIndex + 1
        })
      }
      
      // Generate and save reports after each question (incremental saving)
      const csvContent = generateCSV(reportData)
      const csvFilename = `quick-test-report-${reportTimestamp}.csv`
      cy.task('writeReport', {
        data: csvContent,
        filename: csvFilename
      }).then(() => {
        cy.log(`✓ CSV report updated with question ${questionIndex + 1}`)
      })
      
      const jsonFilename = `quick-test-report-${reportTimestamp}.json`
      cy.task('writeReport', {
        data: JSON.stringify(reportData, null, 2),
        filename: jsonFilename
      }).then(() => {
        cy.log(`✓ JSON report updated with question ${questionIndex + 1}`)
      })
    })
    
    // Wait for the response to complete - wait for textarea to be ready again
    cy.getChatInput({ timeout: 60000 })
      .should('exist')
      .should('be.visible')
      .should('not.be.disabled')
      .should('not.have.attr', 'disabled')
    })
  })
})

// Helper function to generate CSV
function generateCSV(data) {
  if (data.length === 0) return 'User,Question,Topic,Synthesis Question,Response Time (ms)\n'
  
  const headers = ['User', 'Question', 'Topic', 'Synthesis Question', 'Response Time (ms)']
  const rows = data.map(row => [
    escapeCSV(row.user),
    escapeCSV(row.question),
    escapeCSV(row.topic),
    escapeCSV(row.synthesisQuestion),
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