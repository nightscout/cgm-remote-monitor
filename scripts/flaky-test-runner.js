#!/usr/bin/env node

'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const CONFIG = {
  iterations: parseInt(process.env.FLAKY_TEST_ITERATIONS, 10) || 10,
  timeout: parseInt(process.env.FLAKY_TEST_TIMEOUT, 10) || 300000,
  outputDir: process.env.FLAKY_OUTPUT_DIR || './flaky-test-results',
  testEnvFile: process.env.FLAKY_TEST_ENV_FILE || './my.test.env'
};

const testResults = new Map();
const runSummaries = [];

function parseTestName(fullTitle) {
  return fullTitle.trim();
}

function extractTestsFromJson(jsonData) {
  const tests = [];
  
  if (jsonData.passes) {
    jsonData.passes.forEach(test => {
      tests.push({
        fullTitle: test.fullTitle,
        state: 'passed',
        duration: test.duration,
        error: null
      });
    });
  }
  
  if (jsonData.failures) {
    jsonData.failures.forEach(test => {
      tests.push({
        fullTitle: test.fullTitle,
        state: 'failed',
        duration: test.duration,
        error: test.err ? (test.err.message || test.err.toString()) : 'Unknown error'
      });
    });
  }
  
  if (jsonData.pending) {
    jsonData.pending.forEach(test => {
      tests.push({
        fullTitle: test.fullTitle,
        state: 'pending',
        duration: 0,
        error: null
      });
    });
  }
  
  return { tests, stats: jsonData.stats };
}

function parseJsonContent(content) {
  const trimmed = content.trim();
  
  if (!trimmed) {
    return { tests: [], stats: null, error: 'JSON output is empty' };
  }
  
  if (!trimmed.startsWith('{')) {
    const jsonStart = trimmed.indexOf('{');
    if (jsonStart === -1) {
      return { tests: [], stats: null, error: 'No JSON object found in output' };
    }
    const jsonContent = trimmed.substring(jsonStart);
    return parseJsonContent(jsonContent);
  }
  
  try {
    const jsonData = JSON.parse(trimmed);
    
    if (!jsonData || !jsonData.stats) {
      return { tests: [], stats: null, error: 'Invalid JSON structure - missing stats field' };
    }
    
    const result = extractTestsFromJson(jsonData);
    return { ...result, error: null };
  } catch (e) {
    const lastBrace = trimmed.lastIndexOf('}');
    if (lastBrace > 0 && lastBrace < trimmed.length - 1) {
      const cleanedJson = trimmed.substring(0, lastBrace + 1);
      try {
        const jsonData = JSON.parse(cleanedJson);
        if (jsonData && jsonData.stats) {
          const result = extractTestsFromJson(jsonData);
          return { ...result, error: null };
        }
      } catch (e2) {
      }
    }
    
    return { tests: [], stats: null, error: `JSON parse error: ${e.message}` };
  }
}

