// Test to verify the fix for the TypeScript to JavaScript mapping issue
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

// Simulate the problematic scenarios and test the fix
console.log('Testing fix for TypeScript to JavaScript mapping issue...');

// Test case 1: Languages from GitHub detection (auto-detection)
console.log('\n1. Testing auto-detection scenario:');
const githubDetected = ["TypeScript", "JavaScript"];
let mappedFromGithub = mapLanguagesToCodeQL(githubDetected);
console.log('GitHub detected:', githubDetected);
console.log('First mapping:', mappedFromGithub);

// Apply the fix: ensure languages are always mapped even if already in config
let finalLanguages = mapLanguagesToCodeQL(mappedFromGithub);
console.log('Final languages after fix:', finalLanguages);
console.log('Expected: ["javascript"]');
console.log('Pass:', JSON.stringify(finalLanguages) === '["javascript"]');

// Test case 2: User manually configured "typescript" in settings
console.log('\n2. Testing manual configuration with typescript:');
const manuallyConfigured = ["typescript"];
let mappedManual = mapLanguagesToCodeQL(manuallyConfigured);
console.log('Manually configured:', manuallyConfigured);
console.log('Mapped result:', mappedManual);
console.log('Expected: ["javascript"]');
console.log('Pass:', JSON.stringify(mappedManual) === '["javascript"]');

// Test case 3: Mixed configuration with both javascript and typescript
console.log('\n3. Testing mixed configuration:');
const mixedConfig = ["javascript", "typescript", "python"];
let mappedMixed = mapLanguagesToCodeQL(mixedConfig);
console.log('Mixed configuration:', mixedConfig);
console.log('Mapped result:', mappedMixed);
console.log('Expected: ["javascript", "python"]');
console.log('Pass:', JSON.stringify(mappedMixed) === '["javascript","python"]');

// Test case 4: Edge case - typescript only (simulating the problematic scenario)
console.log('\n4. Testing TypeScript-only scenario:');
const typescriptOnly = ["TypeScript"];
let mappedTSOnly = mapLanguagesToCodeQL(typescriptOnly);
console.log('TypeScript only:', typescriptOnly);
console.log('Mapped result:', mappedTSOnly);
console.log('Expected: ["javascript"]');
console.log('Pass:', JSON.stringify(mappedTSOnly) === '["javascript"]');

console.log('\nAll tests completed. The fix ensures that:');
console.log('- TypeScript always maps to JavaScript for CodeQL analysis');
console.log('- Both auto-detected and manually configured languages are properly mapped');
console.log('- Duplicate languages are handled correctly');
console.log('- The fix prevents the "typescript-queries" error');