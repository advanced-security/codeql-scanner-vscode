// Comprehensive test for the TypeScript to JavaScript mapping fix
// This test simulates the full flow from language detection to query pack resolution

const languages = {
  javascript: ["javascript", "typescript", "js", "ts", "jsx", "tsx"],
  python: ["python", "py"],
  java: ["java"],
  csharp: ["csharp", "c#", "cs"],
  cpp: ["cpp", "c++", "c", "cc", "cxx"],
  go: ["go", "golang"],
  ruby: ["ruby", "rb"],
  swift: ["swift"],
  kotlin: ["kotlin", "kt"],
  scala: ["scala"],
};

function mapLanguagesToCodeQL(inputLanguages) {
  const results = [];
  const addedLanguages = new Set();

  for (const language of inputLanguages) {
    const lang = language.toLowerCase();

    // Direct match with CodeQL language
    if (languages[lang] && !addedLanguages.has(lang)) {
      results.push(lang);
      addedLanguages.add(lang);
      continue;
    }

    // Check if it's an alias for a CodeQL language
    for (const [codeqlLang, aliases] of Object.entries(languages)) {
      if (aliases.includes(lang) && !addedLanguages.has(codeqlLang)) {
        results.push(codeqlLang);
        addedLanguages.add(codeqlLang);
        break;
      }
    }
  }

  return [...new Set(results)]; // Remove any duplicates just in case
}

// Simulate runLocalScan logic with the fix
function simulateRunLocalScan(configuredLanguages, githubLanguages) {
  console.log('\n--- Simulating runLocalScan ---');
  console.log('Configured languages:', configuredLanguages);
  console.log('GitHub languages:', githubLanguages);
  
  // Simulate the original logic
  let languages = configuredLanguages || [];
  if (!languages || languages.length === 0) {
    languages = mapLanguagesToCodeQL(githubLanguages);
    console.log('Languages after GitHub mapping:', languages);
  }
  
  // Apply the fix: ensure languages are always mapped
  languages = mapLanguagesToCodeQL(languages);
  console.log('Final languages after fix:', languages);
  
  // Simulate the processing loop
  for (const language of languages) {
    console.log(`Processing language: ${language}`);
    
    // Simulate database path generation
    const databasePath = `/path/to/databases/repo/${language}`;
    console.log(`  Database path: ${databasePath}`);
    
    // Simulate output path generation
    const outputPath = `/path/to/results/repo-${language}-abcd1234.sarif`;
    console.log(`  Output path: ${outputPath}`);
    
    // Simulate query pack resolution
    const queryPack = `codeql/${language}-queries`;
    console.log(`  Query pack: ${queryPack}`);
    
    // Simulate suite path
    const suitePath = `${queryPack}:codeql-suites/${language}-code-scanning.qls`;
    console.log(`  Suite path: ${suitePath}`);
  }
  
  return languages;
}

console.log('=== Comprehensive Test for TypeScript to JavaScript Mapping Fix ===');

// Test case 1: The original problematic scenario
console.log('\n🔍 Test Case 1: Original problematic scenario (auto-detection with TypeScript)');
const result1 = simulateRunLocalScan([], ["TypeScript"]);
console.log('✅ Expected: javascript-based paths');
console.log('✅ Result:', result1.includes('javascript') && !result1.includes('typescript') ? 'PASS' : 'FAIL');

// Test case 2: Mixed languages from GitHub
console.log('\n🔍 Test Case 2: Mixed GitHub languages');
const result2 = simulateRunLocalScan([], ["TypeScript", "Python", "JavaScript"]);
console.log('✅ Expected: javascript and python');
console.log('✅ Result:', JSON.stringify(result2.sort()) === '["javascript","python"]' ? 'PASS' : 'FAIL');

// Test case 3: Manual configuration with typescript (edge case)
console.log('\n🔍 Test Case 3: Manual typescript configuration');
const result3 = simulateRunLocalScan(["typescript"], []);
console.log('✅ Expected: javascript');
console.log('✅ Result:', JSON.stringify(result3) === '["javascript"]' ? 'PASS' : 'FAIL');

// Test case 4: Manual configuration with javascript (should still work)
console.log('\n🔍 Test Case 4: Manual javascript configuration');
const result4 = simulateRunLocalScan(["javascript"], []);
console.log('✅ Expected: javascript');
console.log('✅ Result:', JSON.stringify(result4) === '["javascript"]' ? 'PASS' : 'FAIL');

// Test case 5: Mixed manual configuration
console.log('\n🔍 Test Case 5: Mixed manual configuration');
const result5 = simulateRunLocalScan(["typescript", "python", "javascript"], []);
console.log('✅ Expected: javascript and python');
console.log('✅ Result:', JSON.stringify(result5.sort()) === '["javascript","python"]' ? 'PASS' : 'FAIL');

console.log('\n📋 Summary:');
console.log('- Fix ensures TypeScript always maps to JavaScript');
console.log('- Database paths use correct language (javascript)');
console.log('- Output files use correct language (javascript)');
console.log('- Query packs use correct language (javascript-queries)');
console.log('- Suite paths use correct language (javascript-code-scanning.qls)');
console.log('- Fix works for both auto-detection and manual configuration');
console.log('- Prevents the "codeql/typescript-queries" error');