function runTests(iteration) {
  return new Promise((resolve, reject) => {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`Running test iteration ${iteration + 1}/${CONFIG.iterations}`);
    console.log(`${'='.repeat(60)}\n`);
    
    const startTime = Date.now();
    let stdout = '';
    let stderr = '';
    
    if (!fs.existsSync(CONFIG.outputDir)) {
      fs.mkdirSync(CONFIG.outputDir, { recursive: true });
    }
    
    const jsonOutputPath = path.join(CONFIG.outputDir, `iteration-${iteration + 1}-results.json`);
    
    if (fs.existsSync(jsonOutputPath)) {
      fs.unlinkSync(jsonOutputPath);
    }
    
    const mochaPath = path.join(process.cwd(), 'node_modules', '.bin', 'mocha');
    const testsGlob = './tests/*.test.js';
    const hooksPath = './tests/hooks.js';
    
    const args = [
      '--timeout', '10000',
      '--require', hooksPath,
      '--exit',
      '--reporter', 'json',
      testsGlob
    ];
    
    console.log(`Running: mocha --reporter json [tests]`);
    console.log(`JSON output will be captured to: ${jsonOutputPath}`);
    
    const env = { ...process.env };
    
    if (fs.existsSync(CONFIG.testEnvFile)) {
      const envContent = fs.readFileSync(CONFIG.testEnvFile, 'utf8');
      envContent.split('\n').forEach(line => {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith('#')) {
          const eqIndex = trimmed.indexOf('=');
          if (eqIndex > 0) {
            const key = trimmed.substring(0, eqIndex);
            const value = trimmed.substring(eqIndex + 1);
            env[key] = value;
          }
        }
      });
    }
    
    const testProcess = spawn(mochaPath, args, {
      cwd: process.cwd(),
      env: env,
      shell: false
    });
    
    testProcess.stdout.on('data', (data) => {
      stdout += data.toString();
    });
    
    testProcess.stderr.on('data', (data) => {
      stderr += data.toString();
    });
    
    const timeoutId = setTimeout(() => {
      testProcess.kill('SIGTERM');
      reject(new Error(`Test run ${iteration + 1} timed out after ${CONFIG.timeout}ms`));
    }, CONFIG.timeout);
    
    testProcess.on('close', (code) => {
      clearTimeout(timeoutId);
      const duration = Date.now() - startTime;
      
      fs.writeFileSync(jsonOutputPath, stdout);
      
      const { tests, stats, error } = parseJsonContent(stdout);
      
      if (error) {
        console.error(`ERROR parsing iteration ${iteration + 1}: ${error}`);
        console.error(`Stdout length: ${stdout.length}, first 200 chars: ${stdout.substring(0, 200)}`);
        if (stderr) {
          console.error(`Stderr (first 300 chars): ${stderr.substring(0, 300)}`);
        }
      }
      
      resolve({
        iteration: iteration + 1,
        exitCode: code,
        duration,
        tests,
        stats,
        parseError: error,
        rawStderr: stderr,
        jsonOutputPath
      });
    });
    
    testProcess.on('error', (err) => {
      clearTimeout(timeoutId);
      reject(err);
    });
  });
}

function aggregateResults(runResult) {
  if (runResult.parseError) {
    runSummaries.push({
      iteration: runResult.iteration,
      exitCode: runResult.exitCode,
      duration: runResult.duration,
      passCount: 0,
      failCount: 0,
      pendingCount: 0,
      parseError: runResult.parseError
    });
    return;
  }
  
  runResult.tests.forEach(test => {
    const testName = parseTestName(test.fullTitle);
    
    if (!testResults.has(testName)) {
      testResults.set(testName, {
        fullTitle: testName,
        runs: [],
        passCount: 0,
        failCount: 0,
        pendingCount: 0,
        errors: []
      });
    }
    
    const testData = testResults.get(testName);
    testData.runs.push({
      iteration: runResult.iteration,
      state: test.state,
      duration: test.duration,
      error: test.error
    });
    
    if (test.state === 'passed') {
      testData.passCount++;
    } else if (test.state === 'failed') {
      testData.failCount++;
      if (test.error && !testData.errors.includes(test.error)) {
        testData.errors.push(test.error);
      }
    } else if (test.state === 'pending') {
      testData.pendingCount++;
    }
  });
  
  runSummaries.push({
    iteration: runResult.iteration,
    exitCode: runResult.exitCode,
    duration: runResult.duration,
    passCount: runResult.stats?.passes || runResult.tests.filter(t => t.state === 'passed').length,
    failCount: runResult.stats?.failures || runResult.tests.filter(t => t.state === 'failed').length,
    pendingCount: runResult.stats?.pending || runResult.tests.filter(t => t.state === 'pending').length,
    parseError: null
  });
}

function identifyFlakyTests() {
  const flaky = [];
  const consistent = [];
  const alwaysFailing = [];
  const alwaysPassing = [];
  
  testResults.forEach((data, testName) => {
    const totalRuns = data.passCount + data.failCount;
    
    if (totalRuns === 0) {
      return;
    }
    
    const passRate = data.passCount / totalRuns;
    const failRate = data.failCount / totalRuns;
    
    const testInfo = {
      name: testName,
      passCount: data.passCount,
      failCount: data.failCount,
      pendingCount: data.pendingCount,
      passRate: (passRate * 100).toFixed(1),
      failRate: (failRate * 100).toFixed(1),
      errors: data.errors.slice(0, 3)
    };
    
    if (passRate > 0 && passRate < 1) {
      flaky.push(testInfo);
    } else if (passRate === 1) {
      alwaysPassing.push(testInfo);
    } else if (failRate === 1) {
      alwaysFailing.push(testInfo);
    } else {
      consistent.push(testInfo);
    }
  });
  
  flaky.sort((a, b) => parseFloat(b.failRate) - parseFloat(a.failRate));
  
  return { flaky, consistent, alwaysFailing, alwaysPassing };
}

