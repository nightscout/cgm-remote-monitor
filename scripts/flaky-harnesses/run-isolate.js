#!/usr/bin/env node

'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const TEST_FILE = process.env.TEST;
if (!TEST_FILE) {
  console.error('Error: TEST environment variable is required');
  console.error('Usage: TEST=api.entries npm run test:flaky:isolate');
  console.error('       TEST=api3.socket npm run test:flaky:isolate');
  process.exit(1);
}

const testPath = TEST_FILE.includes('.test.js') 
  ? `tests/${TEST_FILE}` 
  : `tests/${TEST_FILE}.test.js`;

if (!fs.existsSync(testPath)) {
  console.error(`Error: Test file not found: ${testPath}`);
  process.exit(1);
}

const CONFIG = {
  testFile: testPath,
  iterations: parseInt(process.env.FLAKY_ITERATIONS, 10) || 10,
  timeout: parseInt(process.env.FLAKY_TEST_TIMEOUT, 10) || 60000,
  outputDir: process.env.FLAKY_OUTPUT_DIR || './flaky-test-results',
  testEnvFile: process.env.FLAKY_TEST_ENV_FILE || './my.test.env'
};

const results = [];

function loadEnv() {
  const env = { ...process.env };
  if (fs.existsSync(CONFIG.testEnvFile)) {
    const content = fs.readFileSync(CONFIG.testEnvFile, 'utf8');
    content.split('\n').forEach(line => {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#')) {
        const eqIndex = trimmed.indexOf('=');
        if (eqIndex > 0) {
          env[trimmed.substring(0, eqIndex)] = trimmed.substring(eqIndex + 1);
        }
      }
    });
  }
  return env;
}

function runTest(iteration) {
  return new Promise((resolve) => {
    console.log(`\n--- Iteration ${iteration + 1}/${CONFIG.iterations} ---`);
    const startTime = Date.now();
    
    const mochaPath = path.join(process.cwd(), 'node_modules', '.bin', 'mocha');
    const args = [
      '--timeout', '30000',
      '--require', './tests/hooks.js',
      '--exit',
      CONFIG.testFile
    ];
    
    let stdout = '';
    let stderr = '';
    
    const testProcess = spawn(mochaPath, args, {
      cwd: process.cwd(),
      env: loadEnv(),
      shell: false
    });
    
    testProcess.stdout.on('data', data => {
      stdout += data.toString();
      process.stdout.write(data);
    });
    
    testProcess.stderr.on('data', data => {
      stderr += data.toString();
      process.stderr.write(data);
    });
    
    const timeoutId = setTimeout(() => {
      testProcess.kill('SIGTERM');
      resolve({
        iteration: iteration + 1,
        success: false,
        duration: Date.now() - startTime,
        error: 'Timeout'
      });
    }, CONFIG.timeout);
    
    testProcess.on('close', (code) => {
      clearTimeout(timeoutId);
      const duration = Date.now() - startTime;
      
      const passingMatch = stdout.match(/(\d+) passing/);
      const failingMatch = stdout.match(/(\d+) failing/);
      
      resolve({
        iteration: iteration + 1,
        success: code === 0,
        duration,
        exitCode: code,
        passing: passingMatch ? parseInt(passingMatch[1], 10) : 0,
        failing: failingMatch ? parseInt(failingMatch[1], 10) : 0,
        error: code !== 0 ? stderr.substring(0, 500) : null
      });
    });
  });
}

async function main() {
  console.log(`Flaky Test Isolation Harness: ${CONFIG.testFile}`);
  console.log('='.repeat(50));
  console.log(`Iterations: ${CONFIG.iterations}`);
  console.log(`Timeout: ${CONFIG.timeout}ms`);
  console.log('='.repeat(50));
  
  for (let i = 0; i < CONFIG.iterations; i++) {
    const result = await runTest(i);
    results.push(result);
    console.log(`Result: ${result.success ? 'PASS' : 'FAIL'} (${result.duration}ms)`);
  }
  
  const passed = results.filter(r => r.success).length;
  const failed = results.filter(r => !r.success).length;
  const passRate = ((passed / CONFIG.iterations) * 100).toFixed(1);
  
  console.log('\n' + '='.repeat(50));
  console.log('SUMMARY');
  console.log('='.repeat(50));
  console.log(`Test file: ${CONFIG.testFile}`);
  console.log(`Total iterations: ${CONFIG.iterations}`);
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);
  console.log(`Pass rate: ${passRate}%`);
  
  if (failed > 0) {
    console.log('\nFailed iterations:');
    results.filter(r => !r.success).forEach(r => {
      console.log(`  - Iteration ${r.iteration}: ${r.error || 'Unknown error'}`);
    });
    console.log('\nThis test is FLAKY');
  } else {
    console.log('\nNo failures detected - test appears stable');
  }
  
  if (!fs.existsSync(CONFIG.outputDir)) {
    fs.mkdirSync(CONFIG.outputDir, { recursive: true });
  }
  
  const baseName = path.basename(CONFIG.testFile, '.test.js');
  const reportPath = path.join(CONFIG.outputDir, `${baseName}-isolation-results.json`);
  fs.writeFileSync(reportPath, JSON.stringify({
    testFile: CONFIG.testFile,
    iterations: CONFIG.iterations,
    passed,
    failed,
    passRate,
    results
  }, null, 2));
  
  console.log(`\nResults saved to: ${reportPath}`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
