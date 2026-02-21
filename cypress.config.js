const { defineConfig } = require('cypress')
const fs = require('fs')
const path = require('path')

module.exports = defineConfig({
  e2e: {
    setupNodeEvents(on, config) {
      // Task to write report files (runs in Node.js context)
      on('task', {
        writeReport({ data, filename }) {
          const reportsDir = path.join(__dirname, 'cypress/reports')
          if (!fs.existsSync(reportsDir)) {
            fs.mkdirSync(reportsDir, { recursive: true })
          }
          
          const filePath = path.join(reportsDir, filename)
          fs.writeFileSync(filePath, data)
          return null
        },
        writeDebug({ data, filename }) {
          const debugDir = path.join(__dirname, 'cypress/debug')
          if (!fs.existsSync(debugDir)) {
            fs.mkdirSync(debugDir, { recursive: true })
          }
          
          const filePath = path.join(debugDir, filename)
          fs.writeFileSync(filePath, data)
          return null
        }
      })
    },
    baseUrl: 'https://staging.entwickler.de', // Update with your staging URL
    specPattern: 'cypress/e2e/**/*.cy.{js,jsx,ts,tsx}',
    supportFile: 'cypress/support/e2e.js',
    // Prevent Cypress from clearing the page between tests
    testIsolation: false,
  },
})
