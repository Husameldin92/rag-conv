const { defineConfig } = require('cypress')
const fs = require('fs')
const path = require('path')

// Override with: CYPRESS_BASE_URL=https://entwickler.de npx cypress run ...
const baseUrl = process.env.CYPRESS_BASE_URL || 'https://entwickler.de'

module.exports = defineConfig({
  e2e: {
    // Forward shell `CYPRESS_PERF_*` into the browser bundle (`Cypress.env('PERF_*')`).
    env: {
      PERF_DEBUG: process.env.CYPRESS_PERF_DEBUG,
      PERF_TIMING_DEBUG: process.env.CYPRESS_PERF_TIMING_DEBUG,
      PERF_QUESTION: process.env.CYPRESS_PERF_QUESTION,
      PERF_REPEAT_COUNT: process.env.CYPRESS_PERF_REPEAT_COUNT,
      PERF_SAME_CHAT: process.env.CYPRESS_PERF_SAME_CHAT,
      PERF_NEW_CHAT_PAGE_RELOAD: process.env.CYPRESS_PERF_NEW_CHAT_PAGE_RELOAD,
      PERF_PANEL_TIMEOUT: process.env.CYPRESS_PERF_PANEL_TIMEOUT,
      PERF_SCROLL_STEP_PX: process.env.CYPRESS_PERF_SCROLL_STEP_PX,
      PERF_VIEWPORT: process.env.CYPRESS_PERF_VIEWPORT,
      PERF_ALLOW_INCREMENTAL_TIMING: process.env.CYPRESS_PERF_ALLOW_INCREMENTAL_TIMING
    },

    defaultCommandTimeout: 120000,
    requestTimeout: 120000,
    responseTimeout: 120000,
    taskTimeout: 120000,
    pageLoadTimeout: 120000,
    watchForFileChanges: false,
    setupNodeEvents(on, config) {
      // Task to write report files (runs in Node.js context)
      on('task', {
        writeReport({ data, filename }) {
          const reportsDir = path.join(__dirname, 'cypress/reports')
          if (!fs.existsSync(reportsDir)) {
            fs.mkdirSync(reportsDir, { recursive: true })
          }

          const filePath = path.join(reportsDir, filename)
          fs.writeFileSync(filePath, data, 'utf8')
          // Visible in the terminal that launched Cypress (open / run)
          console.log(`[writeReport] ${filePath}`)
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
    baseUrl,
    specPattern: 'cypress/e2e/**/*.cy.{js,jsx,ts,tsx}',
    supportFile: 'cypress/support/e2e.js',
    
    testIsolation: false,
    screenshotOnRunFailure: true,
    screenshotsFolder: 'cypress/screenshots',
    // Video recording settings - enabled by default but explicitly set here
    video: true, // Enable video recording for all tests
    videoCompression: 32, // Compression quality (0-51, lower = better quality but larger files)
    videosFolder: 'cypress/videos', // Where to save videos
  },
})