function generateReport(analysis, successfulIterations, failedIterations) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  
  if (!fs.existsSync(CONFIG.outputDir)) {
    fs.mkdirSync(CONFIG.outputDir, { recursive: true });
  }
  
  let report = `# Flaky Test Analysis Report\n\n`;
  report += `**Generated:** ${new Date().toISOString()}\n`;
  report += `**Total Iterations:** ${CONFIG.iterations}\n`;
  report += `**Successful Iterations:** ${successfulIterations}\n`;
  report += `**Failed Iterations:** ${failedIterations}\n`;
  report += `**Total Unique Tests:** ${testResults.size}\n\n`;
  
  if (failedIterations > 0) {
    report += `**WARNING:** ${failedIterations} iteration(s) failed to produce valid results - analysis is based on ${successfulIterations} successful runs.\n\n`;
  }
  
  report += `## Summary\n\n`;
  report += `| Metric | Count |\n`;
  report += `|--------|-------|\n`;
  report += `| Flaky Tests | ${analysis.flaky.length} |\n`;
  report += `| Always Passing | ${analysis.alwaysPassing.length} |\n`;
  report += `| Always Failing | ${analysis.alwaysFailing.length} |\n\n`;
  
  report += `## Run Summaries\n\n`;
  report += `| Iteration | Exit Code | Duration (ms) | Passed | Failed | Pending | Parse Error |\n`;
  report += `|-----------|-----------|---------------|--------|--------|---------|-------------|\n`;
  runSummaries.forEach(run => {
    const parseStatus = run.parseError ? 'Yes' : 'No';
    report += `| ${run.iteration} | ${run.exitCode} | ${run.duration} | ${run.passCount} | ${run.failCount} | ${run.pendingCount} | ${parseStatus} |\n`;
  });
  report += `\n`;
  
  if (analysis.flaky.length > 0) {
    report += `## Flaky Tests (${analysis.flaky.length})\n\n`;
    report += `These tests pass sometimes and fail other times - they need investigation:\n\n`;
    
    analysis.flaky.forEach((test, index) => {
      report += `### ${index + 1}. ${test.name}\n\n`;
      report += `- **Pass Rate:** ${test.passRate}% (${test.passCount}/${test.passCount + test.failCount} runs)\n`;
      report += `- **Fail Rate:** ${test.failRate}%\n`;
      
      if (test.errors.length > 0) {
        report += `- **Sample Errors:**\n`;
        test.errors.forEach(err => {
          report += `  - \`${err.substring(0, 200)}${err.length > 200 ? '...' : ''}\`\n`;
        });
      }
      report += `\n`;
    });
  } else {
    report += `## Flaky Tests\n\n`;
    report += `No flaky tests detected after ${successfulIterations} successful iterations.\n\n`;
  }
  
  if (analysis.alwaysFailing.length > 0) {
    report += `## Always Failing Tests (${analysis.alwaysFailing.length})\n\n`;
    report += `These tests failed on every run - they may have bugs or environmental issues:\n\n`;
    
    analysis.alwaysFailing.forEach((test, index) => {
      report += `${index + 1}. **${test.name}**\n`;
      if (test.errors.length > 0) {
        report += `   - Error: \`${test.errors[0].substring(0, 150)}${test.errors[0].length > 150 ? '...' : ''}\`\n`;
      }
    });
    report += `\n`;
  }
  
  report += `## Configuration Used\n\n`;
  report += `\`\`\`json\n${JSON.stringify(CONFIG, null, 2)}\n\`\`\`\n`;
  
  const reportPath = path.join(CONFIG.outputDir, `flaky-test-report-${timestamp}.md`);
  fs.writeFileSync(reportPath, report);
  console.log(`\nReport saved to: ${reportPath}`);
  
  const jsonData = {
    timestamp: new Date().toISOString(),
    config: CONFIG,
    successfulIterations,
    failedIterations,
    runSummaries,
    analysis,
    allTests: Array.from(testResults.entries()).map(([name, data]) => ({
      name,
      ...data
    }))
  };
  
  const jsonPath = path.join(CONFIG.outputDir, `flaky-test-data-${timestamp}.json`);
  fs.writeFileSync(jsonPath, JSON.stringify(jsonData, null, 2));
  console.log(`JSON data saved to: ${jsonPath}`);
  
  return { reportPath, jsonPath, report };
}

function printSummary(analysis, successfulIterations, failedIterations) {
  console.log(`\n${'='.repeat(60)}`);
  console.log('FLAKY TEST ANALYSIS COMPLETE');
  console.log(`${'='.repeat(60)}\n`);
  
  console.log(`Total iterations attempted: ${CONFIG.iterations}`);
  console.log(`Successful iterations: ${successfulIterations}`);
  console.log(`Failed iterations: ${failedIterations}`);
  console.log(`Total unique tests: ${testResults.size}`);
  
  if (failedIterations > 0) {
    console.log(`\nWARNING: ${failedIterations} iteration(s) failed to produce valid JSON output`);
  }
  
  console.log(`\nResults (based on ${successfulIterations} successful runs):`);
  console.log(`  - Flaky tests: ${analysis.flaky.length}`);
  console.log(`  - Always passing: ${analysis.alwaysPassing.length}`);
  console.log(`  - Always failing: ${analysis.alwaysFailing.length}`);
  
  if (analysis.flaky.length > 0) {
    console.log(`\n${'!'.repeat(60)}`);
    console.log('FLAKY TESTS DETECTED:');
    console.log(`${'!'.repeat(60)}`);
    
    analysis.flaky.forEach((test, i) => {
      console.log(`\n${i + 1}. ${test.name}`);
      console.log(`   Pass rate: ${test.passRate}% | Fail rate: ${test.failRate}%`);
    });
  } else {
    console.log(`\nNo flaky tests detected.`);
  }
}

async function main() {
  console.log('Flaky Test Runner');
  console.log(`${'='.repeat(60)}`);
  console.log(`Configuration:`);
  console.log(`  - Iterations: ${CONFIG.iterations}`);
  console.log(`  - Timeout per run: ${CONFIG.timeout}ms`);
  console.log(`  - Output directory: ${CONFIG.outputDir}`);
  console.log(`  - Test env file: ${CONFIG.testEnvFile}`);
  console.log(`${'='.repeat(60)}\n`);
  
  const startTime = Date.now();
  let successfulIterations = 0;
  let failedIterations = 0;
  
  for (let i = 0; i < CONFIG.iterations; i++) {
    try {
      const result = await runTests(i);
      aggregateResults(result);
      
      if (result.parseError) {
        failedIterations++;
        console.log(`Iteration ${i + 1} FAILED: ${result.parseError}`);
      } else {
        successfulIterations++;
        console.log(`Iteration ${i + 1} complete: ${result.tests.length} tests, exit code ${result.exitCode}`);
        
        if (result.stats) {
          console.log(`  Passed: ${result.stats.passes}, Failed: ${result.stats.failures}, Pending: ${result.stats.pending}`);
        }
      }
    } catch (error) {
      console.error(`Error in iteration ${i + 1}:`, error.message);
      failedIterations++;
      runSummaries.push({
        iteration: i + 1,
        exitCode: -1,
        duration: 0,
        passCount: 0,
        failCount: 0,
        pendingCount: 0,
        parseError: error.message
      });
    }
  }
  
  const totalDuration = Date.now() - startTime;
  console.log(`\nTotal run time: ${(totalDuration / 1000 / 60).toFixed(2)} minutes`);
  
  if (successfulIterations === 0) {
    console.error('\nERROR: All iterations failed to produce valid test results.');
    console.error('Please check that Mocha and the test environment are configured correctly.');
    process.exit(2);
  }
  
  if (testResults.size === 0) {
    console.error('\nERROR: No test results were collected despite successful iterations.');
    process.exit(2);
  }
  
  const analysis = identifyFlakyTests();
  const { reportPath } = generateReport(analysis, successfulIterations, failedIterations);
  printSummary(analysis, successfulIterations, failedIterations);
  
  console.log(`\nFull report available at: ${reportPath}`);
  console.log(`Individual iteration results saved in: ${CONFIG.outputDir}/`);
  
  process.exit(analysis.flaky.length > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
